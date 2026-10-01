import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { AgentDetection, SetupStateFile } from "./setup-contract.js";
import { integrationChoicesSchema } from "./integrations/contract.js";

export const setupPathSchema = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes("\0"), "必须是绝对路径");
export const agentNameSchema = z.enum(["codex", "claude"]);
export const setupDraftSchema = z.object({
  step: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  dataDirectory: setupPathSchema,
  agents: z.object({ codex: z.boolean(), claude: z.boolean() }).strict(),
  manualPaths: z.object({ codex: setupPathSchema.nullable(), claude: setupPathSchema.nullable() }).strict(),
  aiProvider: agentNameSchema.nullable(),
  integrationChoices: integrationChoicesSchema.optional(),
}).strict();
const detectionSchema = z.object({
  agent: agentNameSchema, source: z.enum(["manual", "auto"]), path: setupPathSchema.optional(),
  found: z.boolean(), runnable: z.boolean(), version: z.string().regex(/^\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?$/u).optional(),
  login: z.enum(["logged-in", "logged-out", "unverified"]), reason: z.string().max(200).optional(), checkedAt: z.iso.datetime(),
}).strict().transform(({ path, version, reason, ...required }): AgentDetection => ({
  ...required,
  ...(path === undefined ? {} : { path }),
  ...(version === undefined ? {} : { version }),
  ...(reason === undefined ? {} : { reason }),
}));
export const setupStateSchema = setupDraftSchema.extend({
  formatVersion: z.literal(1), updatedAt: z.iso.datetime(), detections: z.array(detectionSchema).max(2),
}).strict();
export function emptySetupState(defaultDataDirectory: string): SetupStateFile {
  return { formatVersion: 1, step: 1, dataDirectory: defaultDataDirectory,
    agents: { codex: false, claude: false }, manualPaths: { codex: null, claude: null }, aiProvider: null,
    updatedAt: new Date().toISOString(), detections: [] };
}
export async function readSetupState(userData: string, defaultDataDirectory: string): Promise<{ state: SetupStateFile; resumed: boolean; warning?: string }> {
  try {
    return { state: setupStateSchema.parse(JSON.parse(await readFile(join(userData, "setup-state.json"), "utf8"))), resumed: true };
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    return { state: emptySetupState(defaultDataDirectory), resumed: false,
      ...(!missing ? { warning: "设置草稿无法读取，已保留原文件。请重新选择。" } : {}) };
  }
}
export async function writeSetupState(userData: string, value: SetupStateFile): Promise<void> {
  const state = setupStateSchema.parse(value);
  await mkdir(userData, { recursive: true });
  const temporary = join(userData, `.setup-state-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(JSON.stringify(state, null, 2) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, join(userData, "setup-state.json"));
  } finally { await rm(temporary, { force: true }); }
}
