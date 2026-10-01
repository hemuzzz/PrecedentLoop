import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync } from "node:fs";
import { realpath, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";

export class RepositoryOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "RepositoryOperationError"; }
}

interface Access { root: string; database: Database.Database; active: boolean }
const access = new AsyncLocalStorage<Access>();
const coordinationFile = ".candidate-coordination.sqlite";
export const transactionFile = ".candidate-transaction.json";

export function hasRepositoryAccess(repositoryPath: string): boolean {
  const held = access.getStore();
  return held?.active === true && held.root === resolve(repositoryPath);
}

export function needsRepositoryAccess(repositoryPath: string): boolean {
  return !hasRepositoryAccess(repositoryPath) && existsSync(join(repositoryPath, coordinationFile));
}

export function assetIsFrozen(repositoryPath: string, assetId: string): boolean {
  const row = coordinationDatabase(repositoryPath).prepare<[string], { pid: number }>("SELECT pid FROM asset_freeze WHERE asset_id=?").get(assetId);
  return row !== undefined && processExists(row.pid);
}

/** A separate SQLite lock coordinates files without holding the business DB
 * during AI generation. The OS releases it on process death; no stale lock TTL. */
export async function withRepositoryAccess<T>(
  repositoryPath: string, operation: () => Promise<T>, initialize = false,
): Promise<T> {
  const root = resolve(repositoryPath);
  if (hasRepositoryAccess(root)) return operation();
  const path = join(root, coordinationFile);
  // Scanners of repositories which have never enabled managed writes retain
  // their existing read-only behavior. Runtime initializes before serving reads.
  if (!initialize && !existsSync(path)) return operation();
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new RepositoryOperationError("REPOSITORY_INVALID", "知识库目录无效");
  }
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
    throw new RepositoryOperationError("REPOSITORY_INVALID", "协调文件必须是普通文件");
  }
  const deadline = Date.now() + 15_000;
  let database: Database.Database;
  for (;;) {
    const attempt = new Database(path, { timeout: 0 });
    try {
      attempt.exec("BEGIN EXCLUSIVE");
      attempt.exec(`CREATE TABLE IF NOT EXISTS configuration (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS asset_freeze (asset_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL)`);
      database = attempt;
      break;
    } catch (error) {
      if (attempt.inTransaction) attempt.exec("ROLLBACK");
      attempt.close();
      if (!(error instanceof Error && "code" in error && error.code === "SQLITE_BUSY")) throw error;
      if (Date.now() >= deadline) throw new RepositoryOperationError("REPOSITORY_BUSY", "知识库正在提交，请稍后重试");
      await delay(20);
    }
  }
  const held: Access = { root, database, active: true };
  try {
    return await access.run(held, async () => {
      if (existsSync(join(root, transactionFile))) {
        const configuration = database.prepare<[string], { value: string }>("SELECT value FROM configuration WHERE key = ?").get("databasePath");
        if (!configuration) throw new RepositoryOperationError("RECOVERY_REQUIRED", "提交恢复缺少数据库绑定");
        const { recoverFileTransaction } = await import("./file-transaction.js");
        await recoverFileTransaction(root, configuration.value);
      }
      return operation();
    });
  } finally {
    held.active = false;
    // Lock bookkeeping (including freezing) is committed independently of the
    // short business transaction. Release functions run even on failed work.
    try { if (database.inTransaction) database.exec("COMMIT"); } finally { database.close(); }
  }
}

export async function configureRepositoryCoordination(repositoryPath: string, databasePath: string): Promise<void> {
  await withRepositoryAccess(repositoryPath, async () => {
    const database = coordinationDatabase(repositoryPath);
    const path = await realpath(databasePath);
    const current = database.prepare<[string], { value: string }>("SELECT value FROM configuration WHERE key = ?").get("databasePath");
    if (current && current.value !== path) throw new RepositoryOperationError("DATABASE_MISMATCH", "同一知识库必须使用同一数据库");
    database.prepare("INSERT OR IGNORE INTO configuration VALUES ('databasePath', ?)").run(path);
  }, true);
}

/** Offline data-directory moves only. A copied coordination file still names the
 * source database; rebind it before any repository access, so that a pending
 * transaction recovers against the copied database and never the source. */
export async function rebindRepositoryCoordination(repositoryPath: string, databasePath: string): Promise<boolean> {
  const path = join(resolve(repositoryPath), coordinationFile);
  if (!existsSync(path)) return false;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new RepositoryOperationError("REPOSITORY_INVALID", "协调文件必须是普通文件");
  const target = await realpath(databasePath);
  const database = new Database(path, { timeout: 5000 });
  try {
    database.exec("BEGIN EXCLUSIVE");
    database.exec("CREATE TABLE IF NOT EXISTS configuration (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO configuration VALUES ('databasePath', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(target);
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  } finally { database.close(); }
  return true;
}

export function assertAssetsWritable(repositoryPath: string, assetIds: readonly string[], owner?: string): void {
  const database = coordinationDatabase(repositoryPath);
  for (const assetId of assetIds) {
    const row = database.prepare<[string], { owner: string; pid: number }>("SELECT owner, pid FROM asset_freeze WHERE asset_id = ?").get(assetId);
    if (!row || row.owner === owner) continue;
    if (!processExists(row.pid)) { database.prepare("DELETE FROM asset_freeze WHERE asset_id = ? AND owner = ?").run(assetId, row.owner); continue; }
    throw new RepositoryOperationError("ASSET_FROZEN", "该知识正在被 AI 处理，暂不能更新，请稍后重试");
  }
}

export function freezeAssets(repositoryPath: string, assetIds: readonly string[], owner: string): void {
  assertAssetsWritable(repositoryPath, assetIds, owner);
  const database = coordinationDatabase(repositoryPath);
  for (const id of assetIds) database.prepare("INSERT OR IGNORE INTO asset_freeze VALUES (?, ?, ?)").run(id, owner, process.pid);
}

export async function releaseAssets(repositoryPath: string, owner: string): Promise<void> {
  await withRepositoryAccess(repositoryPath, async () => {
    coordinationDatabase(repositoryPath).prepare("DELETE FROM asset_freeze WHERE owner = ? AND pid = ?").run(owner, process.pid);
  });
}

function coordinationDatabase(repositoryPath: string): Database.Database {
  const held = access.getStore();
  if (!hasRepositoryAccess(repositoryPath) || !held) throw new Error("Repository access must be held");
  return held.database;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}
