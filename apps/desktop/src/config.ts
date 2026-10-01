import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { integrationChoicesSchema } from "./integrations/contract.js";
import { aiOverridesSchema } from "./settings-contract.js";

export const APP_NAME = "PrecedentLoop";
export const BUNDLE_ID = "local.precedentloop.desktop";
export const INSTALL_PATH = `/Applications/${APP_NAME}.app`;
const absolutePath = z.string().min(1).refine(isAbsolute, "必须是绝对路径");
// Legacy build fields are ignored; the executor now comes from Electron.
export const buildConfigSchema = z.object({});
export type BuildConfig = z.infer<typeof buildConfigSchema>;
export const appConfigSchema = z.object({
  configVersion: z.literal(1),
  setupVersion: z.number().int().nonnegative(),
  setupCompleted: z.boolean(),
  dataDirectory: absolutePath,
  port: z.number().int().min(1).max(65535).default(18888),
  startupTimeoutMs: z.number().int().min(100).max(120000).default(30000),
  shutdownTimeoutMs: z.number().int().min(100).max(120000).default(15000),
  agents: z.partialRecord(z.enum(["codex", "claude"]), z.boolean()).optional(),
  manualPaths: z.partialRecord(z.enum(["codex", "claude"]), absolutePath.max(4096).refine(value => !value.includes("\0"))).optional(),
  integrationChoices: integrationChoicesSchema.optional(),
  ai: aiOverridesSchema.optional(),
  // Automatic results are written only by the desktop detector. AI calls read
  // the same path as the Agent page and never fall back to a resource path.
  detectedPaths: z.partialRecord(z.enum(["codex", "claude"]), absolutePath.max(4096).refine(value => !value.includes("\0"))).optional(),
}).strict();
export type AppConfig = z.infer<typeof appConfigSchema>;
export interface AppIdentity { name: string; bundleId: string }
export function isTestIdentity(identity: AppIdentity): boolean {
  return identity.name.startsWith(`${APP_NAME}-Test-`) && identity.bundleId.startsWith(`${BUNDLE_ID}.test.`);
}
export function resolveUserData(identity: AppIdentity, appData = join(homedir(), "Library/Application Support"), env = process.env): string {
  const override = env.PRECEDENT_LOOP_USER_DATA_DIR;
  return isTestIdentity(identity) && override !== undefined ? absolutePath.parse(override) : join(appData, identity.name);
}
export function dataPaths(dataDirectory: string) {
  absolutePath.parse(dataDirectory);
  return {
    assetRepositoryPath: join(dataDirectory, "repository"),
    databasePath: join(dataDirectory, "runtime/precedent-loop.sqlite"),
    workspaceConfigPath: join(dataDirectory, "config/workspaces.json"),
    logPath: join(dataDirectory, "logs/server.log"),
    desktopLogPath: join(dataDirectory, "logs/desktop.log"),
  };
}
export function runtimeConfig(config: AppConfig) { return { ...config, ...dataPaths(config.dataDirectory) }; }
export type RuntimeConfig = ReturnType<typeof runtimeConfig>;
export type AppConfigResult = { kind: "MISSING" } | { kind: "VALID"; config: AppConfig } | { kind: "INVALID"; reason: string };
export async function readAppConfig(userData: string): Promise<AppConfigResult> {
  let content: string;
  try { content = await readFile(join(userData, "app-config.json"), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "MISSING" };
    return { kind: "INVALID", reason: String(error) };
  }
  try { return { kind: "VALID", config: appConfigSchema.parse(JSON.parse(content)) }; }
  catch (error) { return { kind: "INVALID", reason: String(error) }; }
}
export async function writeAppConfig(userData: string, value: AppConfig): Promise<void> {
  const config = appConfigSchema.parse(value);
  await mkdir(userData, { recursive: true });
  const temporary = join(userData, `.app-config-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(serializeAppConfig(config)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, join(userData, "app-config.json"));
  } finally { await rm(temporary, { force: true }); }
}
export function serializeAppConfig(value: AppConfig): string { return JSON.stringify(appConfigSchema.parse(value), null, 2) + "\n"; }
export async function requireAppConfig(userData: string): Promise<RuntimeConfig> {
  const result = await readAppConfig(userData);
  if (result.kind !== "VALID") throw new Error(result.kind === "MISSING" ? "缺少用户配置，请先完成初始化" : `配置文件无效：${result.reason}`);
  return runtimeConfig(result.config);
}
export const buildInfoSchema = z.object({
  buildId: z.string().uuid(), nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+$/u),
  electronVersion: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u).optional(),
  arch: z.enum(["arm64", "x64"]), modules: z.string().min(1),
}).strict();
export type BuildInfo = z.infer<typeof buildInfoSchema>;
export const executeFile = promisify(execFile);

export function cleanEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"]) delete env[key];
  return env;
}
export async function readBuildInfo(runtime: string): Promise<BuildInfo> {
  return buildInfoSchema.parse(JSON.parse(await readFile(join(runtime, "build-info.json"), "utf8")));
}
export function nodeEnvironment(): NodeJS.ProcessEnv {
  return { ...cleanEnvironment(), ELECTRON_RUN_AS_NODE: "1" };
}
export function bundledNodePath(runtime: string): string {
  const app = resolve(runtime, "../../..");
  const helper = `${basename(app, ".app")} Helper`;
  return join(app, "Contents/Frameworks", `${helper}.app`, "Contents/MacOS", helper);
}
export async function verifyBundledNode(runtime: string, expected?: BuildInfo): Promise<string> {
  const build = expected ?? await readBuildInfo(runtime);
  const nodePath = bundledNodePath(runtime);
  const actual = await inspectNode(nodePath);
  if (actual.nodeVersion !== build.nodeVersion || actual.arch !== build.arch || actual.modules !== build.modules || actual.electronVersion !== build.electronVersion) {
    throw new Error("包内 Node 版本、架构或 SQLite ABI 与程序快照不一致");
  }
  return nodePath;
}
export async function inspectNode(nodePath: string): Promise<Omit<BuildInfo, "buildId">> {
  const { stdout } = await executeFile(nodePath, ["-e", "console.log(JSON.stringify({nodeVersion:process.version,arch:process.arch,modules:process.versions.modules,electronVersion:process.versions.electron}))"], {
    env: nodeEnvironment(), timeout: 10000,
  });
  return buildInfoSchema.omit({ buildId: true }).parse(JSON.parse(stdout));
}
export function backendEnvironment(config: RuntimeConfig, appConfigPath?: string): NodeJS.ProcessEnv {
  return { ...nodeEnvironment(),
    ...(appConfigPath ? { PRECEDENT_LOOP_APP_CONFIG_PATH: appConfigPath } : {}),
    PRECEDENT_LOOP_ASSET_REPOSITORY_PATH: config.assetRepositoryPath,
    PRECEDENT_LOOP_DATABASE_PATH: config.databasePath,
    PRECEDENT_LOOP_WORKSPACES_PATH: config.workspaceConfigPath,
    PRECEDENT_LOOP_LOG_PATH: config.logPath,
    PORT: String(config.port),
  };
}
