import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { localCommand } from "./agent-detection.js";
import type { AgentName } from "./setup-contract.js";

export interface AiModelOption { id: string; label: string; efforts: string[]; defaultEffort: string | null }
/** What the local CLI currently offers, and what it uses when the app sets nothing. Empty lists mean "unknown": the page falls back to free text. */
export interface AiModelCatalog { models: AiModelOption[]; efforts: string[]; current: { model: string | null; effort: string | null } }
export type AiModelCatalogs = Record<AgentName, AiModelCatalog>;
export interface AiModelSources { home: string; codexHome: string; claudeDirectory: string; claudeExecutable: string | null }

const levelPattern = /^[a-z]{1,16}$/u;
const MAX_FILE = 8 * 1024 * 1024;
async function readSmall(path: string): Promise<string | null> {
  try { return (await stat(path)).size > MAX_FILE ? null : await readFile(path, "utf8"); } catch { return null; }
}
function json(text: string | null): unknown { try { return text === null ? null : JSON.parse(text); } catch { return null; } }
function withCurrent(models: AiModelOption[], current: string | null, efforts: string[]): AiModelOption[] {
  return !current || models.some(model => model.id === current) ? models : [...models, { id: current, label: current, efforts, defaultEffort: null }];
}

const codexCache = z.object({ models: z.array(z.object({
  slug: z.string().min(1).max(256), display_name: z.string().max(256).optional(), visibility: z.string().optional(), priority: z.number().optional(),
  default_reasoning_level: z.string().optional(), supported_reasoning_levels: z.array(z.object({ effort: z.string() }).passthrough()).optional(),
}).passthrough()) }).passthrough();
/** Top-level keys only: values inside [profiles.*] or other tables do not apply to a plain `codex exec`. */
function codexTopLevel(text: string | null, key: string): string | null {
  const top = (text ?? "").split(/^\s*\[/mu)[0]!;
  const value = new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\n]{1,256})"`, "mu").exec(top)?.[1];
  return value ?? null;
}
/** Codex keeps the model picker list in models_cache.json (fetched by the CLI itself); entries marked hidden are not offered. */
export async function codexModelCatalog(codexHome: string): Promise<AiModelCatalog> {
  const parsed = codexCache.safeParse(json(await readSmall(join(codexHome, "models_cache.json"))));
  const models = parsed.success ? parsed.data.models.filter(model => (model.visibility ?? "list") === "list")
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map(model => ({ id: model.slug, label: model.display_name ?? model.slug,
      efforts: (model.supported_reasoning_levels ?? []).map(level => level.effort).filter(level => levelPattern.test(level)),
      defaultEffort: model.default_reasoning_level && levelPattern.test(model.default_reasoning_level) ? model.default_reasoning_level : null })) : [];
  const config = await readSmall(join(codexHome, "config.toml"));
  const current = { model: codexTopLevel(config, "model"), effort: codexTopLevel(config, "model_reasoning_effort") };
  const efforts = [...new Set(models.flatMap(model => model.efforts))];
  return { models: withCurrent(models, current.model, efforts), efforts, current };
}

/** Claude Code has no model listing command; its --help names the model aliases and effort levels of the installed version. */
export function parseClaudeHelp(help: string): { models: string[]; efforts: string[] } {
  const text = help.replace(/\s+/gu, " ");
  const efforts = /--effort <level> [^(]*\(([^)]*)\)/u.exec(text)?.[1]?.split(",").map(value => value.trim()).filter(value => levelPattern.test(value)) ?? [];
  const example = /--model <model> .*?\(e\.g\. ([^)]*)\)/u.exec(text)?.[1] ?? "";
  const models = [...example.matchAll(/'([a-z][a-z0-9.-]{0,63})'/gu)].map(match => match[1]!);
  return { models: [...new Set(models)], efforts: [...new Set(efforts)] };
}
export async function claudeModelCatalog(claudeDirectory: string, executable: string | null, home: string): Promise<AiModelCatalog> {
  const help = executable ? await localCommand(executable, ["--help"], home) : null;
  const parsed = help?.code === 0 ? parseClaudeHelp(help.output) : { models: [], efforts: [] };
  const settings = json(await readSmall(join(claudeDirectory, "settings.json")));
  const field = (key: string, pattern: RegExp): string | null => {
    const value = typeof settings === "object" && settings !== null ? (settings as Record<string, unknown>)[key] : undefined;
    return typeof value === "string" && pattern.test(value) ? value : null;
  };
  const current = { model: field("model", /^[\w.[\]-]{1,256}$/u), effort: field("effortLevel", levelPattern) };
  const models = parsed.models.map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1), efforts: parsed.efforts, defaultEffort: null }));
  return { models: withCurrent(models, current.model, parsed.efforts), efforts: parsed.efforts, current };
}
export async function readAiModelCatalogs(sources: AiModelSources): Promise<AiModelCatalogs> {
  const [codex, claude] = await Promise.all([codexModelCatalog(sources.codexHome), claudeModelCatalog(sources.claudeDirectory, sources.claudeExecutable, sources.home)]);
  return { codex, claude };
}
