import { constants } from "node:fs";
import { lstat, open, rename, unlink, link } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { realpath } from "node:fs/promises";
import Database from "better-sqlite3";
import { openDatabase } from "../storage/schema.js";
import { z } from "zod";
import { CandidateRepository } from "./candidate-repository.js";
import { AssetConfirmationError, ensureSafeTargetParent, targetPathForInboxPath } from "./confirmation.js";
import { RepositoryOperationError, configureRepositoryCoordination, hasRepositoryAccess, transactionFile, withRepositoryAccess } from "./coordination.js";

export interface FileChange { relativePath: string; before: Buffer | null; after: Buffer | null }
export interface FileTransactionOptions {
  repositoryPath: string; databasePath: string; requestId: string; operation: string; input: unknown;
  checkpoint?: (stage: "prepared" | "file-written" | "database-committed") => Promise<void>;
}
const changeSchema = z.object({ relativePath: z.string(), before: z.string().nullable(), after: z.string().nullable() }).strict();
const journalSchema = z.object({ writeId: z.string().uuid(), databasePath: z.string(), changes: z.array(changeSchema).max(256) }).strict();
type Journal = z.infer<typeof journalSchema>;

export function inputHash(input: unknown): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
      : value;
  return hash(Buffer.from(JSON.stringify(stable(input))));
}

export async function runFileTransaction<T>(options: FileTransactionOptions,
  prepare: (database: Database.Database) => Promise<{ changes: FileChange[]; apply: () => T; verify?: () => Promise<void> }>,
): Promise<T> {
  await configureRepositoryCoordination(options.repositoryPath, options.databasePath);
  return withRepositoryAccess(options.repositoryPath, async () => {
    const database = openDatabase(options.databasePath, { timeout: 0 });
    let journal: Journal | undefined;
    let committed = false;
    let result: T;
    try {
      const repository = new CandidateRepository(database);
      const expectedInput = inputHash({ operation: options.operation, input: options.input });
      const existing = repository.receipt(options.requestId);
      if (existing) {
        if (existing.inputHash !== expectedInput) throw new RepositoryOperationError("REQUEST_ID_CONFLICT", "同一请求标识不能用于不同内容");
        return existing.result as T;
      }
      database.exec("BEGIN IMMEDIATE");
      const prepared = await prepare(database);
      const writeId = randomUUID();
      const paths = new Set<string>();
      for (const change of prepared.changes) {
        validatePath(change.relativePath);
        if (paths.has(change.relativePath)) throw new RepositoryOperationError("TARGET_CONFLICT", "一次提交不能重复修改同一路径");
        paths.add(change.relativePath);
        await ensureSafeTargetParent(options.repositoryPath, change.relativePath);
        if (!same(await readBytes(options.repositoryPath, change.relativePath), change.before)) throw new RepositoryOperationError("CONTENT_HASH_MISMATCH", "文件已被其他操作修改");
      }
      journal = { writeId, databasePath: await realpath(options.databasePath), changes: prepared.changes.map(change => ({
        relativePath: change.relativePath, before: change.before?.toString("base64") ?? null, after: change.after?.toString("base64") ?? null,
      })) };
      const journalStage = join(options.repositoryPath, `.candidate-journal-${writeId}.staging`);
      await writeDurable(journalStage, Buffer.from(JSON.stringify(journal)));
      await link(journalStage, join(options.repositoryPath, transactionFile));
      await unlink(journalStage);
      await syncDirectory(options.repositoryPath);
      await options.checkpoint?.("prepared");
      for (const [index, change] of prepared.changes.entries()) await transition(options.repositoryPath, writeId, index, change);
      await options.checkpoint?.("file-written");
      // Recheck after all asynchronous file work and before the commit point.
      for (const change of prepared.changes) {
        if (!same(await readBytes(options.repositoryPath, change.relativePath), change.after)) throw new RepositoryOperationError("CONTENT_HASH_MISMATCH", "提交前文件已变化");
      }
      await prepared.verify?.();
      result = prepared.apply();
      repository.saveReceipt({ requestId: options.requestId, inputHash: expectedInput, writeId, operation: options.operation, result });
      database.exec("COMMIT");
      committed = true;
      await options.checkpoint?.("database-committed");
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      if (journal) {
        // A COMMIT error must be decided using committed rows, never a row from
        // our still-open transaction. Recovery opens a separate connection.
        const receipt = new CandidateRepository(database).receipt(options.requestId);
        if (receipt?.writeId === journal.writeId) {
          try { await recoverFileTransaction(options.repositoryPath, options.databasePath); } catch { /* committed; preserve recovery material */ }
          return receipt.result as T;
        }
        await recoverFileTransaction(options.repositoryPath, options.databasePath);
      }
      if (error instanceof RepositoryOperationError || error instanceof AssetConfirmationError || error instanceof z.ZodError) throw error;
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      throw new RepositoryOperationError(code.startsWith("SQLITE_") ? "DATABASE_WRITE_FAILED" : "FILE_OPERATION_FAILED", code.startsWith("SQLITE_") ? "数据库写入或提交失败，本次操作已回退" : "文件准备或写入失败，本次操作已回退");
    } finally { database.close(); }
    if (committed && journal) {
      // Cleanup failure cannot turn a committed operation into a failed one.
      try { await cleanup(options.repositoryPath, journal); } catch { /* next access retries cleanup */ }
    }
    return result!;
  });
}

export async function recoverFileTransaction(repositoryPath: string, databasePath: string): Promise<void> {
  if (!hasRepositoryAccess(repositoryPath)) throw new Error("Recovery requires repository coordination");
  const journalPath = join(repositoryPath, transactionFile);
  const bytes = await readOrdinary(journalPath, 100 * 1024 * 1024);
  if (bytes === null) return;
  let journal: Journal;
  try { journal = journalSchema.parse(JSON.parse(bytes.toString("utf8"))); }
  catch { throw new RepositoryOperationError("RECOVERY_REQUIRED", "提交恢复材料损坏，已保留原文件"); }
  if (journal.databasePath !== await realpath(databasePath)) throw new RepositoryOperationError("DATABASE_MISMATCH", "提交恢复数据库不匹配");
  const database = openDatabase(databasePath, { timeout: 0 });
  let committed: boolean;
  try { committed = database.prepare("SELECT 1 FROM inbox_operation WHERE write_id=?").get(journal.writeId) !== undefined; }
  finally { database.close(); }
  const changes = journal.changes.map(change => ({ relativePath: change.relativePath, before: decode(change.before), after: decode(change.after) }));
  let conflict = false;
  for (const [index, change] of [...changes.entries()].reverse()) {
    validatePath(change.relativePath);
    let current: Buffer | null;
    try { current = await readBytes(repositoryPath, change.relativePath); }
    catch { conflict = true; continue; }
    if (committed) {
      if (!same(current, change.after)) conflict = true;
    } else if (!same(current, change.before)) {
      if (!same(current, change.after)) { conflict = true; continue; }
      await transition(repositoryPath, journal.writeId, index, { relativePath: change.relativePath, before: change.after, after: change.before });
    }
  }
  if (conflict) throw new RepositoryOperationError("RECOVERY_REQUIRED", "文件被外部修改，恢复材料已保留，不能覆盖未知内容");
  await cleanup(repositoryPath, journal);
}

async function transition(root: string, writeId: string, index: number, change: FileChange): Promise<void> {
  if (same(change.before, change.after)) return;
  await ensureSafeTargetParent(root, change.relativePath);
  if (!same(await readBytes(root, change.relativePath), change.before)) throw new RepositoryOperationError("CONTENT_HASH_MISMATCH", "文件内容不再匹配事务输入");
  const target = join(root, change.relativePath);
  if (change.after === null) {
    await unlink(target);
  } else {
    const stage = stagingPath(root, writeId, index);
    const staged = await readOrdinary(stage);
    if (staged !== null) {
      if (!stageMatches(staged, change.before, change.after)) throw new RepositoryOperationError("RECOVERY_REQUIRED", "准备文件不匹配，已保留");
      await unlink(stage);
    }
    await writeDurable(stage, change.after);
    // link is no-clobber and publishes complete bytes; copyFile could expose a
    // partially copied new target if the process is killed during the copy.
    if (change.before === null) { await link(stage, target); await unlink(stage); }
    else await rename(stage, target);
    await syncDirectory(root);
  }
  await syncDirectory(dirname(target));
}

async function cleanup(root: string, journal: Journal): Promise<void> {
  for (const [index, change] of journal.changes.entries()) {
    const path = stagingPath(root, journal.writeId, index);
    const bytes = await readOrdinary(path);
    if (bytes === null) continue;
    if (!stageMatches(bytes, decode(change.before), decode(change.after))) throw new RepositoryOperationError("RECOVERY_REQUIRED", "未知准备文件已保留");
    await unlink(path);
  }
  await unlink(join(root, transactionFile));
  await syncDirectory(root);
}

export async function readBytes(root: string, relativePath: string): Promise<Buffer | null> {
  validatePath(relativePath);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new RepositoryOperationError("PATH_INVALID", "知识库路径无效");
  let path = root;
  for (const part of relativePath.split("/").slice(0, -1)) {
    path = join(path, part);
    try { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RepositoryOperationError("PATH_INVALID", "文件父目录无效"); }
    catch (error) { if (isMissing(error)) return null; throw error; }
  }
  return readOrdinary(join(root, relativePath));
}

async function readOrdinary(path: string, maxBytes = 256_000): Promise<Buffer | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > maxBytes) throw new RepositoryOperationError("FILE_INVALID", "文件类型或大小不符合要求"); return await handle.readFile(); }
    finally { await handle.close(); }
  } catch (error) { if (isMissing(error)) return null; throw error; }
}
async function writeDurable(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
function validatePath(path: string): void { targetPathForInboxPath(path.startsWith("assets/") ? `inbox/${path.slice(7)}` : path); }
function stagingPath(root: string, writeId: string, index: number): string { return join(root, `.candidate-${writeId}-${index}.staging`); }
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function same(a: Buffer | null, b: Buffer | null): boolean { return a === null || b === null ? a === b : a.equals(b); }
function stageMatches(bytes: Buffer, before: Buffer | null, after: Buffer | null): boolean {
  return [before, after].some(value => value !== null && bytes.length <= value.length && value.subarray(0, bytes.length).equals(bytes));
}
function decode(value: string | null): Buffer | null {
  if (value === null) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length > 256_000) throw new RepositoryOperationError("RECOVERY_REQUIRED", "恢复内容格式或大小不合法");
  return bytes;
}
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
