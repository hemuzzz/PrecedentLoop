import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "./schema.js";
import { RepositoryOperationError } from "../asset/errors.js";

/** Setup may import configuration before initializing its first database. */
export async function writeWorkspaceConfiguration<T>(databasePath: string, operation: () => Promise<T>): Promise<T> {
  if (!existsSync(databasePath)) return operation();
  const db = openDatabase(databasePath, { timeout: 0 });
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      try { db.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") || Date.now() >= deadline) throw error;
        // Let the current writer finish its asynchronous configuration I/O.
        await delay(20);
      }
    }
    const result = await operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    if (error instanceof Error && "code" in error && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED"))
      throw new RepositoryOperationError("REPOSITORY_BUSY", "工作区配置正在写入，请稍后重试");
    throw error;
  } finally { db.close(); }
}
