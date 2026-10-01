import { join } from "node:path";
import type { AgentName } from "../setup-contract.js";
import type { IntegrationItem } from "./contract.js";
import type { IntegrationEnvironment } from "./environment.js";
import { runMcp } from "./environment.js";
import { hash, json, object, parseObject, readText, type JsonObject } from "./files.js";

export type EventName = "UserPromptSubmit" | "PostToolUse" | "Stop";
export const events: Record<"projectContext" | "captureReminder", EventName[]> = {
  projectContext: ["UserPromptSubmit"], captureReminder: ["PostToolUse", "Stop"],
};
const eventArguments: Record<EventName, string> = { UserPromptSubmit: "user-prompt-submit", PostToolUse: "post-tool-use", Stop: "stop" };
const trustEvents: Record<EventName, string> = { UserPromptSubmit: "user_prompt_submit", PostToolUse: "post_tool_use", Stop: "stop" };
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const launcherPath = (env: IntegrationEnvironment): string => join(env.home, ".precedent/bin/precedent-hook");
export const hookPath = (env: IntegrationEnvironment, agent: AgentName): string => agent === "codex" ? join(env.codexHome, "hooks.json") : join(env.claudeDirectory, "settings.json");
export const mcpPath = (env: IntegrationEnvironment, agent: AgentName): string => agent === "codex" ? join(env.codexHome, "config.toml") : env.claudeConfig;
export function desiredHook(env: IntegrationEnvironment, agent: AgentName, event: EventName): JsonObject {
  return { ...(event === "PostToolUse" ? { matcher: agent === "codex" ? "Bash|apply_patch" : "Bash|Edit|Write|MultiEdit|NotebookEdit" } : {}),
    hooks: [{ type: "command", command: `${shellQuote(launcherPath(env))} ${agent} ${eventArguments[event]}`,
      timeout: event === "UserPromptSubmit" ? 10 : agent === "codex" ? 1 : 5,
      ...(agent === "codex" && event === "UserPromptSubmit" ? { additionalContextLimit: 8000 } : {}) }] };
}
export function productHook(value: unknown): boolean {
  return object(value) && value.type === "command" && typeof value.command === "string" && value.command.includes("/.precedent/bin/precedent-hook");
}
export function hookDocument(text: string | null, path: string): JsonObject {
  const document = text === null ? {} : parseObject(text, path);
  if (document.hooks !== undefined && !object(document.hooks)) throw new Error(`hooks 必须为对象，已保留原文件：${path}`);
  const hooks = document.hooks as JsonObject | undefined;
  for (const event of ["UserPromptSubmit", "PostToolUse", "Stop"]) {
    const groups = hooks?.[event];
    if (groups !== undefined && (!Array.isArray(groups) || groups.some(group => !object(group) || !Array.isArray(group.hooks) || group.hooks.some(hook => !object(hook))))) {
      throw new Error(`Hook 结构无法安全合并，已保留原文件：${path}`);
    }
  }
  return document;
}
export interface LocatedHook { event: EventName; group: number; index: number; value: JsonObject; key: string }
export function locateHooks(document: JsonObject, path: string, selected: EventName[]): LocatedHook[] {
  const result: LocatedHook[] = [], hooks = document.hooks as JsonObject | undefined;
  for (const event of selected) {
    const groups = (hooks?.[event] ?? []) as JsonObject[];
    groups.forEach((group, g) => (group.hooks as JsonObject[]).forEach((hook, h) => {
      if (productHook(hook)) result.push({ event, group: g, index: h, value: { ...group, hooks: [hook] }, key: `${path}:${trustEvents[event]}:${g}:${h}` });
    }));
  }
  return result;
}
export function hookHash(locations: LocatedHook[]): string | null {
  return locations.length ? hash(json(locations.map(({ event, value }) => ({ event, value })))) : null;
}
/** Remove only individual product commands, retaining sibling commands and all unrelated keys. */
export function mergeHooks(document: JsonObject, selected: EventName[], replacements: JsonObject[]): JsonObject {
  const next = structuredClone(document);
  const hooks = (next.hooks ?? {}) as JsonObject;
  selected.forEach((event, index) => {
    const groups = (hooks[event] ?? []) as JsonObject[];
    const kept: JsonObject[] = [];
    let inserted = false;
    for (const group of groups) {
      const commands = group.hooks as JsonObject[];
      if (!commands.some(productHook)) { kept.push(group); continue; }
      const others = commands.filter(hook => !productHook(hook));
      if (others.length) kept.push({ ...group, hooks: others });
      if (!inserted && replacements[index]) { kept.push(replacements[index]!); inserted = true; }
    }
    if (!inserted && replacements[index]) kept.push(replacements[index]!);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  });
  // Preserve an existing empty hooks object; do not change keys outside the selected events.
  if (Object.keys(hooks).length || next.hooks !== undefined) next.hooks = hooks;
  return next;
}
export interface McpEntry { value: JsonObject; hash: string; url: string | null; http: boolean }
export async function readMcp(env: IntegrationEnvironment, agent: AgentName): Promise<McpEntry | null> {
  let value: JsonObject;
  if (agent === "codex") {
    const result = await runMcp(env, agent, ["mcp", "get", "precedent", "--json"]);
    if (result.code !== 0) {
      if (result.code !== null && /^(?:Error: )?No MCP server named 'precedent' found\.?$/mu.test(result.stderr.trim())) return null;
      throw new Error("Codex MCP 检测失败，无法区分配置缺失与 CLI 错误。");
    }
    value = parseObject(result.stdout, "Codex MCP 返回值");
    if (!object(value.transport) || typeof value.transport.type !== "string") throw new Error("Codex MCP 返回格式无法识别。");
  } else {
    const text = await readText(env.claudeConfig);
    const config = text === null ? {} : parseObject(text, env.claudeConfig);
    if (config.mcpServers !== undefined && !object(config.mcpServers)) throw new Error("Claude 用户级 mcpServers 格式无效。");
    const entry = (config.mcpServers as JsonObject | undefined)?.["precedent"];
    if (entry === undefined) return null;
    if (!object(entry)) throw new Error("Claude 用户级 MCP 条目格式无效。");
    value = entry;
  }
  const transport = agent === "codex" ? value.transport as JsonObject : value;
  return { value, hash: hash(json(value)), url: typeof transport.url === "string" ? transport.url : null,
    http: transport.type === (agent === "codex" ? "streamable_http" : "http") && value.enabled !== false };
}
export function mcpCommands(agent: AgentName, mode: "install" | "remove", url: string, existing: boolean): string[][] {
  const remove = agent === "codex" ? ["mcp", "remove", "precedent"] : ["mcp", "remove", "--scope", "user", "precedent"];
  if (mode === "remove") return existing ? [remove] : [];
  const add = agent === "codex" ? ["mcp", "add", "precedent", "--url", url] : ["mcp", "add", "--transport", "http", "--scope", "user", "precedent", url];
  return existing ? [remove, add] : [add];
}
export function itemEvents(item: IntegrationItem): EventName[] { return item === "projectContext" || item === "captureReminder" ? events[item] : []; }

/** Extract only the documented trust lines. Unknown hooks.state syntax degrades to unverified. */
export function parseTrust(text: string | null): Record<string, string> | null {
  if (text === null) return {};
  const result: Record<string, string> = {};
  let key: string | null = null;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      key = null;
      if (!trimmed.startsWith("[hooks.state.")) { if (/^\[\s*\[?\s*hooks\s*\.\s*state/u.test(trimmed)) return null; continue; }
      const matched = /^\[hooks\.state\.("(?:[^"\\]|\\.)*"|'[^']*')\]\s*(?:#.*)?$/u.exec(trimmed);
      if (!matched) return null;
      try { key = matched[1]!.startsWith('"') ? JSON.parse(matched[1]!) as string : matched[1]!.slice(1, -1); } catch { return null; }
      if (Object.hasOwn(result, key)) return null;
    } else if (key && trimmed && !trimmed.startsWith("#")) {
      const matched = /^trusted_hash\s*=\s*["'](sha256:[A-Za-z0-9]+)["']\s*(?:#.*)?$/u.exec(trimmed);
      if (!matched || Object.hasOwn(result, key)) return null;
      result[key] = matched[1]!;
    } else if (/^hooks\.state\b/u.test(trimmed)) return null;
  }
  return result;
}
