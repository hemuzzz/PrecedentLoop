import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { z } from "zod";
import { assetIdSchema, assetTypeSchema, type AssetFrontmatter } from "./schema.js";
import { computeContentHash, loadWorkspaceConfig, type ScannedAsset } from "./scanner.js";
import { AssetContentVersionRepository } from "./content-version.js";
import { CandidateRepository, type CandidateRecord, type OperationReceipt } from "./candidate-repository.js";
import { assertAssetsWritable, assetIsFrozen, configureRepositoryCoordination, freezeAssets, RepositoryOperationError, withRepositoryAccess } from "./coordination.js";
import { runFileTransaction, readBytes, type FileChange } from "./file-transaction.js";
import { AssetConfirmationError, assertConfiguration, assertExpectedContentHash, assertNoFormalIdConflict, requireEligibleInboxAsset,
  scanFormalAssets, scanInbox, targetPathForInboxPath, type AssetConfirmationInput, type AssetConfirmationOptions, type AssetConfirmationResult } from "./confirmation.js";
import { inboxDiagnostic, type InboxItem, type InboxResult } from "./inbox.js";

export const requestIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/u);
export const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const candidateTargetSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("GLOBAL") }).strict(),
  z.object({ scope: z.literal("WORKSPACE"), workspace: z.string().min(1).max(160) }).strict(),
]);
export type CandidateTarget = z.infer<typeof candidateTargetSchema>;
const unicodeText = z.string().trim().refine(value => !/[\u0000\uD800-\uDFFF]/u.test(value), "内容必须是有效文本");
export const contentFieldsSchema = z.object({ title: unicodeText.min(1).max(300), summary: unicodeText.min(1).max(4000), bodyMarkdown: unicodeText.min(1).max(256_000) }).strict();
export const prepareItemSchema = contentFieldsSchema.extend({ type: assetTypeSchema, target: candidateTargetSchema,
  existingAssetId: assetIdSchema.optional(), baselineHash: contentHashSchema.optional() }).strict()
  .refine(value => (value.existingAssetId === undefined) === (value.baselineHash === undefined), "修订必须同时提供 Asset ID 和正式基线 Hash");
export const candidateSelectionSchema = z.object({ requestId: requestIdSchema, candidateId: z.string().regex(/^[1-9][0-9]*$/u).max(20), assetId: assetIdSchema, candidateHash: contentHashSchema }).strict();
export const acceptCandidateSchema = candidateSelectionSchema.extend({ baselineHash: contentHashSchema.optional() }).strict();
export const deferCandidateSchema = candidateSelectionSchema.extend({ deferred: z.boolean() }).strict();
export const registerCandidateSchema = z.object({ requestId: requestIdSchema, relativePath: z.string().max(1000), candidateHash: contentHashSchema, baselineHash: contentHashSchema.optional() }).strict();
export type PrepareItem = z.infer<typeof prepareItemSchema>;
export type CandidateSelection = z.infer<typeof candidateSelectionSchema>;
export interface CandidateSummary { candidateId: string; assetId: string; contentHash: string; intent: "NEW" | "REVISION" }
export interface CandidateBatchResult { candidates: CandidateSummary[]; count: number; warnings: string[]; sourceResults: unknown[] }
export interface ManagedInboxItem extends InboxItem {
  candidateId?: string; intent?: "NEW" | "REVISION"; reviewBucket?: "PENDING" | "DEFERRED";
  baselineHash?: string | null; baselineMarkdown?: string; currentFormalHash?: string;
  problem?: string; frozen: boolean;
}

export class CandidateService {
  readonly #ids = new SnowflakeIdGenerator();
  constructor(readonly options: AssetConfirmationOptions) { assertConfiguration(options); }

  async initialize(): Promise<void> { await configureRepositoryCoordination(this.options.repositoryPath, this.options.databasePath); }

  async list(bucket?: "PENDING" | "DEFERRED"): Promise<InboxResult & { items: ManagedInboxItem[]; managed: boolean }> {
    return withRepositoryAccess(this.options.repositoryPath, async () => {
      const inbox = await scanInbox(this.options);
      const formal = await scanFormalAssets(this.options);
      const database = this.database(true);
      let records: CandidateRecord[] = [];
      let managed = true;
      try { records = new CandidateRepository(database).list(); }
      catch (error) { if (!(error instanceof RepositoryOperationError && error.code === "CANDIDATE_MIGRATION_REQUIRED")) throw error; managed = false; }
      finally { database.close(); }
      const diagnostics = inbox.diagnostics.map(d => inboxDiagnostic(d, this.options));
      const items: ManagedInboxItem[] = [];
      for (const asset of inbox.assets) {
        const row = records.find(record => record.relativePath === asset.relativePath && record.assetId === asset.frontmatter.id);
        const current = formal.assets.find(item => item.frontmatter.id === asset.frontmatter.id);
        if (current && row?.intent !== "REVISION") {
          diagnostics.push({ code: "DUPLICATE_ASSET_ID", message: "此文件与正式知识同 ID，需明确登记修订基线", relativePath: asset.relativePath, assetId: asset.frontmatter.id });
        }
        const item: ManagedInboxItem = { assetId: asset.frontmatter.id, contentHash: asset.contentHash, frontmatter: asset.frontmatter,
          modifiedAt: asset.modifiedAt, rawMarkdown: asset.markdown, relativePath: asset.relativePath, scope: asset.frontmatter.scope,
          summary: asset.frontmatter.summary, title: asset.frontmatter.title, type: asset.frontmatter.type,
          workspace: asset.frontmatter.scope === "WORKSPACE" ? asset.frontmatter.workspace : null,
          frozen: assetIsFrozen(this.options.repositoryPath, asset.frontmatter.id),
          ...(row ? { candidateId: row.candidateId, intent: row.intent, reviewBucket: row.reviewBucket, baselineHash: row.baselineHash } : {}),
          ...(current ? { currentFormalHash: current.contentHash, baselineMarkdown: current.markdown } : {}),
        };
        if (!row) item.problem = current ? "同 ID 文件尚未登记修订，请审阅正式内容后明确绑定基线" : "此候选尚未登记";
        else if (row.contentHash !== asset.contentHash) { item.problem = "候选在外部发生变化，请明确登记当前内容"; item.reviewBucket = "PENDING"; }
        else if (row.intent === "REVISION" && current?.contentHash !== row.baselineHash) item.problem = "正式基线已变化，不能直接接受";
        else if (row.intent === "NEW" && current) item.problem = "正式知识已有相同身份，不能作为新增接受";
        if (bucket && (item.reviewBucket ?? "PENDING") !== bucket) continue;
        items.push(item);
      }
      for (const record of records) if (!inbox.assets.some(asset => asset.relativePath === record.relativePath && asset.frontmatter.id === record.assetId)) diagnostics.push({ code: "FILE_READ_ERROR", message: "已登记候选文件缺失或不再符合资格，请检查原文件", relativePath: record.relativePath, assetId: record.assetId });
      return { items, diagnostics, managed };
    });
  }

  async operation(requestId: string): Promise<unknown | undefined> {
    return (await this.receipt(requestId))?.result;
  }

  async pendingCandidates(): Promise<Array<{ record: CandidateRecord; asset?: ScannedAsset; problem?: true }>> {
    return withRepositoryAccess(this.options.repositoryPath, async () => {
      const inbox = await scanInbox(this.options);
      const database = this.database(true);
      try {
        return new CandidateRepository(database).list()
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (BigInt(a.candidateId) > BigInt(b.candidateId) ? -1 : 1))
          .map(record => {
            const asset = inbox.assets.find(item => item.relativePath === record.relativePath);
            if (!asset || asset.frontmatter.id !== record.assetId || asset.contentHash !== record.contentHash) return { record, problem: true as const };
            return { record, asset };
          });
      } finally { database.close(); }
    });
  }

  async receipt(requestId: string): Promise<OperationReceipt | undefined> {
    requestIdSchema.parse(requestId);
    return withRepositoryAccess(this.options.repositoryPath, async () => {
      const database = this.database(true);
      try { return new CandidateRepository(database).receipt(requestId); } finally { database.close(); }
    });
  }

  async prepare(requestId: string, rawItems: unknown[], owner?: string, details: { warnings?: string[]; sourceResults?: unknown[]; requestInput?: unknown; operation?: "prepare" | "import" } = {}): Promise<CandidateBatchResult> {
    requestIdSchema.parse(requestId);
    const items = z.array(prepareItemSchema).max(32).parse(rawItems);
    await this.validateTargets(items.map(item => item.target));
    const operation = details.operation ?? (details.requestInput === undefined ? "prepare" : "import");
    return runFileTransaction({ ...this.options, requestId, operation, input: details.requestInput ?? { items, details } }, async database => {
      const repository = new CandidateRepository(database);
      const formal = await scanFormalAssets(this.options);
      const inbox = await scanInbox(this.options);
      const changes: FileChange[] = [];
      const pending: Array<Omit<CandidateRecord, "candidateId" | "createdAt" | "updatedAt" | "reviewBucket">> = [];
      const versions = new AssetContentVersionRepository(database);
      for (const item of items) {
        let frontmatter: AssetFrontmatter;
        let relativePath: string;
        if (item.existingAssetId) {
          assertAssetsWritable(this.options.repositoryPath, [item.existingAssetId], owner);
          const current = formal.assets.find(asset => asset.frontmatter.id === item.existingAssetId);
          if (!current || current.contentHash !== item.baselineHash || !matchesTarget(current.frontmatter, item.target) || current.frontmatter.type !== item.type) {
            throw new RepositoryOperationError("BASELINE_MISMATCH", "修订目标或正式基线已变化");
          }
          assertCurrent(versions, current, item.baselineHash!);
          frontmatter = { ...current.frontmatter, title: item.title, summary: item.summary };
          relativePath = `inbox/${current.relativePath.slice(7)}`;
        } else {
          const id = this.#ids.next("ast");
          frontmatter = { id, type: item.type, title: item.title, summary: item.summary, ...item.target };
          const directory = item.type === "MEMORY" ? "memories" : item.type === "DOCUMENT" ? "documents" : "skills";
          relativePath = `inbox/${item.target.scope === "GLOBAL" ? "global" : `workspaces/${item.target.workspace}`}/${directory}/${id}.md`;
        }
        if (repository.byAsset(frontmatter.id) || inbox.assets.some(asset => asset.frontmatter.id === frontmatter.id) || pending.some(row => row.assetId === frontmatter.id)) {
          throw new RepositoryOperationError("CANDIDATE_CONFLICT", "同一知识已有未处理候选");
        }
        const bytes = renderCandidate(frontmatter, item.bodyMarkdown);
        changes.push({ relativePath, before: null, after: bytes });
        pending.push({ assetId: frontmatter.id, relativePath, intent: item.existingAssetId ? "REVISION" : "NEW", contentHash: computeContentHash(bytes), baselineHash: item.baselineHash ?? null });
      }
      return { changes, verify: async () => {
        const currentInbox = await scanInbox(this.options);
        for (const row of pending) { const asset = requireEligibleInboxAsset(currentInbox, row.relativePath); if (asset.frontmatter.id !== row.assetId || asset.contentHash !== row.contentHash) throw new RepositoryOperationError("CONTENT_HASH_MISMATCH", "提交前候选资格已变化"); }
      }, apply: () => {
        const candidates = pending.map(row => summary(repository.insert(row)));
        return { candidates, count: candidates.length, warnings: details.warnings ?? [], sourceResults: details.sourceResults ?? [] };
      } };
    });
  }

  async register(rawInput: unknown): Promise<CandidateSummary> {
    const input = registerCandidateSchema.parse(rawInput);
    targetPathForInboxPath(input.relativePath);
    return runFileTransaction({ ...this.options, requestId: input.requestId, operation: "register", input }, async database => {
      const repository = new CandidateRepository(database);
      const asset = requireEligibleInboxAsset(await scanInbox(this.options), input.relativePath);
      if (asset.contentHash !== input.candidateHash) throw new RepositoryOperationError("CONTENT_HASH_MISMATCH", "候选内容已变化");
      assertAssetsWritable(this.options.repositoryPath, [asset.frontmatter.id]);
      const formal = (await scanFormalAssets(this.options)).assets.find(item => item.frontmatter.id === asset.frontmatter.id);
      if (formal) {
        if (!input.baselineHash || formal.relativePath !== targetPathForInboxPath(input.relativePath) || !sameKind(formal.frontmatter, asset.frontmatter)) throw new RepositoryOperationError("BASELINE_REQUIRED", "修订登记需要明确的当前基线与相同身份和路径");
        assertCurrent(new AssetContentVersionRepository(database), formal, input.baselineHash);
      } else if (input.baselineHash) throw new RepositoryOperationError("BASELINE_MISMATCH", "正式知识不存在");
      const existing = repository.byAsset(asset.frontmatter.id);
      if (existing && (existing.relativePath !== input.relativePath || existing.baselineHash !== (input.baselineHash ?? null))) throw new RepositoryOperationError("CANDIDATE_CONFLICT", "已登记的候选身份或基线不一致");
      return { changes: [{ relativePath: asset.relativePath, before: asset.rawContent, after: asset.rawContent }], apply: () => {
        if (existing) { repository.updateContent(existing.candidateId, existing.contentHash, asset.contentHash); return summary(repository.get(existing.candidateId)!); }
        return summary(repository.insert({ assetId: asset.frontmatter.id, relativePath: asset.relativePath, contentHash: asset.contentHash, intent: formal ? "REVISION" : "NEW", baselineHash: input.baselineHash ?? null }));
      } };
    });
  }

  async defer(rawInput: unknown): Promise<{ deferred: boolean }> {
    const input = deferCandidateSchema.parse(rawInput);
    return runFileTransaction({ ...this.options, requestId: input.requestId, operation: "defer", input }, async database => {
      const { asset } = await this.selected(database, input);
      return { changes: [{ relativePath: asset.relativePath, before: asset.rawContent, after: asset.rawContent }], apply: () => { new CandidateRepository(database).setDeferred(input.candidateId, input.deferred); return { deferred: input.deferred }; } };
    });
  }

  async reject(rawInput: unknown): Promise<{ deleted: true; candidateId: string }> {
    const input = candidateSelectionSchema.parse(rawInput);
    return runFileTransaction({ ...this.options, requestId: input.requestId, operation: "reject", input }, async database => {
      const { row, asset } = await this.selected(database, input);
      return { changes: [{ relativePath: row.relativePath, before: asset.rawContent, after: null }], apply: () => {
        new CandidateRepository(database).remove(row.candidateId); return { deleted: true as const, candidateId: row.candidateId };
      } };
    });
  }

  async accept(rawInput: unknown): Promise<AssetConfirmationResult> {
    const input = acceptCandidateSchema.parse(rawInput);
    return runFileTransaction({ ...this.options, requestId: input.requestId, operation: "accept", input }, async database => {
      const { row, asset } = await this.selected(database, input);
      if (row.baselineHash !== (input.baselineHash ?? null)) throw new RepositoryOperationError("BASELINE_MISMATCH", "接受请求与审阅基线不一致");
      return this.confirmation(database, asset, row.baselineHash ?? undefined, row.candidateId);
    });
  }

  async confirmPath(input: AssetConfirmationInput): Promise<AssetConfirmationResult> {
    targetPathForInboxPath(input.relativePath);
    assertExpectedContentHash(input.expectedContentHash, input.relativePath);
    if ((input.updateAssetId === undefined) !== (input.expectedBaselineHash === undefined)) throw new AssetConfirmationError("CONFIRM_INPUT_INVALID", "修订需要身份和正式基线");
    const { inputHash } = await import("./file-transaction.js");
    if (input.requestId !== undefined) requestIdSchema.parse(input.requestId);
    try { await this.initialize(); } catch (error) {
      // A missing repository root has no snapshot to confirm against.
      if (error instanceof Error && "code" in error && error.code === "ENOENT" && !existsSync(this.options.repositoryPath)) {
        throw new AssetConfirmationError("INBOX_SNAPSHOT_UNAVAILABLE", "知识库目录不存在，无法读取候选快照");
      }
      throw error;
    }
    return withRepositoryAccess(this.options.repositoryPath, async () => {
      const defaultId = `confirm:${inputHash(input)}`;
      // Explicit request IDs identify retries forever. For the path-only entry,
      // a newly present candidate is a new confirmation, even if A -> B -> A
      // happens to reuse an old pair of content hashes.
      const previous = input.requestId ? undefined : await this.receipt(defaultId);
      const requestId = input.requestId ?? (previous && await readBytes(this.options.repositoryPath, input.relativePath) !== null ? `${defaultId}:${randomUUID()}` : defaultId);
      return runFileTransaction({ ...this.options, requestId, operation: "confirm", input }, async database => {
      const asset = requireEligibleInboxAsset(await scanInbox(this.options), input.relativePath);
      if (asset.contentHash !== input.expectedContentHash) throw new AssetConfirmationError("CONTENT_HASH_MISMATCH", "候选内容已变化");
      if (input.updateAssetId && input.updateAssetId !== asset.frontmatter.id) throw new AssetConfirmationError("UPDATE_ASSET_INVALID", "修订身份不一致");
      assertAssetsWritable(this.options.repositoryPath, [asset.frontmatter.id]);
      const row = new CandidateRepository(database).byAsset(asset.frontmatter.id);
      if (row && (row.relativePath !== input.relativePath || row.contentHash !== input.expectedContentHash || row.baselineHash !== (input.expectedBaselineHash ?? null))) throw new AssetConfirmationError("BASELINE_MISMATCH", "候选登记信息不匹配");
      return this.confirmation(database, asset, input.expectedBaselineHash, row?.candidateId);
      });
    });
  }

  async rewrite(input: CandidateSelection, fields: z.infer<typeof contentFieldsSchema>, owner?: string, requestInput?: unknown): Promise<CandidateSummary & { changed: boolean }> {
    fields = contentFieldsSchema.parse(fields);
    return runFileTransaction({ ...this.options, requestId: input.requestId, operation: "rewrite", input: requestInput ?? { ...input, fields } }, async database => {
      const { row, asset } = await this.selected(database, input, owner);
      await this.validateRevision(database, row);
      const bytes = renderCandidate({ ...asset.frontmatter, title: fields.title, summary: fields.summary }, fields.bodyMarkdown);
      const hash = computeContentHash(bytes);
      return { changes: [{ relativePath: row.relativePath, before: asset.rawContent, after: bytes }], apply: () => {
        const repository = new CandidateRepository(database);
        repository.updateContent(row.candidateId, row.contentHash, hash);
        return { ...summary(repository.get(row.candidateId)!), changed: hash !== row.contentHash };
      } };
    });
  }

  async freezeRewrite(input: CandidateSelection, owner: string): Promise<{ candidate: ScannedAsset; baseline?: ScannedAsset }> {
    return withRepositoryAccess(this.options.repositoryPath, async () => {
      const database = this.database(true);
      try {
        const { row } = await this.selected(database, input);
        freezeAssets(this.options.repositoryPath, [row.assetId], owner);
        const { asset } = await this.selected(database, input, owner);
        const baseline = await this.validateRevision(database, row);
        return { candidate: asset, ...(baseline ? { baseline } : {}) };
      } finally { database.close(); }
    });
  }

  async freezeReferences(targets: CandidateTarget[], owner: string): Promise<{ references: ScannedAsset[]; limited: boolean }> {
    await this.validateTargets(targets);
    return withRepositoryAccess(this.options.repositoryPath, async () => {
      const all = (await scanFormalAssets(this.options)).assets.filter(asset => targets.some(target => matchesTarget(asset.frontmatter, target)));
      const selected: ScannedAsset[] = [];
      let size = 0;
      for (const asset of all) {
        if (selected.length >= 32 || size + asset.fileSize > 256_000) continue;
        selected.push(asset); size += asset.fileSize;
      }
      freezeAssets(this.options.repositoryPath, selected.map(asset => asset.frontmatter.id), owner);
      const database = this.database(true);
      try {
        const versions = new AssetContentVersionRepository(database);
        const fresh = await scanFormalAssets(this.options);
        const references = selected.map(asset => {
          const current = fresh.assets.find(item => item.frontmatter.id === asset.frontmatter.id);
          if (!current || current.contentHash !== asset.contentHash) throw new RepositoryOperationError("BASELINE_MISMATCH", "知识在读取前发生变化");
          assertCurrent(versions, current, current.contentHash);
          return current;
        });
        return { references, limited: references.length < all.length };
      } finally { database.close(); }
    });
  }

  async validateTargets(targets: CandidateTarget[]): Promise<void> {
    const config = await loadWorkspaceConfig(this.options.workspaceConfigPath);
    for (const target of targets) if (target.scope === "WORKSPACE" && !config.workspaces.some(workspace => workspace.name === target.workspace)) throw new RepositoryOperationError("TARGET_INVALID", "目标工作区未配置");
  }

  private async selected(database: Database.Database, input: CandidateSelection, owner?: string): Promise<{ row: CandidateRecord; asset: ScannedAsset }> {
    const row = new CandidateRepository(database).get(input.candidateId);
    if (!row || row.assetId !== input.assetId) throw new RepositoryOperationError("CANDIDATE_NOT_FOUND", "候选不存在或身份不一致");
    assertAssetsWritable(this.options.repositoryPath, [row.assetId], owner);
    const asset = requireEligibleInboxAsset(await scanInbox(this.options), row.relativePath);
    if (asset.frontmatter.id !== row.assetId || asset.contentHash !== input.candidateHash || row.contentHash !== input.candidateHash) throw new RepositoryOperationError("CONTENT_HASH_MISMATCH", "候选内容已变化，请重新查看");
    return { row, asset };
  }

  private async validateRevision(database: Database.Database, row: CandidateRecord): Promise<ScannedAsset | undefined> {
    if (row.intent === "NEW") return undefined;
    const formal = (await scanFormalAssets(this.options)).assets.find(asset => asset.frontmatter.id === row.assetId);
    if (!formal || formal.relativePath !== targetPathForInboxPath(row.relativePath)) throw new RepositoryOperationError("BASELINE_MISMATCH", "正式知识不存在或路径已变化");
    assertCurrent(new AssetContentVersionRepository(database), formal, row.baselineHash!);
    return formal;
  }

  private async confirmation(database: Database.Database, asset: ScannedAsset, baselineHash?: string, candidateId?: string): Promise<{ changes: FileChange[]; apply: () => AssetConfirmationResult; verify: () => Promise<void> }> {
    const targetPath = targetPathForInboxPath(asset.relativePath);
    const formal = await scanFormalAssets(this.options);
    const current = formal.assets.find(item => item.frontmatter.id === asset.frontmatter.id);
    const versions = new AssetContentVersionRepository(database);
    if (baselineHash !== undefined) {
      if (!current || current.relativePath !== targetPath || !sameKind(current.frontmatter, asset.frontmatter)) throw new AssetConfirmationError("UPDATE_ASSET_INVALID", "修订必须保持身份、路径、类型和范围");
      assertCurrent(versions, current, baselineHash);
    } else {
      assertNoFormalIdConflict(formal, asset.frontmatter.id, asset.relativePath);
      if (await readBytes(this.options.repositoryPath, targetPath) !== null) throw new AssetConfirmationError("TARGET_ALREADY_EXISTS", "正式目标已存在");
    }
    return { changes: [{ relativePath: targetPath, before: current?.rawContent ?? null, after: asset.rawContent }, { relativePath: asset.relativePath, before: asset.rawContent, after: null }], verify: async () => {
      const result = await scanFormalAssets(this.options);
      const target = result.assets.find(item => item.relativePath === targetPath);
      if (!target || target.frontmatter.id !== asset.frontmatter.id || target.contentHash !== asset.contentHash) throw new AssetConfirmationError("POST_MOVE_VALIDATION_FAILED", "正式内容提交前资格校验失败");
    }, apply: () => {
      versions.rotate(asset.frontmatter.id, baselineHash ?? null, asset.rawContent);
      if (candidateId) new CandidateRepository(database).remove(candidateId);
      return { ok: true, assetId: asset.frontmatter.id, contentHash: asset.contentHash, sourceRelativePath: asset.relativePath, targetRelativePath: targetPath };
    } };
  }

  private database(readonly = false): Database.Database { return new Database(this.options.databasePath, { fileMustExist: true, readonly, timeout: 0 }); }
}

function assertCurrent(versions: AssetContentVersionRepository, asset: ScannedAsset, hash: string): void {
  const rows = versions.read(asset.frontmatter.id);
  if (typeof rows === "string" || asset.contentHash !== hash || rows.find(row => row.status === "CURRENT")?.contentHash !== hash) throw new AssetConfirmationError("BASELINE_MISMATCH", "正式文件与已确认基线不一致");
}
function summary(row: CandidateRecord): CandidateSummary { return { candidateId: row.candidateId, assetId: row.assetId, contentHash: row.contentHash, intent: row.intent }; }
export function matchesTarget(frontmatter: AssetFrontmatter, target: CandidateTarget): boolean {
  return frontmatter.scope === target.scope && (frontmatter.scope !== "WORKSPACE" || (target.scope === "WORKSPACE" && frontmatter.workspace === target.workspace));
}
function sameKind(a: AssetFrontmatter, b: AssetFrontmatter): boolean { return a.id === b.id && a.type === b.type && matchesTarget(a, b); }
function renderCandidate(frontmatter: AssetFrontmatter, body: string): Buffer {
  const yaml = Object.entries(frontmatter).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  const bytes = Buffer.from(`---\n${yaml}\n---\n\n${body.trim()}\n`, "utf8");
  if (bytes.length > 256_000) throw new RepositoryOperationError("CONTENT_TOO_LARGE", "候选超过 256000 字节限制");
  return bytes;
}
