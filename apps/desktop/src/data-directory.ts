import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { appConfigSchema, backendEnvironment, dataPaths, executeFile, runtimeConfig, verifyBundledNode } from "./config.js";

export type DirectoryInspection =
  | { kind: "MISSING" | "EMPTY" | "OTHER_NON_EMPTY" }
  | { kind: "PRODUCT"; storageVersion: 2 }
  | { kind: "PRODUCT_INCOMPLETE"; storageVersion?: 0 }
  | { kind: "PRODUCT_UNSUPPORTED"; storageVersion?: number; reason: string }
  | { kind: "NOT_WRITABLE"; reason: string };
export type DataDirectoryInspection = DirectoryInspection | { kind: "SYNC_RISK"; inspection: DirectoryInspection };
const markerSchema = z.object({ formatVersion: z.literal(1), createdAt: z.iso.datetime(), dataId: z.uuid() }).strict();
const markerName = ".precedentloop.json";
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
async function nearestExisting(path: string): Promise<string> {
  let current = path;
  while (!await exists(current)) {
    const parent = dirname(current);
    if (current === parent) throw new Error("找不到可用的父目录");
    current = parent;
  }
  return current;
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
async function canonical(path: string): Promise<string> {
  const normalized = resolve(path), ancestor = await nearestExisting(normalized);
  return resolve(await realpath(ancestor), relative(ancestor, normalized));
}
/** True when either directory contains the other (after resolving symlinks and /var aliases). */
export async function pathsOverlap(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([canonical(left), canonical(right)]);
  return within(a, b) || within(b, a);
}
async function checkAccess(path: string, directory: boolean): Promise<void> {
  await access(path, constants.R_OK | constants.W_OK | (directory ? constants.X_OK : 0));
}

/** Reads the SQLite header only; never loads a native SQLite module in Electron. */
export async function readStorageVersion(path: string): Promise<number | undefined> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(100);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead < 100 || !header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) return undefined;
    return header.readUInt32BE(60);
  } finally { await file.close(); }
}

async function inspectContents(path: string): Promise<DirectoryInspection> {
  try {
    if (!await exists(path)) {
      await checkAccess(await nearestExisting(path), true);
      return { kind: "MISSING" };
    }
    if (!(await stat(path)).isDirectory()) return { kind: "NOT_WRITABLE", reason: "所选路径不是目录" };
    await checkAccess(path, true);
    if ((await readdir(path)).every(name => name === ".DS_Store")) return { kind: "EMPTY" };
    const paths = dataPaths(path);
    const marker = join(path, markerName);
    const hasMarker = await exists(marker);
    const hasLayout = hasMarker && await exists(paths.databasePath);
    if (!hasMarker) return { kind: "OTHER_NON_EMPTY" };
    if (hasMarker) {
      // A damaged marker is evidence of product data, never an invitation to overwrite it.
      const content = await readFile(marker, "utf8");
      try { markerSchema.parse(JSON.parse(content)); }
      catch { return { kind: "PRODUCT_UNSUPPORTED", reason: "数据目录标记无效或格式不受支持" }; }
    }
    if (hasMarker && !await exists(paths.databasePath)) return { kind: "PRODUCT_INCOMPLETE" };
    if (hasMarker && await readStorageVersion(paths.databasePath) === 0) return { kind: "PRODUCT_INCOMPLETE", storageVersion: 0 };
    if (!hasLayout) return { kind: "PRODUCT_UNSUPPORTED", reason: "主数据库缺失" };
    await checkAccess(dirname(paths.databasePath), true);
    await checkAccess(paths.databasePath, false);
    if (!(await stat(paths.databasePath)).isFile()) return { kind: "PRODUCT_UNSUPPORTED", reason: "主数据库不是普通文件" };
    const version = await readStorageVersion(paths.databasePath);
    if (version === 2) return { kind: "PRODUCT", storageVersion: 2 };
    return { kind: "PRODUCT_UNSUPPORTED", ...(version === undefined ? {} : { storageVersion: version }),
      reason: version === undefined ? "SQLite 文件头无效" : `不支持存储版本 ${version}` };
  } catch (error) { return { kind: "NOT_WRITABLE", reason: `无法读取或写入数据目录：${message(error)}` }; }
}

export async function inspectDataDirectory(path: string, home = homedir()): Promise<DataDirectoryInspection> {
  if (!isAbsolute(path)) return { kind: "NOT_WRITABLE", reason: "数据目录必须是绝对路径" };
  const normalized = resolve(path);
  const inspection = await inspectContents(normalized);
  let actual = normalized;
  try {
    const ancestor = await nearestExisting(normalized);
    actual = resolve(await realpath(ancestor), relative(ancestor, normalized));
  } catch { /* The inspection already carries the access failure. */ }
  let actualHome = home;
  try { actualHome = await realpath(home); } catch { /* A missing home still has a lexical boundary. */ }
  const roots = [home, actualHome].flatMap(base => [join(base, "Library/Mobile Documents"), join(base, "Library/CloudStorage")]);
  return roots.some(root => within(root, normalized) || within(root, actual)) ? { kind: "SYNC_RISK", inspection } : inspection;
}

export class DataDirectoryError extends Error {
  constructor(readonly step: string, error: unknown) { super(`${step}失败：${message(error)}`, { cause: error }); }
}
async function writeMarker(path: string): Promise<void> {
  await writeFile(join(path, markerName), JSON.stringify({ formatVersion: 1, createdAt: new Date().toISOString(), dataId: randomUUID() }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
}
export interface DirectoryWriteOptions { syncRiskConfirmed?: boolean; home?: string }
async function inspectForWrite(path: string, options: DirectoryWriteOptions): Promise<DirectoryInspection> {
  const checked = await inspectDataDirectory(path, options.home);
  if (checked.kind !== "SYNC_RISK") return checked;
  if (!options.syncRiskConfirmed) throw new DataDirectoryError("检查同步风险", "请先确认同步盘风险");
  return checked.inspection;
}
export async function ensureMarker(path: string, options: DirectoryWriteOptions = {}): Promise<void> {
  const inspection = await inspectForWrite(path, options);
  if (inspection.kind !== "PRODUCT") throw new DataDirectoryError("补写标记", "不是可用的本产品数据目录");
  if (!await exists(join(path, markerName))) await writeMarker(path);
}

async function initializeWithRuntime(path: string, runtime: string): Promise<void> {
  let step = "校验包内运行时";
  try {
    const node = await verifyBundledNode(runtime);
    const config = runtimeConfig(appConfigSchema.parse({ configVersion: 1, setupVersion: 1, setupCompleted: false, dataDirectory: path }));
    const args = ["init-database", "--offline"];
    step = "init-database";
    // The CLI compares argv[1] with import.meta.url; macOS /var aliases must be canonical.
    await executeFile(node, [await realpath(join(runtime, "apps/server/dist/maintenance-cli.js")), ...args], {
      cwd: path, env: backendEnvironment(config), timeout: 120000, maxBuffer: 1024 * 1024,
    });
    step = "核对存储版本";
    if (await readStorageVersion(config.databasePath) !== 2) throw new Error("存储未到达基线版本 2");
  } catch (error) { throw new DataDirectoryError(step, error); }
}

/** Setup calls this before starting any backend. Partial results are retained on failure. */
export async function prepareDirectoryLayout(path: string, options: DirectoryWriteOptions = {}): Promise<void> {
  const inspection = await inspectForWrite(path, options);
  if (!["MISSING", "EMPTY", "PRODUCT_INCOMPLETE"].includes(inspection.kind)) throw new DataDirectoryError("检查新数据目录", `仅允许不存在、空目录或未完成初始化的目录（${inspection.kind}）`);
  let step = "创建目录结构";
  try {
    await mkdir(path, { recursive: true });
    // Recheck before writes in case content appeared since the initial inspection.
    if (inspection.kind !== "PRODUCT_INCOMPLETE") {
      if (!(await readdir(path)).every(name => name === ".DS_Store")) throw new Error("数据目录已不再为空");
      // Establish identity before any other write, so an interrupted initialization can resume.
      await writeMarker(path);
    }
    for (const directory of ["runtime", "config", "logs"]) if (!await exists(join(path, directory))) await mkdir(join(path, directory), { recursive: true });
    step = "写入工作区配置";
    if (!await exists(dataPaths(path).workspaceConfigPath)) {
      await writeFile(dataPaths(path).workspaceConfigPath, '{"schemaVersion":1,"workspaces":[]}\n', { flag: "wx", mode: 0o600 });
    }
  } catch (error) { throw new DataDirectoryError(step, error); }
}
export async function initializeStorage(path: string, runtime: string, options: DirectoryWriteOptions = {}): Promise<void> {
  const inspection = await inspectForWrite(path, options);
  if (inspection.kind !== "PRODUCT_INCOMPLETE") throw new DataDirectoryError("初始化存储", "仅允许未完成初始化的目录");
  await initializeWithRuntime(path, runtime);
}
export async function initializeDataDirectory(path: string, runtime: string, options: DirectoryWriteOptions = {}): Promise<void> {
  await prepareDirectoryLayout(path, options);
  await initializeStorage(path, runtime, options);
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
/** Offline move (design §6.4): copies every regular file and directory, verifying each
 * file by SHA-256. The caller stops the backend first and checks that the target is
 * missing or empty. Symlinks and special files are refused rather than followed. */
export async function copyDataDirectory(source: string, target: string): Promise<{ files: number; bytes: number }> {
  let files = 0, bytes = 0;
  const walk = async (from: string, to: string): Promise<void> => {
    for (const entry of await readdir(from)) {
      if (entry === ".DS_Store") continue;
      const origin = join(from, entry), destination = join(to, entry), info = await lstat(origin);
      if (info.isDirectory()) {
        await mkdir(destination, { mode: info.mode & 0o777 });
        await walk(origin, destination);
      } else if (info.isFile()) {
        await copyFile(origin, destination, constants.COPYFILE_EXCL);
        await chmod(destination, info.mode & 0o777);
        if (await fileHash(origin) !== await fileHash(destination)) throw new Error(`文件校验不一致：${relative(source, origin)}`);
        files++; bytes += info.size;
      } else throw new Error(`数据目录包含符号链接或特殊文件，未迁移：${relative(source, origin)}`);
    }
  };
  try {
    await mkdir(target, { recursive: true });
    await walk(source, target);
  } catch (error) { throw new DataDirectoryError("复制并校验数据", error); }
  return { files, bytes };
}
