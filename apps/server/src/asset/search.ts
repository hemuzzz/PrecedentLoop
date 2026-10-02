import { openDatabase } from "../storage/schema.js";
import { loadWorkspaceConfig } from "../workspace/config.js";
import { AssetRepository, type AssetRecord } from "./asset-repository.js";
import { foldCase, type AssetScope, type AssetType, type WorkspaceConfig } from "./schema.js";

export type SearchStrategy = "FTS" | "LITERAL" | "HYBRID";
export interface AssetSearchContext { authorizedWorkspaces: readonly string[]; workspaceConfigSnapshot?: WorkspaceConfig }
export interface AssetSearchQuery { context: AssetSearchContext; limit?: number; query: string }
export interface AssetSearchItem {
  assetId: string; version: number; matchedSnippet: string; scope: AssetScope; score: number;
  searchStrategy: SearchStrategy; summary: string; title: string; type: AssetType; workspace?: string;
}
export interface AssetLibraryListQuery { limit?: number; offset?: number; query?: string; scope?: AssetScope; type?: AssetType; workspace?: string | null }
export type AssetLibraryItem = Omit<AssetRecord, "bodyMarkdown" | "previousContent" | "createdAt"> & Partial<Pick<AssetSearchItem, "matchedSnippet" | "score" | "searchStrategy">>;
export type AssetLibraryReadResult = AssetRecord;
export interface AssetLibraryListResult { items: AssetLibraryItem[]; total: number; offset: number; limit: number }
export interface AssetReadQuery { assetId: string; context: AssetSearchContext }
export type AssetReadResult = AssetRecord;
export interface AssetSearchServiceOptions { databasePath: string; workspaceConfigPath: string; busyTimeoutMs?: number }
export interface NormalizedSearchQuery { longTerms: string[]; phrase: string; shortTerms: string[]; strategy: SearchStrategy; terms: string[] }
export interface RankedSearchItem { assetId: string; bm25: number | null; fieldTier: number; item: AssetSearchItem; workspacePriority: number }
export class AssetSearchInputError extends Error {
  constructor(readonly code: "EMPTY_QUERY" | "INVALID_LIMIT" | "INVALID_OFFSET", message: string) { super(message); }
}
export class AssetNotAccessibleError extends Error { readonly code = "ASSET_NOT_ACCESSIBLE"; constructor(id: string) { super(id); } }
export class AssetNotFoundError extends Error { readonly code = "ASSET_NOT_FOUND"; constructor(id: string) { super(id); } }
export class AssetLibraryInputError extends Error { readonly code = "WORKSPACE_INVALID"; }
export class AssetSearchService {
  readonly database;
  readonly repository: AssetRepository;
  constructor(readonly options: AssetSearchServiceOptions) {
    this.database = openDatabase(options.databasePath, { readonly: true, timeout: options.busyTimeoutMs ?? 5000 });
    this.repository = new AssetRepository(this.database);
  }
  close(): void { this.database.close(); }
  readTransaction<T>(fn: () => T): T { return this.database.transaction(fn)(); }
  async search(query: AssetSearchQuery): Promise<AssetSearchItem[]> {
    const normalized = normalizeAssetSearchQuery(query.query);
    return this.rank(query.context.authorizedWorkspaces, normalized).slice(0, limit(query.limit)).map(row => row.item);
  }
  rankedCandidates(context: AssetSearchContext, query: string): RankedSearchItem[] {
    return this.rank(context.authorizedWorkspaces, normalizeRecallExpression(query));
  }
  read(query: AssetReadQuery): AssetReadResult {
    const asset = this.repository.get(query.assetId);
    if (!asset) throw new AssetNotFoundError(query.assetId);
    if (asset.scope === "WORKSPACE" && !query.context.authorizedWorkspaces.includes(asset.workspace!)) throw new AssetNotAccessibleError(query.assetId);
    return asset;
  }
  async listLibrary(query: AssetLibraryListQuery): Promise<AssetLibraryListResult> {
    const config = await loadWorkspaceConfig(this.options.workspaceConfigPath);
    if (query.workspace && !config.workspaces.some(workspace => workspace.name === query.workspace)) throw new AssetLibraryInputError("工作区未登记");
    const pageLimit = limit(query.limit); const offset = query.offset ?? 0;
    if (pageLimit > 100) throw new AssetSearchInputError("INVALID_LIMIT", "Asset list limit must be an integer from 1 to 100");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AssetSearchInputError("INVALID_OFFSET", "Invalid offset");
    return this.readTransaction(() => {
      const workspaces = config.workspaces.map(workspace => workspace.name);
      const all = this.repository.list(workspaces).filter(asset => (!query.type || asset.type === query.type) &&
        (!query.scope || asset.scope === query.scope) && (query.workspace === undefined || asset.scope === "GLOBAL" || asset.workspace === query.workspace));
      const normalized = query.query?.trim() ? normalizeAssetSearchQuery(query.query) : undefined;
      const ranks = normalized ? this.rank(workspaces, normalized, query.workspace ?? null) : undefined;
      const scores = new Map(ranks?.map(row => [row.assetId, row]));
      let selected = ranks ? all.filter(asset => scores.has(asset.assetId)) : all;
      if (ranks) selected = selected.sort((a, b) => query.workspace
        ? compareRankedItems(scores.get(a.assetId)!, scores.get(b.assetId)!)
        : scores.get(b.assetId)!.item.score - scores.get(a.assetId)!.item.score || b.updatedAt.localeCompare(a.updatedAt) || a.assetId.localeCompare(b.assetId));
      return { items: selected.slice(offset, offset + pageLimit).map(({ bodyMarkdown: _body, previousContent: _previous, createdAt: _created, ...asset }) => ({
        ...asset, ...(scores.get(asset.assetId) ? { score: scores.get(asset.assetId)!.item.score, searchStrategy: normalized!.strategy,
          matchedSnippet: scores.get(asset.assetId)!.item.matchedSnippet } : {}) })), total: selected.length, offset, limit: pageLimit };
    });
  }
  async readLibrary(assetId: string): Promise<AssetLibraryReadResult> {
    const config = await loadWorkspaceConfig(this.options.workspaceConfigPath);
    const asset = this.repository.get(assetId);
    if (!asset || (asset.scope === "WORKSPACE" && !config.workspaces.some(workspace => workspace.name === asset.workspace))) throw new AssetNotFoundError(assetId);
    return asset;
  }
  private rank(workspaces: readonly string[], query: NormalizedSearchQuery, preferred?: string | null): RankedSearchItem[] {
    const rows = this.repository.search(workspaces, query.longTerms.length ? buildFtsAndQuery(query.longTerms) : undefined);
    const ranked: RankedSearchItem[] = [];
    for (const asset of rows) {
      const title = foldCase(asset.title), summary = foldCase(asset.summary), body = foldCase(asset.bodyMarkdown);
      const retrievalTerms = foldCase(asset.retrievalTerms.join("\n"));
      const fields = { title, summary, retrievalTerms, body, combined: `${title}\n${summary}\n${retrievalTerms}\n${body}` };
      if (!query.terms.every(term => fields.combined.includes(term))) continue;
      const fieldTier = query.strategy === "LITERAL" ? literalFieldTier(fields, query) : ftsFieldTier(fields, query.terms);
      const workspacePriority = asset.scope === "WORKSPACE" && (preferred === undefined ? workspaces.includes(asset.workspace!) : asset.workspace === preferred) ? 1 : 0;
      const source = [asset.title, asset.summary, asset.retrievalTerms.join("\n"), asset.bodyMarkdown].find(value => query.terms.some(term => foldCase(value).includes(term))) ?? asset.bodyMarkdown;
      const compact = source.replaceAll(/\s+/gu, " ").trim();
      const positions = query.terms.map(term => foldCase(compact).indexOf(term)).filter(position => position >= 0);
      const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 40), end = Math.min(compact.length, start + 180);
      ranked.push({ assetId: asset.assetId, bm25: asset.bm25, fieldTier, workspacePriority, item: {
        assetId: asset.assetId, version: asset.version, scope: asset.scope, title: asset.title, summary: asset.summary, type: asset.type,
        ...(asset.scope === "WORKSPACE" ? { workspace: asset.workspace! } : {}), score: publicScore(fieldTier, workspacePriority, asset.bm25),
        searchStrategy: query.strategy, matchedSnippet: `${start ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`,
      } });
    }
    return ranked.sort(compareRankedItems);
  }
}
function limit(value = 20): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AssetSearchInputError("INVALID_LIMIT", "Search limit must be a positive safe integer");
  return value;
}
// Recall treats each array item as one literal substring. Keep the library's
// word-search normalization separate; spaces and punctuation here are data.
export function normalizeRecallExpression(query: string): NormalizedSearchQuery {
  const phrase = foldCase(query.trim());
  if (!phrase) throw new AssetSearchInputError("EMPTY_QUERY", "Recall expression must not be empty");
  const short = Array.from(phrase).length < 3;
  return { phrase, terms: [phrase], longTerms: short ? [] : [phrase], shortTerms: short ? [phrase] : [],
    strategy: short ? "LITERAL" : "FTS" };
}

export function normalizeAssetSearchQuery(query: string): NormalizedSearchQuery {
  const terms = query
    .trim()
    .split(/\s+/u)
    .filter((term) => term.length > 0)
    .map(foldCase);
  if (terms.length === 0) {
    throw new AssetSearchInputError("EMPTY_QUERY", "Search query must contain at least one term");
  }

  const longTerms = terms.filter((term) => Array.from(term).length >= 3);
  const shortTerms = terms.filter((term) => Array.from(term).length < 3);
  const strategy: SearchStrategy =
    longTerms.length === 0 ? "LITERAL" : shortTerms.length === 0 ? "FTS" : "HYBRID";
  return {
    longTerms,
    phrase: terms.join(" "),
    shortTerms,
    strategy,
    terms,
  };
}

export function escapeFtsLiteral(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

export function buildFtsAndQuery(terms: readonly string[]): string {
  if (terms.length === 0) {
    throw new AssetSearchInputError("EMPTY_QUERY", "FTS query requires at least one long term");
  }
  return terms.map(escapeFtsLiteral).join(" AND ");
}

export function literalFieldTier(
  fields: {title: string; summary: string; retrievalTerms: string; body: string; combined: string},
  query: NormalizedSearchQuery,
): number {
  if (fields.title === query.phrase) {
    return 6;
  }
  if (fields.title.startsWith(query.phrase)) {
    return 5;
  }
  if (query.terms.every((term) => fields.title.includes(term))) {
    return 4;
  }
  if (query.terms.every((term) => fields.summary.includes(term)) || query.terms.every(term => fields.retrievalTerms.includes(term))) {
    return 3;
  }
  const bodyContainsAll = query.terms.every((term) => fields.body.includes(term));
  const metadataContainsAny = query.terms.some(
    (term) => fields.title.includes(term) || fields.summary.includes(term) || fields.retrievalTerms.includes(term),
  );
  if (bodyContainsAll && !metadataContainsAny) {
    return 1;
  }
  return 2;
}

export function ftsFieldTier(fields: {title: string; summary: string; retrievalTerms: string; body: string; combined: string}, terms: readonly string[]): number {
  if (terms.some((term) => fields.title.includes(term))) {
    return 3;
  }
  if (terms.some((term) => fields.summary.includes(term) || fields.retrievalTerms.includes(term))) {
    return 2;
  }
  return 1;
}

export function compareRankedItems(left: RankedSearchItem, right: RankedSearchItem): number {
  return (
    right.fieldTier - left.fieldTier ||
    right.workspacePriority - left.workspacePriority ||
    compareBm25(left.bm25, right.bm25) ||
    (left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0)
  );
}

function compareBm25(left: number | null, right: number | null): number {
  if (!Number.isFinite(left)) left = null;
  if (!Number.isFinite(right)) right = null;
  if (left === null || right === null) {
    return left === right ? 0 : left === null ? 1 : -1;
  }
  return left - right;
}

function publicScore(fieldTier: number, workspacePriority: number, bm25: number | null): number {
  const relevance = bm25 === null ? 0 : Math.max(0, -bm25);
  const normalizedBm25 = relevance / (1 + relevance);
  return Number((fieldTier * 100 + workspacePriority * 10 + normalizedBm25).toFixed(6));
}
