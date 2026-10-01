import { join } from "node:path";
import type { AgentName } from "../setup-contract.js";
import type { IntegrationItem } from "./contract.js";
import type { IntegrationEnvironment } from "./environment.js";
import { desiredHook, hookPath, itemEvents, launcherPath, mcpPath, shellQuote } from "./adapters.js";
import { hash, json, readText, type FileTree, type JsonObject } from "./files.js";

export interface Resource {
  id: string;
  target: string;
  kind: "file" | "directory" | "hook" | "command";
  content: string | FileTree | JsonObject[];
  mode: number;
  hash: string;
  agent: AgentName;
  item: IntegrationItem;
}
export function renderLauncher(template: string, appPath: string): string {
  if (!template.includes("{{APP_PATH}}")) throw new Error("启动器模板缺少 APP_PATH。");
  return template.replaceAll("{{APP_PATH}}", shellQuote(appPath).slice(1, -1));
}
export async function desiredResources(env: IntegrationEnvironment, agent: AgentName, item: IntegrationItem, url: string): Promise<Resource[]> {
  const result: Resource[] = [];
  function add(id: string, target: string, kind: Resource["kind"], content: Resource["content"], mode = 0o600): void {
    result.push({ id, target, kind, content, mode, hash: hash(typeof content === "string" ? content : json(content)), agent, item });
  }
  if (item === "mcp") {
    add(`${agent}:mcp`, mcpPath(env, agent), "command", url);
    return result;
  }
  if (itemEvents(item).length) {
    const template = await readText(join(env.resources, "precedent-hook.sh.template"));
    if (template === null) throw new Error("App 缺少启动器模板。");
    add("launcher", launcherPath(env), "file", renderLauncher(template, env.appPath), 0o755);
    const selected = itemEvents(item);
    const hooks = selected.map(event => desiredHook(env, agent, event));
    add(`${agent}:hooks:${item}`, hookPath(env, agent), "hook", hooks);
    result[result.length - 1]!.hash = hash(json(selected.map((event, i) => ({ event, value: hooks[i] }))));
  }
  return result;
}
