import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, rename, rm } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

export const hash = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");
export const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
export const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function parseObject(text: string, target: string): JsonObject {
  try { const value: unknown = JSON.parse(text); if (object(value)) return value; } catch { /* Stable error, never echo config contents. */ }
  throw new Error(`JSON 无法解析为对象，已保留原文件：${target}`);
}

/** Never follow a configured directory through a symlink into another host's files. */
export async function safeParents(target: string): Promise<void> {
  const absolute = resolve(target);
  let parent = dirname(absolute);
  const root = parse(parent).root;
  while (parent !== root) {
    try { const entry = await lstat(parent); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`目标父目录不是普通目录：${parent}`); }
    catch (error) { if (!missing(error)) throw error; }
    parent = dirname(parent);
  }
}
export async function readBytes(target: string, limit = 32_000_000): Promise<Buffer | null> {
  await safeParents(target);
  let file;
  try {
    file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(`文件类型或大小不支持：${target}`);
    return await file.readFile();
  } catch (error) { if (missing(error)) return null; throw error; }
  finally { await file?.close(); }
}
export async function readText(target: string, limit = 32_000_000): Promise<string | null> {
  const bytes = await readBytes(target, limit);
  return bytes === null ? null : bytes.toString("utf8");
}
export interface FileTree { [relative: string]: { content: string; mode: number; encoding?: "base64" } }
export async function readTree(target: string): Promise<FileTree | null> {
  await safeParents(target);
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`目标不是普通目录：${target}`);
  } catch (error) { if (missing(error)) return null; throw error; }
  const result: FileTree = {};
  async function walk(path: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name, child = join(path, entry.name);
      if (entry.isDirectory()) {
        result[`${relative}/`] = { content: "", mode: (await lstat(child)).mode & 0o777 };
        await walk(child, `${relative}/`);
      }
      else if (entry.isFile()) {
        const bytes = (await readBytes(child))!, content = bytes.toString("utf8");
        result[relative] = { content: Buffer.from(content).equals(bytes) ? content : bytes.toString("base64"),
          mode: (await lstat(child)).mode & 0o777, ...(!Buffer.from(content).equals(bytes) ? { encoding: "base64" as const } : {}) };
      }
      else throw new Error(`目录包含不支持的文件或符号链接：${child}`);
    }
  }
  await walk(target, "");
  return result;
}
/** Fingerprints include raw bytes, modes, directory entries and symlink identity; no writes. */
export async function pathHash(target: string): Promise<string> {
  await safeParents(target);
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) return hash(`link:${await readlink(target)}`);
    if (stat.isFile()) return hash(`${stat.mode & 0o777}:${hash((await readBytes(target))!)}`);
    if (stat.isDirectory()) {
      const children = (await readdir(target)).sort();
      return hash(JSON.stringify(await Promise.all(children.map(async name => [name, await pathHash(join(target, name))]))));
    }
    return hash(`unsupported:${stat.mode}`);
  } catch (error) { if (missing(error)) return "missing"; throw error; }
}
export async function atomicWrite(target: string, content: string | Buffer, mode = 0o600): Promise<void> {
  await safeParents(target);
  try { if (!(await lstat(target)).isFile()) throw new Error(`拒绝替换非普通文件：${target}`); } catch (error) { if (!missing(error)) throw error; }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(target), `.precedent-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", mode);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}
export async function writeTree(target: string, tree: FileTree): Promise<void> {
  await safeParents(target);
  // Caller has already backed up an existing complete directory.
  const stage = join(dirname(target), `.precedent-${randomUUID()}.staging`);
  const previous = join(dirname(target), `.precedent-${randomUUID()}.previous`);
  await mkdir(stage, { recursive: true, mode: 0o700 });
  let moved = false;
  try {
    for (const [relative, file] of Object.entries(tree)) {
      if (relative.endsWith("/")) await mkdir(join(stage, relative), { recursive: true, mode: file.mode });
      else await atomicWrite(join(stage, relative), file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content, file.mode);
    }
    try { await rename(target, previous); moved = true; } catch (error) { if (!missing(error)) throw error; }
    try { await rename(stage, target); } catch (error) { if (moved) await rename(previous, target); throw error; }
    if (moved) await rm(previous, { recursive: true });
    await chmod(target, 0o700);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
