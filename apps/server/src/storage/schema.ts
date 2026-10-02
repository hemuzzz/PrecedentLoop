import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const DATABASE_VERSION = 2;
export const BASELINE_SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
export const PERSISTENT_TABLES = ["asset", "asset_fts", "asset_candidate", "write_operation", "workspace_capability",
  "recall_operation", "recall_item", "read_operation", "used_event"] as const;
export class DatabaseSchemaError extends Error {
  constructor(readonly code: "DATABASE_VERSION_UNSUPPORTED" | "DATABASE_SCHEMA_INVALID" | "DATABASE_NOT_EMPTY", message: string) {
    super(message); this.name = "DatabaseSchemaError";
  }
}
export function assertDatabase(database: Database.Database): void {
  const version = Number(database.pragma("user_version", { simple: true }));
  if (version !== DATABASE_VERSION) throw new DatabaseSchemaError("DATABASE_VERSION_UNSUPPORTED",
    `不支持数据库版本 ${version}，仅接受完整基线版本 2；不会自动升级。新空库请执行 init-database --offline`);
  const tables = new Set(database.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const missing = PERSISTENT_TABLES.filter(table => !tables.has(table));
  if (missing.length) throw new DatabaseSchemaError("DATABASE_SCHEMA_INVALID", `基线版本 2 缺少持久表：${missing.join(", ")}`);
}
export function openDatabase(path: string, options: Database.Options = {}): Database.Database {
  if (!existsSync(path)) throw new DatabaseSchemaError("DATABASE_SCHEMA_INVALID", "数据库不存在；新数据目录请先执行 init-database --offline");
  const database = new Database(path, { timeout: 5000, ...options, fileMustExist: true });
  try { database.pragma("foreign_keys = ON"); assertDatabase(database); return database; }
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
