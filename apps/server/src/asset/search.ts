import Database from "better-sqlite3";
import { needsRepositoryAccess, withRepositoryAccess } from "./coordination.js";

import type { AssetFrontmatter, AssetScope, AssetType, WorkspaceConfig } from "./schema.js";
import {
  loadWorkspaceConfig,
  scanAssetFiles,
  type AssetDiagnostic,
  type AssetScanOptions,
  type ScannedAsset,
} from "./scanner.js";

const DEFAULT_SEARCH_LIMIT = 20;
const SNIPPET_LENGTH = 180;

export type SearchStrategy = "FTS" | "LITERAL" | "HYBRID";

export interface AssetSearchContext {
  authorizedWorkspaces: readonly string[];
  workspaceConfigSnapshot?: WorkspaceConfig;
}

export interface AssetSearchQuery {
  context: AssetSearchContext;
  limit?: number;
  query: string;
}

export interface AssetSearchItem {
  assetId: string;
  contentHash: string;
  matchedSnippet: string;
  scope: AssetScope;
  score: number;
  searchStrategy: SearchStrategy;
  summary: string;
  title: string;
  type: AssetType;
  workspace?: string;
}

export interface AssetLibraryListQuery {
  limit?: number;
  offset?: number;
  query?: string;
  scope?: AssetScope;
  type?: AssetType;
  workspace?: string | null;
}

export interface AssetLibraryItem {
  assetId: string;
  contentHash: string;
  matchedSnippet?: string;
  modifiedAt: string;
  relativePath: string;
  scope: AssetScope;
  score?: number;
  searchStrategy?: SearchStrategy;
  summary: string;
  title: string;
  type: AssetType;
  workspace: string | null;
}

export interface AssetLibraryReadResult extends AssetReadResult {
  bodyMarkdown: string;
  modifiedAt: string;
  relativePath: string;
}

export interface AssetLibraryListResult {
  items: AssetLibraryItem[];
  total: number;
  offset: number;
  limit: number;
}

export interface AssetReadQuery {
  assetId: string;
  context: AssetSearchContext;
}

export interface AssetReadResult {
  contentHash: string;
  frontmatter: AssetFrontmatter;
  markdown: string;
}

export type AssetSearchDiagnosticCode =
  | "CURRENT_ASSET_INVALID"
  | "CURRENT_ASSET_SCAN_INCOMPLETE"
  | "INDEX_REFRESH_FAILED"
  | "STALE_INDEX";

export interface AssetSearchDiagnostic {
  assetId?: string;
  code: AssetSearchDiagnosticCode;
  message: string;
  path?: string;
}

export interface AssetSearchServiceOptions extends AssetScanOptions {
  databasePath: string;
  refreshIndex: () => Promise<unknown>;
  busyTimeoutMs?: number;
}

interface CatalogCandidate {
  assetId: string;
  assetScope: AssetScope;
  assetType: AssetType;
  bm25: number | null;
  contentHash: string;
  filePath: string;
  fileSize: number;
  modifiedAt: string;
  summary: string;
  title: string;
  workspace: string | null;
}

export interface NormalizedSearchQuery {
  longTerms: string[];
  phrase: string;
  shortTerms: string[];
  strategy: SearchStrategy;
  terms: string[];
}

export interface RankedSearchItem {
  assetId: string;
  bm25: number | null;
  fieldTier: number;
  item: AssetSearchItem;
  workspacePriority: number;
}

interface CurrentCatalogAsset {
  asset: ScannedAsset;
  candidate: CatalogCandidate;
}

interface RankedLibraryItem extends RankedSearchItem {
  asset: ScannedAsset;
}

export class AssetSearchInputError extends Error {
  readonly code: "EMPTY_QUERY" | "INVALID_LIMIT" | "INVALID_OFFSET";

  constructor(code: "EMPTY_QUERY" | "INVALID_LIMIT" | "INVALID_OFFSET", message: string) {
    super(message);
    this.code = code;
    this.name = "AssetSearchInputError";
  }
}

export class AssetNotAccessibleError extends Error {
  readonly code = "ASSET_NOT_ACCESSIBLE";

  constructor(assetId: string) {
    super(`Asset ${assetId} does not exist or is not accessible in the current Workspace context`);
    this.name = "AssetNotAccessibleError";
  }
}

export class AssetNotFoundError extends Error {
  readonly code = "ASSET_NOT_FOUND";

  constructor(assetId: string) {
    super(`Asset ${assetId} does not exist`);
    this.name = "AssetNotFoundError";
  }
}

export class AssetSearchUnavailableError extends Error {
  readonly code = "ASSET_SEARCH_UNAVAILABLE";

  constructor(readonly reason: "ASSET_QUALIFICATION" | "WORKSPACE_CONFIGURATION") {
    super("Current Asset qualification could not be confirmed");
    this.name = "AssetSearchUnavailableError";
  }
}

export class AssetLibraryInputError extends Error {
  readonly code = "WORKSPACE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "AssetLibraryInputError";
  }
}

export class AssetStaleError extends Error {
  readonly code = "ASSET_STALE";

  constructor(assetId: string) {
    super(`Asset ${assetId} no longer matches its Catalog projection`);
    this.name = "AssetStaleError";
  }
}


export class AssetSearchService {
  readonly #database: Database.Database;
  readonly #refreshIndex: () => Promise<unknown>;
  readonly #scanOptions: AssetScanOptions;
  #closed = false;
  #diagnostics: AssetSearchDiagnostic[] = [];

  constructor(options: AssetSearchServiceOptions) {
    this.#database = new Database(options.databasePath, { fileMustExist: true, readonly: true, timeout: options.busyTimeoutMs ?? 5000 });
    this.#refreshIndex = options.refreshIndex;
    this.#scanOptions = {
      repositoryPath: options.repositoryPath,
      workspaceConfigPath: options.workspaceConfigPath,
    };
  }

  diagnostics(): AssetSearchDiagnostic[] {
    return [...this.#diagnostics];
  }

  snapshot<T>(operation: () => Promise<T>): Promise<T> {
    return withRepositoryAccess(this.#scanOptions.repositoryPath, operation);
  }

  async search(query: AssetSearchQuery): Promise<AssetSearchItem[]> {
    if (needsRepositoryAccess(this.#scanOptions.repositoryPath)) return this.snapshot(() => this.search(query));
    this.#assertOpen();
    this.#diagnostics = [];
    const normalized = normalizeAssetSearchQuery(query.query);
    const limit = normalizeLimit(query.limit);
    const candidates =
      normalized.strategy === "LITERAL"
        ? this.#catalogCandidates(query.context)
        : this.#ftsCandidates(query.context, buildFtsAndQuery(normalized.longTerms));
    const rankedItems = await this.#materializeCandidates(candidates, query.context, normalized);

    return rankedItems.sort(compareRankedItems).slice(0, limit).map(({ item }) => item);
  }

  async rankedCandidates(context: AssetSearchContext, query: string): Promise<RankedSearchItem[]> {
    if (needsRepositoryAccess(this.#scanOptions.repositoryPath)) return this.snapshot(() => this.rankedCandidates(context, query));
    this.#assertOpen();
    const normalized = normalizeRecallExpression(query);
    const candidates = normalized.strategy === "LITERAL" ? this.#catalogCandidates(context)
      : this.#ftsCandidates(context, escapeFtsLiteral(normalized.phrase));
    return (await this.#materializeCandidates(candidates, context, normalized)).sort(compareRankedItems);
  }

  async read(query: AssetReadQuery): Promise<AssetReadResult> {
    if (needsRepositoryAccess(this.#scanOptions.repositoryPath)) return this.snapshot(() => this.read(query));
    this.#assertOpen();
    this.#diagnostics = [];
    const candidate = this.#catalogCandidate(query.context, query.assetId);
    if (candidate === undefined) {
      if (!this.#catalogAssetExists(query.assetId)) {
        throw new AssetNotFoundError(query.assetId);
      }
      throw new AssetNotAccessibleError(query.assetId);
    }

    const scan = await scanAssetFiles({
      ...this.#scanOptions,
      relativePaths: [candidate.filePath],
      ...(query.context.workspaceConfigSnapshot ? { workspaceConfigSnapshot: query.context.workspaceConfigSnapshot } : {}),
    });
    if (!scan.isComplete) {
      this.#recordIncompleteScan(scan.diagnostics);
      await this.#refreshStaleIndex();
      throw unavailableError(scan.diagnostics);
    }

    this.#recordInvalidFiles(scan.diagnostics, [candidate]);
    const asset = scan.assets.find(({ relativePath }) => relativePath === candidate.filePath);
    if (
      asset === undefined ||
      asset.frontmatter.id !== candidate.assetId ||
      !isAccessible(asset, query.context)
    ) {
      this.#recordStale(candidate, "The current Markdown is missing, invalid, or no longer identifies this Asset");
      await this.#refreshStaleIndex();
      throw new AssetNotAccessibleError(query.assetId);
    }

    if (!matchesCatalog(candidate, asset)) {
      this.#recordStale(candidate, "The current Markdown differs from its Catalog projection");
      await this.#refreshStaleIndex();
    }

    return {
      contentHash: asset.contentHash,
      frontmatter: asset.frontmatter,
      markdown: asset.markdown,
    };
  }

  async listLibrary(query: AssetLibraryListQuery): Promise<AssetLibraryListResult> {
    if (needsRepositoryAccess(this.#scanOptions.repositoryPath)) return this.snapshot(() => this.listLibrary(query));
    this.#assertOpen();
    this.#diagnostics = [];
    await this.#assertConfiguredWorkspace(query);
    const limit = normalizeLibraryLimit(query.limit);
    const offset = query.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new AssetSearchInputError("INVALID_OFFSET", "Asset list offset must be a non-negative safe integer");
    }
    const normalized = query.query === undefined ? undefined : normalizeAssetSearchQuery(query.query);
    const candidates = this.#libraryCandidates(
      query,
      normalized !== undefined && normalized.strategy !== "LITERAL",
      normalized === undefined || normalized.strategy === "LITERAL"
        ? undefined
        : buildFtsAndQuery(normalized.longTerms),
    );
    const current = await this.#scanCurrentCandidates(
      candidates,
      (asset) => matchesLibraryFilter(asset, query),
    );

    if (normalized === undefined) {
      current.sort(compareCurrentCatalogAssets);
      return {
        items: current.slice(offset, offset + limit).map(({ asset }) => libraryItem(asset)),
        total: current.length,
        offset,
        limit,
      };
    }

    const concreteWorkspace = typeof query.workspace === "string" ? query.workspace : undefined;
    const ranked = current
      .map(({ asset, candidate }) => rankLibraryItem(asset, candidate, normalized, concreteWorkspace))
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
      .sort((left, right) =>
        concreteWorkspace === undefined
          ? compareLibraryScores(left, right)
          : compareRankedItems(left, right),
      );
    return {
      items: ranked.slice(offset, offset + limit).map(({ asset, item }) => libraryItem(asset, item)),
      total: ranked.length,
      offset,
      limit,
    };
  }

  async readLibrary(assetId: string): Promise<AssetLibraryReadResult> {
    if (needsRepositoryAccess(this.#scanOptions.repositoryPath)) return this.snapshot(() => this.readLibrary(assetId));
    this.#assertOpen();
    this.#diagnostics = [];
    const candidate = this.#libraryCatalogCandidate(assetId);
    if (candidate === undefined) {
      throw new AssetNotFoundError(assetId);
    }

    const scan = await scanAssetFiles({
      ...this.#scanOptions,
      relativePaths: [candidate.filePath],
    });
    if (!scan.isComplete) {
      this.#recordIncompleteScan(scan.diagnostics);
      await this.#refreshStaleIndex();
      throw unavailableError(scan.diagnostics);
    }

    this.#recordInvalidFiles(scan.diagnostics, [candidate]);
    const asset = scan.assets.find(({ relativePath }) => relativePath === candidate.filePath);
    if (
      asset === undefined ||
      asset.frontmatter.id !== candidate.assetId ||
      asset.contentHash !== candidate.contentHash
    ) {
      this.#recordStale(candidate, "The current Markdown no longer matches this Catalog Asset");
      await this.#refreshStaleIndex();
      throw new AssetStaleError(assetId);
    }

    if (!matchesCatalog(candidate, asset)) {
      this.#recordStale(candidate, "The current file metadata differs from its Catalog projection");
      await this.#refreshStaleIndex();
    }

    return {
      bodyMarkdown: asset.content,
      contentHash: asset.contentHash,
      frontmatter: asset.frontmatter,
      markdown: asset.markdown,
      modifiedAt: asset.modifiedAt,
      relativePath: asset.relativePath,
    };
  }

  existingCatalogAssetIds(assetIds: readonly string[]): Set<string> {
    this.#assertOpen();
    if (assetIds.length === 0) {
      return new Set();
    }
    const uniqueIds = [...new Set(assetIds)];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.#database
      .prepare<string[], { assetId: string }>(
        `SELECT asset_id AS assetId FROM asset_catalog WHERE asset_id IN (${placeholders})`,
      )
      .all(...uniqueIds);
    return new Set(rows.map(({ assetId }) => assetId));
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#database.close();
    }
  }

  async #materializeCandidates(
    candidates: readonly CatalogCandidate[],
    context: AssetSearchContext,
    query: NormalizedSearchQuery,
  ): Promise<RankedSearchItem[]> {
    const rankedItems: RankedSearchItem[] = [];
    const current = await this.#scanCurrentCandidates(candidates, (asset) => isAccessible(asset, context), context.workspaceConfigSnapshot);

    for (const { asset, candidate } of current) {

      const fields = normalizedFields(asset);
      if (!query.terms.every((term) => fields.combined.includes(term))) {
        continue;
      }

      const fieldTier =
        query.strategy === "LITERAL"
          ? literalFieldTier(fields, query)
          : ftsFieldTier(fields, query.terms);
      const workspacePriority =
        asset.frontmatter.scope === "WORKSPACE" && selectedWorkspaces(context).includes(asset.frontmatter.workspace) ? 1 : 0;
      const score = publicScore(fieldTier, workspacePriority, candidate.bm25);
      const { frontmatter } = asset;
      const item: AssetSearchItem = {
        assetId: frontmatter.id,
        contentHash: asset.contentHash,
        matchedSnippet: matchedSnippet(asset, query.terms),
        scope: frontmatter.scope,
        score,
        searchStrategy: query.strategy,
        summary: frontmatter.summary,
        title: frontmatter.title,
        type: frontmatter.type,
        ...(frontmatter.scope === "WORKSPACE" ? { workspace: frontmatter.workspace } : {}),
      };
      rankedItems.push({
        assetId: frontmatter.id,
        bm25: candidate.bm25,
        fieldTier,
        item,
        workspacePriority,
      });
    }

    return rankedItems;
  }

  async #scanCurrentCandidates(
    candidates: readonly CatalogCandidate[],
    isAllowed: (asset: ScannedAsset) => boolean,
    workspaceConfigSnapshot?: WorkspaceConfig,
  ): Promise<CurrentCatalogAsset[]> {
    if (candidates.length === 0) {
      return [];
    }
    const scan = await scanAssetFiles({
      ...this.#scanOptions,
      relativePaths: candidates.map(({ filePath }) => filePath),
      ...(workspaceConfigSnapshot ? { workspaceConfigSnapshot } : {}),
    });
    if (!scan.isComplete) {
      this.#recordIncompleteScan(scan.diagnostics);
      await this.#refreshStaleIndex();
      throw unavailableError(scan.diagnostics);
    }

    this.#recordInvalidFiles(scan.diagnostics, candidates);
    const assetsByPath = new Map(scan.assets.map((asset) => [asset.relativePath, asset]));
    const current: CurrentCatalogAsset[] = [];
    let foundStaleIndex = scan.diagnostics.length > 0;
    for (const candidate of candidates) {
      const asset = assetsByPath.get(candidate.filePath);
      if (asset === undefined || asset.frontmatter.id !== candidate.assetId || !isAllowed(asset)) {
        foundStaleIndex = true;
        this.#recordStale(candidate, "The current Markdown is missing, invalid, or no longer identifies this Asset");
        continue;
      }
      if (!matchesCatalog(candidate, asset)) {
        foundStaleIndex = true;
        this.#recordStale(candidate, "The current Markdown differs from its Catalog projection");
      }
      current.push({ asset, candidate });
    }
    if (foundStaleIndex) {
      await this.#refreshStaleIndex();
    }
    return current;
  }

  #catalogCandidates(context: AssetSearchContext): CatalogCandidate[] {
    const { sql, parameters } = eligibleCatalogSql(context, false);
    return this.#database.prepare<unknown[], CatalogCandidate>(sql).all(...parameters);
  }

  #ftsCandidates(context: AssetSearchContext, matchQuery: string): CatalogCandidate[] {
    const { sql, parameters } = eligibleCatalogSql(context, true);
    return this.#database
      .prepare<unknown[], CatalogCandidate>(sql)
      .all(...parameters, matchQuery);
  }

  #catalogCandidate(context: AssetSearchContext, assetId: string): CatalogCandidate | undefined {
    const { sql, parameters } = eligibleCatalogSql(context, false, "AND catalog.asset_id = ?");
    return this.#database
      .prepare<unknown[], CatalogCandidate>(sql)
      .get(...parameters, assetId);
  }

  #libraryCandidates(
    query: AssetLibraryListQuery,
    includeFts: boolean,
    matchQuery: string | undefined,
  ): CatalogCandidate[] {
    const { sql, parameters } = libraryCatalogSql(query, includeFts);
    return this.#database
      .prepare<unknown[], CatalogCandidate>(sql)
      .all(...parameters, ...(matchQuery === undefined ? [] : [matchQuery]));
  }

  #libraryCatalogCandidate(assetId: string): CatalogCandidate | undefined {
    return this.#database
      .prepare<[string], CatalogCandidate>(`${catalogSelection(false)} WHERE catalog.asset_id = ?`)
      .get(assetId);
  }

  async #assertConfiguredWorkspace(query: AssetLibraryListQuery): Promise<void> {
    let config;
    try {
      config = await loadWorkspaceConfig(this.#scanOptions.workspaceConfigPath);
    } catch {
      throw new AssetSearchUnavailableError("WORKSPACE_CONFIGURATION");
    }
    if (
      typeof query.workspace === "string" &&
      !config.workspaces.some(({ name }) => name === query.workspace)
    ) {
      throw new AssetLibraryInputError("workspace must name a configured Workspace or use the reserved value null");
    }
  }

  #catalogAssetExists(assetId: string): boolean {
    return this.#database
      .prepare<[string], { present: number }>("SELECT 1 AS present FROM asset_catalog WHERE asset_id = ?")
      .get(assetId) !== undefined;
  }

  #recordInvalidFiles(
    diagnostics: readonly AssetDiagnostic[],
    candidates: readonly CatalogCandidate[],
  ): void {
    const candidateByPath = new Map(candidates.map((candidate) => [candidate.filePath, candidate]));
    for (const diagnostic of diagnostics) {
      const candidate = candidateByPath.get(diagnostic.path);
      this.#diagnostics.push({
        ...(candidate === undefined ? {} : { assetId: candidate.assetId }),
        code: "CURRENT_ASSET_INVALID",
        message: `${diagnostic.code}: ${diagnostic.message}`,
        path: diagnostic.path,
      });
    }
  }

  #recordIncompleteScan(diagnostics: readonly AssetDiagnostic[]): void {
    for (const diagnostic of diagnostics) {
      this.#diagnostics.push({
        code: "CURRENT_ASSET_SCAN_INCOMPLETE",
        message: `${diagnostic.code}: ${diagnostic.message}`,
        path: diagnostic.path,
      });
    }
    if (diagnostics.length === 0) {
      this.#diagnostics.push({
        code: "CURRENT_ASSET_SCAN_INCOMPLETE",
        message: "Current Asset qualification could not be confirmed",
      });
    }
  }

  #recordStale(candidate: CatalogCandidate, message: string): void {
    this.#diagnostics.push({
      assetId: candidate.assetId,
      code: "STALE_INDEX",
      message,
      path: candidate.filePath,
    });
  }

  async #refreshStaleIndex(): Promise<void> {
    try {
      await this.#refreshIndex();
    } catch (error) {
      this.#diagnostics.push({
        code: "INDEX_REFRESH_FAILED",
        message: `Unable to refresh stale Catalog/FTS state: ${errorMessage(error)}`,
      });
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("AssetSearchService is closed");
    }
  }
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

function eligibleCatalogSql(
  context: AssetSearchContext,
  includeFts: boolean,
  suffix = "",
): { parameters: unknown[]; sql: string } {
  const selection = catalogSelection(includeFts);

  const workspaces = selectedWorkspaces(context);
  return {
    parameters: [...workspaces],
    sql: `${selection} WHERE (catalog.asset_scope = 'GLOBAL'${workspaces.length ? ` OR (catalog.asset_scope = 'WORKSPACE' AND catalog.workspace IN (${workspaces.map(() => '?').join(',')}))` : ''})
      ${includeFts ? "AND asset_fts MATCH ?" : ""} ${suffix}`,
  };
}

function libraryCatalogSql(
  query: AssetLibraryListQuery,
  includeFts: boolean,
): { parameters: unknown[]; sql: string } {
  const conditions: string[] = [];
  const parameters: unknown[] = [];
  if (Object.prototype.hasOwnProperty.call(query, "workspace")) {
    if (query.workspace === null) {
      conditions.push("catalog.asset_scope = 'GLOBAL'");
    } else if (query.workspace !== undefined) {
      conditions.push(
        "(catalog.asset_scope = 'GLOBAL' OR (catalog.asset_scope = 'WORKSPACE' AND catalog.workspace = ?))",
      );
      parameters.push(query.workspace);
    }
  }
  if (query.type !== undefined) {
    conditions.push("catalog.asset_type = ?");
    parameters.push(query.type);
  }
  if (query.scope !== undefined) {
    conditions.push("catalog.asset_scope = ?");
    parameters.push(query.scope);
  }
  if (includeFts) {
    conditions.push("asset_fts MATCH ?");
  }
  return {
    parameters,
    sql: `${catalogSelection(includeFts)}${conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`}`,
  };
}

function catalogSelection(includeFts: boolean): string {
  return `
    SELECT
      catalog.asset_id AS assetId,
      catalog.asset_type AS assetType,
      catalog.asset_scope AS assetScope,
      catalog.workspace,
      catalog.title,
      catalog.summary,
      catalog.file_path AS filePath,
      catalog.content_hash AS contentHash,
      catalog.file_size AS fileSize,
      catalog.modified_at AS modifiedAt,
      ${includeFts ? "bm25(asset_fts)" : "NULL"} AS bm25
    FROM ${includeFts ? "asset_fts JOIN asset_catalog AS catalog ON catalog.rowid = asset_fts.rowid" : "asset_catalog AS catalog"}
  `;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_SEARCH_LIMIT;
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new AssetSearchInputError("INVALID_LIMIT", "Search limit must be a positive safe integer");
  }
  return limit;
}

function normalizeLibraryLimit(limit: number | undefined): number {
  const normalized = normalizeLimit(limit);
  if (normalized > 100) {
    throw new AssetSearchInputError("INVALID_LIMIT", "Asset list limit must be an integer from 1 to 100");
  }
  return normalized;
}

function isAccessible(asset: ScannedAsset, context: AssetSearchContext): boolean {
  return (
    asset.frontmatter.scope === "GLOBAL" ||
    (selectedWorkspaces(context).length > 0 &&
      asset.frontmatter.scope === "WORKSPACE" &&
      selectedWorkspaces(context).includes(asset.frontmatter.workspace))
  );
}

function matchesLibraryFilter(asset: ScannedAsset, query: AssetLibraryListQuery): boolean {
  const { frontmatter } = asset;
  if (query.type !== undefined && frontmatter.type !== query.type) {
    return false;
  }
  if (query.scope !== undefined && frontmatter.scope !== query.scope) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(query, "workspace")) {
    return true;
  }
  if (query.workspace === null) {
    return frontmatter.scope === "GLOBAL";
  }
  return frontmatter.scope === "GLOBAL" ||
    (frontmatter.scope === "WORKSPACE" && frontmatter.workspace === query.workspace);
}

function matchesCatalog(candidate: CatalogCandidate, asset: ScannedAsset): boolean {
  const { frontmatter } = asset;
  const workspace = frontmatter.scope === "WORKSPACE" ? frontmatter.workspace : null;
  return (
    candidate.assetId === frontmatter.id &&
    candidate.assetType === frontmatter.type &&
    candidate.assetScope === frontmatter.scope &&
    candidate.workspace === workspace &&
    candidate.title === frontmatter.title &&
    candidate.summary === frontmatter.summary &&
    candidate.filePath === asset.relativePath &&
    candidate.contentHash === asset.contentHash &&
    candidate.fileSize === asset.fileSize &&
    candidate.modifiedAt === asset.modifiedAt
  );
}

function normalizedFields(asset: ScannedAsset): {
  body: string;
  combined: string;
  summary: string;
  title: string;
} {
  const title = foldCase(asset.frontmatter.title);
  const summary = foldCase(asset.frontmatter.summary);
  const body = foldCase(asset.content);
  return { body, combined: `${title}\n${summary}\n${body}`, summary, title };
}

function literalFieldTier(
  fields: ReturnType<typeof normalizedFields>,
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
  if (query.terms.every((term) => fields.summary.includes(term))) {
    return 3;
  }
  const bodyContainsAll = query.terms.every((term) => fields.body.includes(term));
  const metadataContainsAny = query.terms.some(
    (term) => fields.title.includes(term) || fields.summary.includes(term),
  );
  if (bodyContainsAll && !metadataContainsAny) {
    return 1;
  }
  return 2;
}

function ftsFieldTier(fields: ReturnType<typeof normalizedFields>, terms: readonly string[]): number {
  if (terms.some((term) => fields.title.includes(term))) {
    return 3;
  }
  if (terms.some((term) => fields.summary.includes(term))) {
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

function rankLibraryItem(
  asset: ScannedAsset,
  candidate: CatalogCandidate,
  query: NormalizedSearchQuery,
  concreteWorkspace: string | undefined,
): RankedLibraryItem | undefined {
  const fields = normalizedFields(asset);
  if (!query.terms.every((term) => fields.combined.includes(term))) {
    return undefined;
  }
  const fieldTier = query.strategy === "LITERAL"
    ? literalFieldTier(fields, query)
    : ftsFieldTier(fields, query.terms);
  const workspacePriority = concreteWorkspace !== undefined &&
    asset.frontmatter.scope === "WORKSPACE" &&
    asset.frontmatter.workspace === concreteWorkspace
    ? 1
    : 0;
  const { frontmatter } = asset;
  return {
    asset,
    assetId: frontmatter.id,
    bm25: candidate.bm25,
    fieldTier,
    item: {
      assetId: frontmatter.id,
      contentHash: asset.contentHash,
      matchedSnippet: matchedSnippet(asset, query.terms),
      scope: frontmatter.scope,
      score: publicScore(fieldTier, workspacePriority, candidate.bm25),
      searchStrategy: query.strategy,
      summary: frontmatter.summary,
      title: frontmatter.title,
      type: frontmatter.type,
      ...(frontmatter.scope === "WORKSPACE" ? { workspace: frontmatter.workspace } : {}),
    },
    workspacePriority,
  };
}

function libraryItem(asset: ScannedAsset, ranked?: AssetSearchItem): AssetLibraryItem {
  const { frontmatter } = asset;
  return {
    assetId: frontmatter.id,
    contentHash: asset.contentHash,
    modifiedAt: asset.modifiedAt,
    relativePath: asset.relativePath,
    scope: frontmatter.scope,
    summary: frontmatter.summary,
    title: frontmatter.title,
    type: frontmatter.type,
    workspace: frontmatter.scope === "WORKSPACE" ? frontmatter.workspace : null,
    ...(ranked === undefined
      ? {}
      : {
          matchedSnippet: ranked.matchedSnippet,
          score: ranked.score,
          searchStrategy: ranked.searchStrategy,
        }),
  };
}

function compareCurrentCatalogAssets(left: CurrentCatalogAsset, right: CurrentCatalogAsset): number {
  return right.asset.modifiedAt.localeCompare(left.asset.modifiedAt) ||
    left.asset.frontmatter.id.localeCompare(right.asset.frontmatter.id);
}

function compareLibraryScores(left: RankedLibraryItem, right: RankedLibraryItem): number {
  return right.item.score - left.item.score ||
    right.asset.modifiedAt.localeCompare(left.asset.modifiedAt) ||
    (left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0);
}

function matchedSnippet(asset: ScannedAsset, terms: readonly string[]): string {
  const sources = [asset.frontmatter.title, asset.frontmatter.summary, asset.content];
  const source = sources.find((value) => terms.some((term) => foldCase(value).includes(term))) ?? asset.content;
  const compact = source.replaceAll(/\s+/gu, " ").trim();
  const folded = foldCase(compact);
  const positions = terms.map((term) => folded.indexOf(term)).filter((position) => position >= 0);
  const firstMatch = positions.length === 0 ? 0 : Math.min(...positions);
  const start = Math.max(0, firstMatch - 40);
  const end = Math.min(compact.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
}

function foldCase(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableError(diagnostics: readonly AssetDiagnostic[]): AssetSearchUnavailableError {
  return new AssetSearchUnavailableError(
    diagnostics.some(({ code }) => code === "INVALID_WORKSPACE_CONFIG")
      ? "WORKSPACE_CONFIGURATION"
      : "ASSET_QUALIFICATION",
  );
}

function selectedWorkspaces(context: AssetSearchContext): readonly string[] {
  return context.authorizedWorkspaces;
}
