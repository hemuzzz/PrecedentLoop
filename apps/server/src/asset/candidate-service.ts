import { createHash } from "node:crypto";
import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { z } from "zod";
import { openDatabase } from "../storage/schema.js";
import { loadWorkspaceConfig, loadWorkspaceConfigSync } from "../workspace/config.js";
import { assetIdSchema, candidateIdSchema, assetTypeSchema, retrievalTermsSchema, type AssetScope } from "./schema.js";
import { checkStructuredContent } from "./structured-candidate-checks.js";
import { AssetRepository, type AssetRecord } from "./asset-repository.js";
import { CandidateRepository, type CandidateRecord, type WriteOperation } from "./candidate-repository.js";
import { RepositoryOperationError } from "./errors.js";
import { IssueRepository, type AssetIssue } from "./issue-repository.js";
import type { IssueDraft } from "./issue-service.js";

export const requestIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/u);
export const versionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const candidateTargetSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("GLOBAL") }).strict(),
  z.object({ scope: z.literal("WORKSPACE"), workspace: z.string().min(1).max(160) }).strict(),
]);
export type CandidateTarget = z.infer<typeof candidateTargetSchema>;
const unicodeText = z.string().trim().refine(value => !/[\u0000\uD800-\uDFFF]/u.test(value), "内容必须是有效文本");
export const contentFieldsSchema = z.object({ title: unicodeText.min(1).max(300), summary: unicodeText.min(1).max(4000), retrievalTerms: retrievalTermsSchema, bodyMarkdown: unicodeText.min(1).max(256_000) }).strict()
  .refine(value => Buffer.byteLength(value.bodyMarkdown) <= 256_000, "候选超过 256000 字节限制");
export const prepareItemSchema = contentFieldsSchema.safeExtend({ type: assetTypeSchema, target: candidateTargetSchema,
  existingAssetId: assetIdSchema.optional(), baseVersion: versionSchema.optional() }).strict()
  .refine(value => (value.existingAssetId === undefined) === (value.baseVersion === undefined), "修订必须同时提供 Asset ID 和正式基线版本");
export const candidateSelectionSchema = z.object({ requestId: requestIdSchema, candidateId: candidateIdSchema, assetId: assetIdSchema, candidateVersion: versionSchema }).strict();
export const acceptCandidateSchema = candidateSelectionSchema.extend({ baseVersion: versionSchema.optional() }).strict();
export const deferCandidateSchema = candidateSelectionSchema.extend({ deferred: z.boolean() }).strict();
export type PrepareItem = z.infer<typeof prepareItemSchema>;
export type CandidateSelection = z.infer<typeof candidateSelectionSchema>;
export interface CandidateSummary { candidateId: string; number: number; assetId: string; version: number; intent: "NEW" | "REVISION" }
export interface CandidateBatchResult { candidates: CandidateSummary[]; count: number; warnings: string[]; sourceResults: unknown[] }
export type ManagedInboxItem = CandidateRecord & { knowledgeNumber: number | null; baselineMarkdown?: string; currentFormalVersion?: number; issues: AssetIssue[] };
export interface CandidateOptions { databasePath: string; workspaceConfigPath: string }

export class CandidateService {
  readonly #ids = new SnowflakeIdGenerator();
  constructor(readonly options: CandidateOptions) {}
  async initialize(): Promise<void> { const db = openDatabase(this.options.databasePath); db.close(); }
  async list(bucket?: "PENDING" | "DEFERRED") {
    const config = await loadWorkspaceConfig(this.options.workspaceConfigPath);
    return this.read((repository, assets) => {
      const cards = new IssueRepository(repository.database).cards().filter(row => row.scope === "GLOBAL" || config.workspaces.some(workspace => workspace.name === row.workspace));
      const items: ManagedInboxItem[] = repository.list().filter(row => (!bucket || row.status === bucket) &&
        (row.scope === "GLOBAL" || config.workspaces.some(workspace => workspace.name === row.workspace))).map(row => {
        const formal = assets.get(row.assetId);
        return { ...row, knowledgeNumber: formal?.knowledgeNumber ?? null, issues: cards.find(card => card.assetId === row.assetId)?.issues ?? [],
          ...(formal ? { baselineMarkdown: displayContent(formal), currentFormalVersion: formal.version } : {}) };
      });
      return { items, issueCards: cards.filter(card => !repository.byAsset(card.assetId)),
        diagnostics: [], managed: true };
    });
  }
  async pendingCandidates(): Promise<Array<{ record: CandidateRecord }>> {
    return (await this.list()).items.map(record => ({ record }));
  }
  async receipt(requestId: string) { requestIdSchema.parse(requestId); return this.read(repository => repository.receipt(requestId)); }
  async operation(requestId: string) { return (await this.receipt(requestId))?.result; }
  async formalAssets(): Promise<AssetRecord[]> {
    const config = await loadWorkspaceConfig(this.options.workspaceConfigPath);
    return this.read((_repository, assets) => assets.list(config.workspaces.map(workspace => workspace.name)));
  }
  async prepare(requestId: string, rawItems: unknown[], details: {
    warnings?: string[]; sourceResults?: unknown[]; requestInput?: unknown; operation?: "prepare" | "import";
    beforeWrite?: (repository: CandidateRepository, assets: AssetRepository) => unknown;
    itemWarning?: (index: number, assets: AssetRepository) => string | undefined;
    issueDraft?: IssueDraft;
  } = {}) {
    requestIdSchema.parse(requestId);
    const items = z.array(prepareItemSchema).max(32).parse(rawItems);
    for (const item of items) checkStructuredContent({ retrievalTerms: item.retrievalTerms });
    await this.validateTargets(items.map(item => item.target));
    const operation = details.operation ?? (details.requestInput === undefined ? "prepare" : "import");
    return this.write(requestId, operation, details.requestInput ?? { items, details }, (repository, assets): CandidateBatchResult | RevisionBlocked | ReviewRequired => {
      this.validateTargetsAtCommit(items.map(item => item.target));
      if (details.issueDraft) {
        const draft = details.issueDraft;
        if (items.length !== 1 || items[0]!.existingAssetId !== draft.assetId || assets.get(draft.assetId)?.version !== draft.assetVersion || repository.byAsset(draft.assetId))
          throw new RepositoryOperationError("VERSION_CONFLICT", "知识或候选已变化，请重新起草修订");
      }
      const decision = details.beforeWrite?.(repository, assets);
      if (decision) return decision as ReviewRequired;
      const warnings = [...(details.warnings ?? [])];
      const candidates: CandidateSummary[] = [];
      for (const [index, item] of items.entries()) {
        const warning = details.itemWarning?.(index, assets);
        if (warning) { warnings.push(warning); continue; }
        const current = item.existingAssetId ? assets.get(item.existingAssetId) : undefined;
        if (item.existingAssetId && (!current || current.version !== item.baseVersion || current.type !== item.type || !matchesTarget(current, item.target))) {
          if (operation === "import") { warnings.push(`候选《${item.title}》未写入：正式知识版本或范围已变化，请重新导入。`); continue; }
          throw new RepositoryOperationError("VERSION_CONFLICT", "正式知识版本或范围已变化");
        }
        const blocked = current && repository.byAsset(current.assetId);
        if (current && blocked) {
          const result = revisionBlocked(current, blocked);
          if (operation === "import") { warnings.push(result.display); continue; }
          return result;
        }
        candidates.push(summary(repository.insert({ candidateId: this.#ids.next("cnd"),
          assetId: current?.assetId ?? this.#ids.next("ast"), intent: current ? "REVISION" : "NEW",
          type: item.type, scope: item.target.scope, workspace: item.target.scope === "GLOBAL" ? null : item.target.workspace,
          title: item.title, summary: item.summary, retrievalTerms: item.retrievalTerms, bodyMarkdown: item.bodyMarkdown, baseVersion: item.baseVersion ?? null })));
      }
      if (details.issueDraft) new IssueRepository(repository.database).draft(details.issueDraft.assetId, details.issueDraft.issueIds, candidates[0]!.candidateId);
      return { candidates, count: candidates.length, warnings, sourceResults: details.sourceResults ?? [], ...(details.issueDraft ? { operation: "draft-revision", explanation: details.issueDraft.explanation } : {}) };
    }, details.issueDraft?.requestHash);
  }
  async defer(rawInput: unknown) {
    const input = deferCandidateSchema.parse(rawInput);
    return this.write(input.requestId, "defer", input, repository => {
      this.selected(repository, input);
      const row = repository.setStatus(input.candidateId, input.candidateVersion, input.deferred ? "DEFERRED" : "PENDING");
      return { deferred: input.deferred, version: row.version };
    });
  }
  async reject(rawInput: unknown) {
    const input = candidateSelectionSchema.parse(rawInput);
    return this.write(input.requestId, "reject", input, repository => {
      const row = this.selected(repository, input); repository.setStatus(input.candidateId, input.candidateVersion, "REJECTED");
      if (row.intent === "REVISION") new IssueRepository(repository.database).reopen(row.assetId, row.candidateId);
      return { rejected: true, candidateId: input.candidateId };
    });
  }
  async accept(rawInput: unknown) {
    const input = acceptCandidateSchema.parse(rawInput);
    return this.write(input.requestId, "accept", input, (repository, assets) => {
      const row = this.selected(repository, input);
      this.validateTargetsAtCommit([targetOf(row)]);
      this.validateRevision(assets, row);
      if (row.baseVersion !== (input.baseVersion ?? null)) throw new RepositoryOperationError("VERSION_CONFLICT", "修订基线版本不一致");
      const asset = row.intent === "NEW" ? assets.insert(row) : assets.revise(row.assetId, row.baseVersion!, row);
      repository.setStatus(row.candidateId, row.version, "ACCEPTED");
      if (row.intent === "REVISION") new IssueRepository(repository.database).resolve(row.assetId);
      return { assetId: asset.assetId, version: asset.version, candidateId: row.candidateId, knowledgeNumber: asset.knowledgeNumber, status: "ACCEPTED" as const };
    });
  }
  async delete(rawInput: unknown) {
    const input = z.object({ requestId: requestIdSchema, assetId: assetIdSchema }).strict().parse(rawInput);
    return this.write(input.requestId, "delete", input, (_repository, assets) => { assets.delete(input.assetId); return { assetId: input.assetId, deleted: true }; });
  }
  async rewrite(input: CandidateSelection, fields: z.infer<typeof contentFieldsSchema>, requestInput?: unknown, operation: "rewrite" | "update" = "rewrite", issueDraft?: IssueDraft) {
    fields = contentFieldsSchema.parse(fields);
    checkStructuredContent({ retrievalTerms: fields.retrievalTerms });
    return this.write(input.requestId, operation, requestInput ?? { ...input, fields }, (repository, assets) => {
      const row = this.selected(repository, input);
      this.validateTargetsAtCommit([targetOf(row)]);
      this.validateRevision(assets, row);
      if (issueDraft && (row.assetId !== issueDraft.assetId || assets.get(row.assetId)?.version !== issueDraft.assetVersion))
        throw new RepositoryOperationError("VERSION_CONFLICT", "知识已变化，请重新起草修订");
      const next = repository.updateContent(row.candidateId, row.version, fields);
      if (issueDraft) new IssueRepository(repository.database).draft(row.assetId, issueDraft.issueIds, row.candidateId);
      return { ...summary(next), changed: next.version !== row.version, ...(issueDraft ? { operation: "draft-revision", explanation: issueDraft.explanation } : {}) };
    }, issueDraft?.requestHash);
  }
  async rewriteInput(input: CandidateSelection) {
    return this.read((repository, assets) => {
      const candidate = this.selected(repository, input); const baseline = this.validateRevision(assets, candidate);
      this.validateTargetsAtCommit([targetOf(candidate)]);
      return { candidate, baseline };
    });
  }
  async references(targets: CandidateTarget[]) {
    await this.validateTargets(targets);
    const all = (await this.formalAssets()).filter(asset => targets.some(target => matchesTarget(asset, target)));
    const references: AssetRecord[] = []; let size = 0;
    for (const asset of all) {
      const length = Buffer.byteLength(displayContent(asset));
      if (references.length >= 32 || size + length > 256_000) continue;
      references.push(asset); size += length;
    }
    return { references, limited: references.length < all.length };
  }
  async validateTargets(targets: CandidateTarget[]): Promise<void> {
    const config = await loadWorkspaceConfig(this.options.workspaceConfigPath);
    for (const target of targets) if (target.scope === "WORKSPACE" && !config.workspaces.some(workspace => workspace.name === target.workspace))
      throw new RepositoryOperationError("TARGET_INVALID", "目标工作区未配置");
  }
  read<T>(fn: (repository: CandidateRepository, assets: AssetRepository) => T): T {
    const db = openDatabase(this.options.databasePath, { readonly: true });
    try { return db.transaction(() => fn(new CandidateRepository(db), new AssetRepository(db)))(); } finally { db.close(); }
  }
  private validateTargetsAtCommit(targets: CandidateTarget[]): void {
    const config = loadWorkspaceConfigSync(this.options.workspaceConfigPath);
    for (const target of targets) if (target.scope === "WORKSPACE" && !config.workspaces.some(workspace => workspace.name === target.workspace))
      throw new RepositoryOperationError("TARGET_INVALID", "目标工作区未配置");
  }
  private write<T>(requestId: string, operation: WriteOperation, input: unknown, fn: (repository: CandidateRepository, assets: AssetRepository) => T, requestHash?: string): T {
    const db = openDatabase(this.options.databasePath);
    try { const repository = new CandidateRepository(db); return repository.write(requestId, operation, requestHash ?? inputHash({ operation, input }), () => fn(repository, new AssetRepository(db))); }
    finally { db.close(); }
  }
  private selected(repository: CandidateRepository, input: CandidateSelection): CandidateRecord {
    const row = repository.get(input.candidateId);
    if (!row || row.assetId !== input.assetId) throw new RepositoryOperationError("CANDIDATE_NOT_FOUND", "候选不存在或身份不一致");
    if (row.version !== input.candidateVersion || !["PENDING", "DEFERRED"].includes(row.status)) throw new RepositoryOperationError("VERSION_CONFLICT", "候选已变化或已处理");
    return row;
  }
  private validateRevision(assets: AssetRepository, row: CandidateRecord): AssetRecord | undefined {
    if (row.intent === "NEW") return undefined;
    const current = assets.get(row.assetId);
    if (!current || current.version !== row.baseVersion || current.type !== row.type || current.scope !== row.scope || current.workspace !== row.workspace)
      throw new RepositoryOperationError("VERSION_CONFLICT", "正式知识版本、类型或范围已变化");
    return current;
  }
}
export interface ReviewRequired { status: "REVIEW_REQUIRED"; instruction: string; pendingCandidates: Array<{
  candidateId: string; number: number; assetId: string; type: "MEMORY" | "DOCUMENT" | "SKILL";
  scope: AssetScope; workspace: string | null; status: string; title: string; summary: string;
  bodyOmitted?: true; bodyMarkdown?: string; retrievalTerms?: string[]; candidateVersion?: number;
}>; omittedBodies: number }
export function revisionBlocked(asset: AssetRecord, candidate: CandidateRecord) {
  return { status: "REVISION_BLOCKED" as const, assetId: asset.assetId, assetTitle: asset.title,
    blockingCandidate: { candidateId: candidate.candidateId, number: candidate.number, status: candidate.status, title: candidate.title, updatedAt: candidate.updatedAt },
    instruction: "本次修订没有写入。把 display 原样放在本轮最终回复的最后；不要重试。用户在 Hub 处理该候选并告知后，先用 asset_read 取最新 version，再重新调用 candidate_prepare。",
    display: `**知识修订未生成**\n\n《${asset.title}》已有未处理的候选 #${candidate.number}（${candidate.status === "DEFERRED" ? "暂存" : "待审"}），本次修订没有写入。\n\n请先在 Precedent Loop 候选页处理候选 #${candidate.number}（接受或拒绝），处理后告诉我“重新生成候选”。` };
}
export type RevisionBlocked = ReturnType<typeof revisionBlocked>;
function targetOf(row: CandidateRecord): CandidateTarget { return row.scope === "GLOBAL" ? { scope: "GLOBAL" } : { scope: "WORKSPACE", workspace: row.workspace! }; }
function summary(row: CandidateRecord): CandidateSummary { return { candidateId: row.candidateId, number: row.number, assetId: row.assetId, version: row.version, intent: row.intent }; }
export function matchesTarget(asset: { scope: AssetScope; workspace?: string | null }, target: CandidateTarget): boolean {
  return asset.scope === target.scope && (target.scope === "GLOBAL" || asset.workspace === target.workspace);
}
export function displayContent(content: { title: string; summary: string; bodyMarkdown: string; retrievalTerms?: string[] }): string {
  const heading = `# ${content.title}`;
  const firstLine = /^([^\r\n]*)(?:\r\n|\r|\n|$)/u.exec(content.bodyMarkdown)!;
  const body = firstLine[1] === heading
    ? content.bodyMarkdown.slice(firstLine[0].length).replace(/^(?:\r\n|\r|\n)+/u, "") : content.bodyMarkdown;
  return `${heading}\n\n${content.summary}\n\n检索词：${JSON.stringify(content.retrievalTerms ?? [])}\n\n${body}`;
}
export function inputHash(input: unknown): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
  return createHash("sha256").update(JSON.stringify(stable(input))).digest("hex");
}
