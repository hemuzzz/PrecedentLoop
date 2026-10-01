import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DATABASE_VERSION = 1;
export const CREATE_CATALOG_SQL = `
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
export const CREATE_FTS_SQL = `
  CREATE VIRTUAL TABLE asset_fts USING fts5(
    title,
    summary,
    body,
    content = '',
    contentless_delete = 1,
    tokenize = 'trigram'
  )
`;
export const CONTENT_VERSION_TABLE_SQL = `CREATE TABLE asset_content_version (
  asset_id TEXT NOT NULL,
  version_status TEXT NOT NULL CHECK (version_status IN ('CURRENT', 'PREVIOUS')),
  raw_content BLOB NOT NULL CHECK (typeof(raw_content) = 'blob'),
  content_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, version_status)
)`;
export const BASELINE_SCHEMA_SQL = `
${CREATE_CATALOG_SQL};
${CREATE_FTS_SQL};
${CONTENT_VERSION_TABLE_SQL};

CREATE TABLE workspace_capability (capability_key_hash TEXT PRIMARY KEY, workspace TEXT NOT NULL,
 created_at TEXT NOT NULL, trusted_workspace_mapping_hash TEXT NOT NULL);
CREATE TABLE recall_operation (recall_id TEXT PRIMARY KEY, authorized_workspaces_json TEXT NOT NULL,
 queries_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
 diagnostics_json TEXT NOT NULL, budget_json TEXT NOT NULL);
CREATE TABLE recall_item (recall_item_id TEXT PRIMARY KEY, recall_id TEXT NOT NULL REFERENCES recall_operation(recall_id),
 asset_id TEXT NOT NULL, content_hash TEXT NOT NULL, asset_scope TEXT NOT NULL, asset_workspace TEXT,
 delivered_mode TEXT NOT NULL, delivery_reasons_json TEXT NOT NULL, ordinal INTEGER NOT NULL,
 CHECK ((asset_scope='GLOBAL' AND asset_workspace IS NULL) OR (asset_scope='WORKSPACE' AND asset_workspace IS NOT NULL)),
 UNIQUE(recall_id,asset_id), UNIQUE(recall_id,ordinal));
CREATE TABLE read_operation (read_ref TEXT PRIMARY KEY, authorized_workspaces_json TEXT NOT NULL,
 asset_id TEXT NOT NULL, content_hash TEXT NOT NULL, asset_scope TEXT NOT NULL, asset_workspace TEXT,
 recall_item_id TEXT REFERENCES recall_item(recall_item_id), occurred_at TEXT NOT NULL,
 CHECK ((asset_scope='GLOBAL' AND asset_workspace IS NULL) OR (asset_scope='WORKSPACE' AND asset_workspace IS NOT NULL)));
CREATE TABLE used_event (used_id TEXT PRIMARY KEY, authorized_workspaces_json TEXT NOT NULL,
 recall_item_id TEXT UNIQUE REFERENCES recall_item(recall_item_id), direct_read_ref TEXT UNIQUE REFERENCES read_operation(read_ref),
 asset_id TEXT NOT NULL, occurred_at TEXT NOT NULL, CHECK ((recall_item_id IS NULL) != (direct_read_ref IS NULL)));
CREATE INDEX recall_item_asset ON recall_item(asset_id);
CREATE INDEX read_operation_asset ON read_operation(asset_id);
CREATE INDEX used_event_asset ON used_event(asset_id);


CREATE TABLE inbox_candidate (
  candidate_id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL UNIQUE,
  intent TEXT NOT NULL CHECK(intent IN ('NEW','REVISION')),
  relative_path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  baseline_hash TEXT,
  review_bucket TEXT NOT NULL CHECK(review_bucket IN ('PENDING','DEFERRED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((intent = 'NEW' AND baseline_hash IS NULL) OR (intent = 'REVISION' AND baseline_hash IS NOT NULL))
);
CREATE TABLE inbox_operation (
  request_id TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  write_id TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL,
  result_json TEXT NOT NULL,
  committed_at TEXT NOT NULL
);
CREATE TABLE asset_knowledge_number (
  knowledge_number INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL UNIQUE
);
`;

// Derived Catalog/FTS can be repaired; durable tables must already exist.
export const PERSISTENT_TABLES = ["workspace_capability", "recall_operation", "recall_item", "read_operation", "used_event",
  "asset_content_version", "inbox_candidate", "inbox_operation", "asset_knowledge_number"] as const;
export class DatabaseSchemaError extends Error {
  constructor(readonly code: "DATABASE_VERSION_UNSUPPORTED" | "DATABASE_SCHEMA_INVALID" | "DATABASE_NOT_EMPTY", message: string) {
    super(message); this.name = "DatabaseSchemaError";
  }
}
export function assertDatabase(database: Database.Database): void {
  const version = Number(database.pragma("user_version", { simple: true }));
  if (version !== DATABASE_VERSION) throw new DatabaseSchemaError("DATABASE_VERSION_UNSUPPORTED",
    `不支持数据库版本 ${version}，仅接受完整基线版本 1；不会自动升级。新空库请执行 init-database --offline`);
  const tables = new Set(database.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const missing = PERSISTENT_TABLES.filter(table => !tables.has(table));
  if (missing.length) throw new DatabaseSchemaError("DATABASE_SCHEMA_INVALID", `基线版本 1 缺少持久表：${missing.join(", ")}`);
}
export function openDatabase(path: string, options: Database.Options = {}): Database.Database {
  if (!existsSync(path)) throw new DatabaseSchemaError("DATABASE_SCHEMA_INVALID", "数据库不存在；新数据目录请先执行 init-database --offline");
  const database = new Database(path, { ...options, fileMustExist: true });
  try { assertDatabase(database); return database; }
  catch (error) { database.close(); throw error; }
}
/** Explicit initialization only. Existing schemas and data are never upgraded or reset. */
export function initializeDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { timeout: 0 });
  try {
    database.pragma("foreign_keys = ON");
    database.transaction(() => {
      const version = Number(database.pragma("user_version", { simple: true }));
      if (version !== 0 || database.prepare("SELECT name FROM sqlite_master").all().length)
        throw new DatabaseSchemaError("DATABASE_NOT_EMPTY", "初始化仅允许空数据库；已有数据或版本标记时拒绝执行");
      database.exec(BASELINE_SCHEMA_SQL);
      database.pragma(`user_version = ${DATABASE_VERSION}`);
    }).exclusive();
  } finally { database.close(); }
}
