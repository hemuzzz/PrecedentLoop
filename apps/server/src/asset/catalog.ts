import Database from "better-sqlite3";

import type { AssetDiagnostic, ScannedAsset } from "./scanner.js";

const CREATE_CATALOG_SQL = `
  CREATE TABLE asset_catalog (
    asset_id        TEXT PRIMARY KEY,
    asset_type      TEXT NOT NULL,
    asset_scope     TEXT NOT NULL,
    workspace       TEXT,
    title           TEXT NOT NULL,
    summary         TEXT NOT NULL,
    file_path       TEXT NOT NULL UNIQUE,
    content_hash    TEXT NOT NULL,
    file_size       INTEGER NOT NULL,
    modified_at     TEXT NOT NULL,
    indexed_at      TEXT NOT NULL
  )
`;

const CREATE_FTS_SQL = `
  CREATE VIRTUAL TABLE asset_fts USING fts5(
    title,
    summary,
    body,
    content = '',
    contentless_delete = 1,
    tokenize = 'trigram'
  )
`;

interface CatalogRow {
  assetId: string;
  assetScope: string;
  assetType: string;
  contentHash: string;
  filePath: string;
  fileSize: number;
  indexedAt: string;
  modifiedAt: string;
  rowid: number;
  summary: string;
  title: string;
  workspace: string | null;
}

interface SchemaObjectRow {
  name: string;
  sql: string | null;
}

interface TableInfoRow {
  name: string;
  notnull: number;
  pk: number;
  type: string;
}

interface CountRow {
  count: number;
}

export interface CatalogCounts {
  catalog: number;
  fts: number;
}

export interface CatalogSyncResult {
  added: number;
  changed: number;
  invalidated: number;
  removed: number;
  unchanged: number;
}

interface SnapshotDifference {
  added: ScannedAsset[];
  changed: ScannedAsset[];
  changedRows: CatalogRow[];
  invalidatedRows: CatalogRow[];
  removedRows: CatalogRow[];
  unchanged: ScannedAsset[];
}

export class CatalogRebuildRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogRebuildRequiredError";
  }
}

export class AssetCatalog {
  readonly #database: Database.Database;
  #rebuildReason: string | null = null;

  constructor(databasePath: string, options: { maintenance?: boolean } = {}) {
    this.#database = new Database(databasePath, options.maintenance ? { fileMustExist: true, timeout: 100 } : {});
    // Offline repair must reach broken derived schemas, without initializing or
    // changing any schema before rebuild's transaction starts.
    if (!options.maintenance) this.#initializeSchema();
  }

  get rebuildReason(): string | null {
    return this.#rebuildReason;
  }

  applySnapshot(
    assets: readonly ScannedAsset[],
    diagnostics: readonly AssetDiagnostic[],
    indexedAt: string,
  ): CatalogSyncResult {
    this.#assertReady();

    const apply = this.#database.transaction(() => {
      const difference = calculateDifference(this.#readSnapshot(), assets, diagnostics);
      const rowsToDelete = [
        ...difference.removedRows,
        ...difference.invalidatedRows,
        ...difference.changedRows,
      ];

      this.#deleteRows(rowsToDelete);
      this.#insertAssets([...difference.changed, ...difference.added], indexedAt);

      return {
        added: difference.added.length,
        changed: difference.changed.length,
        invalidated: difference.invalidatedRows.length,
        removed: difference.removedRows.length,
        unchanged: difference.unchanged.length,
      };
    });

    const result = apply();
    this.#assertConsistent();
    return result;
  }

  rebuild(assets: readonly ScannedAsset[], indexedAt: string): CatalogSyncResult {
    const rebuild = this.#database.transaction(() => {
      this.#dropSchema();
      this.#createSchema();
      this.#insertAssets(assets, indexedAt);
    });

    rebuild.exclusive();
    this.#rebuildReason = null;
    this.#assertConsistent();

    return {
      added: assets.length,
      changed: 0,
      invalidated: 0,
      removed: 0,
      unchanged: 0,
    };
  }

  counts(): CatalogCounts {
    return {
      catalog: getCount(this.#database, "SELECT count(*) AS count FROM asset_catalog"),
      fts: getCount(this.#database, "SELECT count(*) AS count FROM asset_fts"),
    };
  }

  checkConsistency(): string | null {
    if (this.#rebuildReason !== null) {
      return this.#rebuildReason;
    }

    try {
      this.#assertConsistent();
      return null;
    } catch (error) {
      this.#rebuildReason = errorMessage(error);
      return this.#rebuildReason;
    }
  }

  close(): void {
    if (this.#database.open) {
      this.#database.close();
    }
  }

  #initializeSchema(): void {
    const rows = this.#database
      .prepare<[], SchemaObjectRow>(
        "SELECT name, sql FROM sqlite_master WHERE name IN ('asset_catalog', 'asset_fts') ORDER BY name",
      )
      .all();

    if (rows.length === 0) {
      this.#database.transaction(() => this.#createSchema())();
      return;
    }

    if (rows.length !== 2) {
      this.#rebuildReason = "asset_catalog and asset_fts must either both exist or both be absent";
      return;
    }

    const catalogColumns = this.#database.pragma("table_info(asset_catalog)") as TableInfoRow[];
    const expectedCatalogColumns: TableInfoRow[] = [
      { name: "asset_id", notnull: 0, pk: 1, type: "TEXT" },
      { name: "asset_type", notnull: 1, pk: 0, type: "TEXT" },
      { name: "asset_scope", notnull: 1, pk: 0, type: "TEXT" },
      { name: "workspace", notnull: 0, pk: 0, type: "TEXT" },
      { name: "title", notnull: 1, pk: 0, type: "TEXT" },
      { name: "summary", notnull: 1, pk: 0, type: "TEXT" },
      { name: "file_path", notnull: 1, pk: 0, type: "TEXT" },
      { name: "content_hash", notnull: 1, pk: 0, type: "TEXT" },
      { name: "file_size", notnull: 1, pk: 0, type: "INTEGER" },
      { name: "modified_at", notnull: 1, pk: 0, type: "TEXT" },
      { name: "indexed_at", notnull: 1, pk: 0, type: "TEXT" },
    ];

    if (!sameTableDefinition(catalogColumns, expectedCatalogColumns)) {
      this.#rebuildReason = "asset_catalog does not match the fixed N04 schema";
      return;
    }

    const ftsSql = rows.find(({ name }) => name === "asset_fts")?.sql ?? "";
    if (!isExpectedFtsDefinition(ftsSql)) {
      this.#rebuildReason = "asset_fts does not match the fixed contentless-delete trigram schema";
      return;
    }

    try {
      this.#assertConsistent();
    } catch (error) {
      this.#rebuildReason = errorMessage(error);
    }
  }

  #createSchema(): void {
    this.#database.exec(`${CREATE_CATALOG_SQL};${CREATE_FTS_SQL};`);
  }

  #dropSchema(): void {
    this.#database.exec("DROP TABLE IF EXISTS asset_fts; DROP TABLE IF EXISTS asset_catalog;");
  }

  #readSnapshot(): CatalogRow[] {
    return this.#database
      .prepare<[], CatalogRow>(`
        SELECT
          rowid,
          asset_id AS assetId,
          asset_type AS assetType,
          asset_scope AS assetScope,
          workspace,
          title,
          summary,
          file_path AS filePath,
          content_hash AS contentHash,
          file_size AS fileSize,
          modified_at AS modifiedAt,
          indexed_at AS indexedAt
        FROM asset_catalog
        ORDER BY rowid
      `)
      .all();
  }

  #deleteRows(rows: readonly CatalogRow[]): void {
    const deleteFts = this.#database.prepare<[number]>("DELETE FROM asset_fts WHERE rowid = ?");
    const deleteCatalog = this.#database.prepare<[number]>("DELETE FROM asset_catalog WHERE rowid = ?");

    for (const row of rows) {
      if (deleteFts.run(row.rowid).changes !== 1) {
        throw new CatalogRebuildRequiredError(`Missing FTS rowid ${row.rowid} for Asset ${row.assetId}`);
      }
      if (deleteCatalog.run(row.rowid).changes !== 1) {
        throw new CatalogRebuildRequiredError(`Missing Catalog rowid ${row.rowid} for Asset ${row.assetId}`);
      }
    }
  }

  #insertAssets(assets: readonly ScannedAsset[], indexedAt: string): void {
    const insertCatalog = this.#database.prepare<
      [string, string, string, string | null, string, string, string, string, number, string, string]
    >(`
      INSERT INTO asset_catalog (
        asset_id,
        asset_type,
        asset_scope,
        workspace,
        title,
        summary,
        file_path,
        content_hash,
        file_size,
        modified_at,
        indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.#database.prepare<[number, string, string, string]>(
      "INSERT INTO asset_fts (rowid, title, summary, body) VALUES (?, ?, ?, ?)",
    );

    for (const asset of assets) {
      const { frontmatter } = asset;
      const workspace = frontmatter.scope === "WORKSPACE" ? frontmatter.workspace : null;
      const result = insertCatalog.run(
        frontmatter.id,
        frontmatter.type,
        frontmatter.scope,
        workspace,
        frontmatter.title,
        frontmatter.summary,
        asset.relativePath,
        asset.contentHash,
        asset.fileSize,
        asset.modifiedAt,
        indexedAt,
      );
      const rowid = Number(result.lastInsertRowid);
      if (!Number.isSafeInteger(rowid)) {
        throw new Error(`Catalog rowid is outside the safe integer range: ${String(result.lastInsertRowid)}`);
      }
      insertFts.run(rowid, frontmatter.title, frontmatter.summary, asset.content);
    }
  }

  #assertReady(): void {
    if (this.#rebuildReason !== null) {
      throw new CatalogRebuildRequiredError(this.#rebuildReason);
    }
  }

  #assertConsistent(): void {
    const counts = this.counts();
    if (counts.catalog !== counts.fts) {
      throw new CatalogRebuildRequiredError(
        `Catalog/FTS row counts differ: catalog=${counts.catalog}, fts=${counts.fts}`,
      );
    }

    const catalogWithoutFts = getCount(
      this.#database,
      "SELECT count(*) AS count FROM asset_catalog WHERE rowid NOT IN (SELECT rowid FROM asset_fts)",
    );
    const ftsWithoutCatalog = getCount(
      this.#database,
      "SELECT count(*) AS count FROM asset_fts WHERE rowid NOT IN (SELECT rowid FROM asset_catalog)",
    );
    if (catalogWithoutFts !== 0 || ftsWithoutCatalog !== 0) {
      throw new CatalogRebuildRequiredError(
        `Catalog/FTS rowid mismatch: catalogWithoutFts=${catalogWithoutFts}, ftsWithoutCatalog=${ftsWithoutCatalog}`,
      );
    }
  }
}

function calculateDifference(
  catalogRows: readonly CatalogRow[],
  assets: readonly ScannedAsset[],
  diagnostics: readonly AssetDiagnostic[],
): SnapshotDifference {
  const assetsById = new Map(assets.map((asset) => [asset.frontmatter.id, asset]));
  const rowsById = new Map(catalogRows.map((row) => [row.assetId, row]));
  const invalidPaths = new Set(diagnostics.map(({ path }) => path));
  const added: ScannedAsset[] = [];
  const changed: ScannedAsset[] = [];
  const changedRows: CatalogRow[] = [];
  const invalidatedRows: CatalogRow[] = [];
  const removedRows: CatalogRow[] = [];
  const unchanged: ScannedAsset[] = [];

  // The Scanner supplies unique qualified IDs. Derive each new write from that
  // identity once; reusing an old path does not reuse the old Asset identity.
  for (const asset of assetsById.values()) {
    const row = rowsById.get(asset.frontmatter.id);
    if (row === undefined) {
      added.push(asset);
    } else if (sameCatalogValues(row, asset)) {
      unchanged.push(asset);
    } else {
      changedRows.push(row);
      changed.push(asset);
    }
  }

  // Disappeared identities are independent of new writes at their former paths.
  // applySnapshot deletes all affected rows before inserting any new row.
  for (const row of catalogRows) {
    if (assetsById.has(row.assetId)) continue;
    if (invalidPaths.has(row.filePath)) {
      invalidatedRows.push(row);
    } else {
      removedRows.push(row);
    }
  }

  return {
    added,
    changed,
    changedRows,
    invalidatedRows,
    removedRows,
    unchanged,
  };
}

function sameCatalogValues(row: CatalogRow, asset: ScannedAsset): boolean {
  const { frontmatter } = asset;
  const workspace = frontmatter.scope === "WORKSPACE" ? frontmatter.workspace : null;
  return (
    row.assetId === frontmatter.id &&
    row.assetType === frontmatter.type &&
    row.assetScope === frontmatter.scope &&
    row.workspace === workspace &&
    row.title === frontmatter.title &&
    row.summary === frontmatter.summary &&
    row.filePath === asset.relativePath &&
    row.contentHash === asset.contentHash &&
    row.fileSize === asset.fileSize &&
    row.modifiedAt === asset.modifiedAt
  );
}

function sameTableDefinition(actual: readonly TableInfoRow[], expected: readonly TableInfoRow[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((column, index) => {
      const expectedColumn = expected[index];
      return (
        expectedColumn !== undefined &&
        column.name === expectedColumn.name &&
        column.type.toUpperCase() === expectedColumn.type &&
        column.notnull === expectedColumn.notnull &&
        column.pk === expectedColumn.pk
      );
    })
  );
}

function isExpectedFtsDefinition(sql: string): boolean {
  const normalized = sql.replaceAll(/\s+/g, " ").toLowerCase();
  return (
    normalized.includes("using fts5") &&
    normalized.includes("title") &&
    normalized.includes("summary") &&
    normalized.includes("body") &&
    /content\s*=\s*''/.test(normalized) &&
    /contentless_delete\s*=\s*1/.test(normalized) &&
    /tokenize\s*=\s*'trigram'/.test(normalized)
  );
}

function getCount(database: Database.Database, sql: string): number {
  const row = database.prepare<[], CountRow>(sql).get();
  if (row === undefined) {
    throw new Error(`Count query returned no row: ${sql}`);
  }
  return row.count;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
