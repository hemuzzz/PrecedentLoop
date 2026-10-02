import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const BASELINE_SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
export const PERSISTENT_TABLES = ["asset", "asset_fts", "asset_candidate", "write_operation", "workspace_capability",
  "recall_operation", "recall_item", "read_operation", "used_event", "asset_issue"] as const;
export class DatabaseSchemaError extends Error {
  constructor(readonly code: "DATABASE_SCHEMA_INVALID" | "DATABASE_NOT_EMPTY", message: string) {
    super(message); this.name = "DatabaseSchemaError";
  }
}
export function assertDatabase(database: Database.Database): void {
  const tables = new Set(database.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const missing = PERSISTENT_TABLES.filter(table => !tables.has(table));
  if (missing.length) throw new DatabaseSchemaError("DATABASE_SCHEMA_INVALID", `缺少持久表：${missing.join(", ")}；新空库请执行 init-database --offline`);
}

export interface MissingColumn { table: string; name: string; definition: string }
// Only additive columns with constant defaults belong here. Definitions are developer-owned SQL.
export const COLUMN_ADDITIONS: readonly MissingColumn[] = ["asset", "asset_candidate"].map(table => ({
  table, name: "retrieval_terms", definition: "TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(retrieval_terms))",
}));
const schemaObjects = [...BASELINE_SCHEMA_SQL.matchAll(/CREATE (?:VIRTUAL |UNIQUE )?(TABLE|INDEX) IF NOT EXISTS (\w+)/gu)]
  .map((match) => ({ type: match[1]!.toLowerCase(), name: match[2]! }));
const ftsSql = BASELINE_SCHEMA_SQL.match(/CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5\(([^;]+)\);/u)![0];
const ftsColumns = [...ftsSql.matchAll(/(?:\(|,)\s*(\w+)(?:\s+UNINDEXED)?\s*(?=,|\))/gu)].map(match => match[1]!);
function columns(database: Database.Database, table: string): string[] {
  return database.prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)").all(table).map(row => row.name);
}
function missingStructure(database: Database.Database, additions: readonly MissingColumn[]) {
  const objects = database.prepare<[], { type: string; name: string }>("SELECT type,name FROM sqlite_master WHERE type IN ('table','index')").all();
  if (!objects.some(object => object.type === "table" && object.name === "asset"))
    throw new DatabaseSchemaError("DATABASE_SCHEMA_INVALID", "缺少 asset 表；新空库请执行 init-database --offline");
  return {
    objects: schemaObjects.some(expected => !objects.some(object => object.type === expected.type && object.name === expected.name)),
    columns: additions.filter(column => !columns(database, column.table).includes(column.name)),
    fts: JSON.stringify(columns(database, "asset_fts")) !== JSON.stringify(ftsColumns),
  };
}
/** Check without a write lock on the normal Hook path; recheck under the lock before filling gaps. */
export function completeDatabaseStructure(database: Database.Database, additions: readonly MissingColumn[] = COLUMN_ADDITIONS): void {
  if (database.readonly) { assertDatabase(database); return; }
  const missing = missingStructure(database, additions);
  if (!missing.objects && !missing.columns.length && !missing.fts) return;
  database.transaction(() => {
    const current = missingStructure(database, additions);
    if (!current.objects && !current.columns.length && !current.fts) return;
    database.exec(BASELINE_SCHEMA_SQL);
    for (const column of current.columns) {
      // A newly created table may already contain the column in schema.sql.
      if (!columns(database, column.table).includes(column.name))
        database.exec(`ALTER TABLE "${column.table}" ADD COLUMN "${column.name}" ${column.definition}`);
    }
    if (current.fts) {
      database.exec(`DROP TABLE asset_fts; ${ftsSql}`);
      const names = ftsColumns.map(name => `"${name}"`).join(",");
      database.exec(`INSERT INTO asset_fts (${names}) SELECT ${names} FROM asset WHERE is_deleted = 0`);
    }
  }).immediate();
}
export function openDatabase(path: string, options: Database.Options = {}): Database.Database {
  if (!existsSync(path)) throw new DatabaseSchemaError("DATABASE_SCHEMA_INVALID", "数据库不存在；新数据目录请先执行 init-database --offline");
  const database = new Database(path, { timeout: 5000, ...options, fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    if (!database.readonly) completeDatabaseStructure(database);
    assertDatabase(database);
    return database;
  }
  catch (error) { database.close(); throw error; }
}
/** Explicit initialization only. Existing schemas and data are never reset. */
export function initializeDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { timeout: 0 });
  try {
    database.pragma("foreign_keys = ON");
    database.transaction(() => {
      if (database.prepare("SELECT name FROM sqlite_master").all().length)
        throw new DatabaseSchemaError("DATABASE_NOT_EMPTY", "初始化仅允许空数据库；已有结构或数据时拒绝执行");
      database.exec(BASELINE_SCHEMA_SQL);
    }).exclusive();
  } finally { database.close(); }
}
