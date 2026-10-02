import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { AssetNotAccessibleError, AssetNotFoundError, type AssetSearchService } from "../asset/index.js";
import { compareRankedItems, normalizeRecallExpression, type RankedSearchItem } from "../asset/search.js";
import type { StructuredErrorLogInput, StructuredLogger } from "../logging.js";
import type { WorkspaceCapabilityService } from "../workspace/capability.js";
import { KnowledgeError, recallInputSchema, readInputSchema, usedInputSchema,
  type RecallItem, type RecallResult, type Source } from "./model.js";
import type { KnowledgeRepository } from "./repository.js";

const characters = (text: string) => Array.from(text).length;
interface Candidate { item: RecallItem; summary: string; upgrade: boolean }
export class KnowledgeService {
  readonly ids = new SnowflakeIdGenerator();
  constructor(readonly repository: KnowledgeRepository, readonly capabilities: WorkspaceCapabilityService,
    readonly search: AssetSearchService, readonly logger?: StructuredLogger) {}
  async recall(input: unknown): Promise<RecallResult> {
    const parsed = recallInputSchema.safeParse(input);
    if (!parsed.success) throw new KnowledgeError("INPUT_INVALID");
    // Deduplicate case and surrounding whitespace only. Internal spaces remain
    // literal; retain the first expression's spelling in the record and response.
    const expressions = new Map<string, string>();
    for (const query of parsed.data.queries) {
      const key = normalizeRecallExpression(query).phrase;
      if (!expressions.has(key)) expressions.set(key, query);
    }
    const queries = [...expressions.values()];
    const { authorizedWorkspaces, config } = await this.capabilities.select(parsed.data.capabilityIds);
    const diagnostics: string[] = [];
    const context = { authorizedWorkspaces, workspaceConfigSnapshot: config };
    const result = this.search.readTransaction(() => {
    const ranks = new Map<string, RankedSearchItem>();
    for (const query of queries) {
      for (const rank of this.search.rankedCandidates(context, query)) {
        const prior = ranks.get(rank.assetId);
        if (!prior || compareRankedItems(rank, prior) < 0) ranks.set(rank.assetId, rank);
      }
    }
    const candidates: Candidate[] = [];
    let invalid = 0;
    for (const rank of [...ranks.values()].sort(compareRankedItems)) {
      const assetId = rank.assetId;
      try {
        const asset = this.search.read({ assetId, context });
        // Sources must describe the same content version.
        if (rank.item.version !== asset.version) { invalid++; continue; }
        const item: RecallItem = { recallItemId: this.ids.next("usg"), assetId, version: asset.version,
          assetScope: asset.scope, assetWorkspace: asset.scope === "WORKSPACE" ? asset.workspace : null,
          title: asset.title, type: asset.type, deliveredMode: "ON_DEMAND",
          deliveryReasons: [], reference: "asset_read: recallItemId + same capabilityIds" };
        candidates.push({ item, summary: asset.summary,
          upgrade: asset.type === "MEMORY" && rank.item.score >= 300 });
      } catch (error) {
        if (error instanceof AssetNotAccessibleError || error instanceof AssetNotFoundError) invalid++;
        else throw error;
      }
    }
    if (invalid) diagnostics.push("CANDIDATE_UNAVAILABLE");
    const result: RecallResult = { usageRecorded: true, recallId: this.ids.next("usg"), authorizedWorkspaces, queries,
      occurredAt: new Date().toISOString(),
      items: [], diagnostics, budget: { maxAssets: 8, maxModelVisibleCharacters: 5000, modelVisibleCharacters: 0,
        knowledgeContentCharacters: 0, metadataCharacters: 0, deliveredAssets: 0,
        omittedCount: candidates.length + invalid, downgradedCount: 0 } };
    // Reserve diagnostic overhead before choosing references, including both write outcomes.
    const reserved = ["ASSET_LIMIT", "CHARACTER_LIMIT", "BUDGET_DOWNGRADED"];
    result.diagnostics.push(...reserved);
    const selected: Candidate[] = [];
    for (const candidate of candidates) {
      if (result.items.length === 8) break;
      result.items.push(candidate.item);
      result.budget.omittedCount--;
      if (fits(result)) selected.push(candidate);
      else { result.items.pop(); result.budget.omittedCount++; }
    }
    for (const candidate of selected) {
      if (!candidate.upgrade) continue;
      candidate.item.summary = candidate.summary;
      candidate.item.deliveredMode = "DIRECT";
      if (!fits(result)) {
        delete candidate.item.summary; candidate.item.deliveredMode = "ON_DEMAND";
        candidate.item.deliveryReasons.push("BUDGET_DOWNGRADED");
      }
    }
    result.diagnostics = result.diagnostics.filter((code) => !reserved.includes(code));
    if (candidates.length > 8) result.diagnostics.push("ASSET_LIMIT");
    if (result.items.length < Math.min(8, candidates.length)) result.diagnostics.push("CHARACTER_LIMIT");
    if (result.items.some((i) => i.deliveryReasons.includes("BUDGET_DOWNGRADED"))) result.diagnostics.push("BUDGET_DOWNGRADED");
    if (!fits(result)) throw new KnowledgeError("RESPONSE_BUDGET_EXCEEDED");
    measure(result);
    return result;
    });
    try { this.repository.recordRecall(result); }
    catch (error) {
      if (!(error instanceof KnowledgeError) || error.code !== "USAGE_WRITE_FAILED") throw error;
      this.log({ event: "USAGE_RECALL_WRITE_FAILED", operation: "knowledge_recall", assetIds: result.items.map((item) => item.assetId), errorCode: error.code, error });
      return degraded(result);
    }
    return result;
  }
  async read(input: unknown) {
    const parsed = readInputSchema.safeParse(input);
    if (!parsed.success) throw new KnowledgeError("INPUT_INVALID");
    const { authorizedWorkspaces } = await this.capabilities.select(parsed.data.capabilityIds);
    const { source, asset } = this.repository.readTransaction(assets => {
    const source = "recallItemId" in parsed.data ? this.repository.item(parsed.data.recallItemId) : undefined;
    if ("recallItemId" in parsed.data && !source) throw new KnowledgeError("SOURCE_NOT_FOUND");
    if (source) assertScope(source, authorizedWorkspaces);
    const assetId = source?.assetId ?? ("assetId" in parsed.data ? parsed.data.assetId : "");
    const asset = assets.get(assetId);
    if (!asset) throw new AssetNotFoundError(assetId);
    if (asset.scope === "WORKSPACE" && !authorizedWorkspaces.includes(asset.workspace!)) throw new AssetNotAccessibleError(assetId);
    return { source, asset };
    });
    const assetId = asset.assetId;
    const expected = source?.version ?? ("expectedVersion" in parsed.data ? parsed.data.expectedVersion : undefined);
    if (expected !== undefined && asset.version !== expected) throw new KnowledgeError("CONTENT_CHANGED");
    if (Buffer.byteLength(asset.bodyMarkdown, "utf8") > 256_000) throw new KnowledgeError("READ_SIZE_EXCEEDED");
    const fact = { readRef: this.ids.next("usg"), authorizedWorkspaces, assetId, version: asset.version,
      assetScope: asset.scope, assetWorkspace: asset.scope === "WORKSPACE" ? asset.workspace : null,
      recallItemId: source?.recallItemId ?? null, occurredAt: new Date().toISOString() };
    const response = { ...fact, type: asset.type, title: asset.title, summary: asset.summary, markdown: asset.bodyMarkdown, usageRecorded: true, readRef: fact.readRef as string | null, diagnostics: [] as string[] };
    // Single-target response deliberately omits the parent operation and its scopes/query.
    try { this.repository.recordRead(fact); }
    catch (error) {
      if (!(error instanceof KnowledgeError) || error.code !== "USAGE_WRITE_FAILED") throw error;
      this.log({ event: "USAGE_READ_WRITE_FAILED", operation: "asset_read", assetId, errorCode: error.code, error });
      response.usageRecorded = false; response.readRef = null; response.diagnostics.push("USAGE_WRITE_FAILED");
    }
    return response;
  }
  async used(input: unknown) {
    const parsed = usedInputSchema.safeParse(input);
    if (!parsed.success) throw new KnowledgeError("INPUT_INVALID");
    const { authorizedWorkspaces, config } = await this.capabilities.select(parsed.data.capabilityIds);
    const source = "recallItemId" in parsed.data ? this.repository.item(parsed.data.recallItemId) : this.repository.readFact(parsed.data.readRef);
    if (!source) throw new KnowledgeError("SOURCE_NOT_FOUND");
    assertScope(source, authorizedWorkspaces);
    this.search.read({ assetId: source.assetId, context: { authorizedWorkspaces, workspaceConfigSnapshot: config } });
    const recallItemId = source.recallItemId;
    try {
      return this.repository.recordUsed({ usedId: this.ids.next("usg"), authorizedWorkspaces, assetId: source.assetId,
        recallItemId, directReadRef: recallItemId ? null : ("readRef" in parsed.data ? parsed.data.readRef : null), occurredAt: new Date().toISOString() });
    } catch (error) {
      if (error instanceof KnowledgeError && error.code === "USAGE_WRITE_FAILED") {
        this.log({ event: "USAGE_USED_WRITE_FAILED", operation: "asset_mark_used", assetId: source.assetId, errorCode: error.code, error });
      }
      throw error;
    }
  }
  private log(input: StructuredErrorLogInput): void {
    // Logging is diagnostic only; a failing log file must not change the response.
    try { this.logger?.error(input); } catch { /* best effort */ }
  }
}
function assertScope(source: Source, workspaces: string[]): void {
  if (source.assetScope !== "GLOBAL" && (!source.assetWorkspace || !workspaces.includes(source.assetWorkspace))) throw new KnowledgeError("ASSET_NOT_ACCESSIBLE");
}
function measure(result: RecallResult): number {
  const b = result.budget;
  b.deliveredAssets = result.items.length;
  b.downgradedCount = result.items.filter((item) => item.deliveryReasons.length > 0).length;
  b.knowledgeContentCharacters = result.items.reduce((sum, item) => sum + characters(JSON.stringify(item.title)) - 2 + (item.summary === undefined ? 0 : characters(JSON.stringify(item.summary)) - 2), 0);
  for (let iteration = 0; iteration < 10; iteration++) {
    const total = characters(JSON.stringify(result));
    if (total === b.modelVisibleCharacters && b.metadataCharacters === total - b.knowledgeContentCharacters) return total;
    b.modelVisibleCharacters = total; b.metadataCharacters = total - b.knowledgeContentCharacters;
  }
  return characters(JSON.stringify(result));
}
function degraded(result: RecallResult): RecallResult {
  const response = structuredClone(result);
  response.usageRecorded = false; response.recallId = null;
  response.items.forEach((item) => { item.recallItemId = null; item.reference = "asset_read: assetId + expectedVersion=version + same capabilityIds"; });
  response.diagnostics.push("USAGE_WRITE_FAILED");
  measure(response);
  return response;
}
function fits(result: RecallResult): boolean {
  // Also reserve one per-item downgrade reason, before attempting upgrades.
  const reservation = structuredClone(result);
  reservation.items.forEach((item) => { if (!item.deliveryReasons.includes("BUDGET_DOWNGRADED")) item.deliveryReasons.push("BUDGET_DOWNGRADED"); });
  return measure(reservation) <= 5000 && measure(degraded(reservation)) <= 5000;
}
