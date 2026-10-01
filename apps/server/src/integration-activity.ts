import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { HookHost } from "./hook/capture-assessment.js";

export type HookEvent = "user-prompt-submit" | "post-tool-use" | "stop" | "record";
const keyPattern = /^(hook-(codex|claude)-(user-prompt-submit|post-tool-use|stop|record)|mcp-[A-Za-z0-9._-]{1,64})$/;
export function integrationActivityDirectory(databasePath: string): string {
  return join(dirname(databasePath), "integration-activity");
}
export function mcpClientName(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : "unknown";
}

async function writeActivity(directory: string, key: string, value: { at: string; name?: string }): Promise<void> {
  if (!keyPattern.test(key)) throw new Error("Invalid activity key");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${key}-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value) + "\n"); } finally { await file.close(); }
    await rename(temporary, join(directory, `${key}.json`));
  } finally { await rm(temporary, { force: true }); }
}

export async function recordHookActivity(directory: string, host: HookHost, event: HookEvent): Promise<void> {
  await writeActivity(directory, `hook-${host}-${event}`, { at: new Date().toISOString() });
}

/** Telemetry is optional and cannot fail an MCP request. Never persist request contents. */
export async function recordMcpActivity(directory: string, clientName: unknown): Promise<void> {
  try {
    const name = mcpClientName(clientName);
    await writeActivity(directory, `mcp-${name}`, { at: new Date().toISOString(), name });
  } catch { /* A missing observation is not a connection failure. */ }
}

/** Read-only latest observations, keyed by filename without .json; not proof of current health. */
export async function readIntegrationActivity(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const key = entry.name.replace(/\.json$/, "");
    if (!entry.isFile() || !entry.name.endsWith(".json") || !keyPattern.test(key)) continue;
    let file;
    try {
      file = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 512) continue;
      const bytes = Buffer.alloc(513);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 512) continue;
      const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      if (typeof value !== "object" || value === null || !("at" in value) || typeof value.at !== "string") continue;
      if (new Date(value.at).toISOString() === value.at) result[key] = value.at;
    } catch { /* Ignore incomplete, invalid or concurrently removed observations. */ }
    finally { await file?.close(); }
  }
  return result;
}
