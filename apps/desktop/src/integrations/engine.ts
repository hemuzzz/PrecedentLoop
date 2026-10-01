import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentName } from "../setup-contract.js";
import { integrationItems, integrationPlanSchema, integrationRemoveSchema, type IntegrationOperation, type IntegrationPlan, type IntegrationPlanItem, type IntegrationProgress, type IntegrationResult, type PlanRequest, type RemoveRequest } from "./contract.js";
import { hookDocument, hookHash, itemEvents, locateHooks, mcpCommands, mcpPath, mergeHooks, parseTrust, readMcp, type McpEntry } from "./adapters.js";
import { runMcp, type IntegrationEnvironment } from "./environment.js";
import { atomicWrite, hash, json, message, pathHash, readBytes, readText, readTree, safeParents, writeTree, type FileTree, type JsonObject } from "./files.js";
import { readLedger, writeLedger, type Ledger, type LedgerArtifact } from "./ledger.js";
import { desiredResources, type Resource } from "./resources.js";

interface Actual { hash: string | null; text: string | null; mode: number | null; mcp: McpEntry | null }
interface Operation { resource: Resource; preview: IntegrationOperation; actual: Actual; preserve: boolean; context: string }
interface PlanItem { preview: IntegrationPlanItem; operations: Operation[] }
interface StoredPlan { preview: IntegrationPlan; items: PlanItem[]; paths: string[]; mcpAgents: AgentName[]; url: string }
export interface IntegrationConfiguration { port: number; dataDirectory: string }
export const ownerId = (agent: AgentName, item: string): string => `${agent}:${item}`;
const changedMessage = "外部配置已变化，请重新预览";
export function managedArtifact(ledger: Ledger, resource: Resource): LedgerArtifact | undefined {
  const record = ledger.artifacts[resource.id];
  if (record && (record.target !== resource.target || record.kind !== resource.kind)) throw new Error("集成账本目标与当前环境不一致，请核对安装位置。");
  return record;
}
export async function readActual(env: IntegrationEnvironment, resource: Resource): Promise<Actual> {
  if (resource.kind === "command") {
    const mcp = await readMcp(env, resource.agent);
    return { hash: mcp?.hash ?? null, text: null, mode: null, mcp };
  }
  if (resource.kind === "directory") {
    const tree = await readTree(resource.target);
    return { hash: tree ? hash(json(tree)) : null, text: tree ? Object.keys(tree).join("\n") : null, mode: null, mcp: null };
  }
  const text = await readText(resource.target);
  if (resource.kind === "hook") {
    const document = hookDocument(text, resource.target);
    const found = locateHooks(document, resource.target, itemEvents(resource.item));
    return { hash: hookHash(found), text: json(found.map(item => ({ event: item.event, value: item.value }))), mode: null, mcp: null };
  }
  return { hash: text === null ? null : hash((await readBytes(resource.target))!), text, mode: text === null ? null : (await lstat(resource.target)).mode & 0o777, mcp: null };
}
export function desiredMatches(resource: Resource, actual: Actual, url: string): boolean {
  if (resource.kind === "command") return actual.mcp?.http === true && actual.mcp.url === url;
  return resource.hash === actual.hash && (resource.id !== "launcher" || actual.mode === 0o755);
}
function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

export class IntegrationEngine {
  private readonly plans = new Map<string, StoredPlan>();
  private busy = false;
  constructor(readonly env: IntegrationEnvironment, readonly configuration: () => Promise<IntegrationConfiguration>,
    private readonly appConfigTransition?: { before: string; after: string }) {}

  async plan(request: PlanRequest): Promise<IntegrationPlan> {
    const input = integrationPlanSchema.parse(request);
    return this.createPlan("install", "selections" in input ? input.selections : [input], {});
  }
  async planRemoval(request: RemoveRequest): Promise<IntegrationPlan> {
    const input = integrationRemoveSchema.parse(request);
    // “all” always means all four items of both hosts, including shared launcher cleanup.
    const agents: AgentName[] = input.agent === "all" ? ["codex", "claude"] : [input.agent];
    return this.createPlan("remove", agents.map(agent => ({ agent, items: input.agent === "all" ? [...integrationItems] : input.items })),
      Object.fromEntries(agents.map(agent => [agent, input.removeModifiedByAgent?.[agent] ?? input.removeModified])));
  }
  private async fingerprint(paths: string[], mcpAgents: AgentName[], url: string, preparing = false): Promise<string> {
    const files = await Promise.all(paths.sort().map(async path => {
      if (preparing && this.appConfigTransition && path === join(this.env.userData, "app-config.json")) {
        if (await readText(path) !== this.appConfigTransition.before) throw new Error(changedMessage);
        return [path, hash(`${0o600}:${hash(this.appConfigTransition.after)}`)];
      }
      try { return [path, await pathHash(path)]; } catch (error) { return [path, `unavailable:${message(error)}`]; }
    }));
    const mcp = await Promise.all(mcpAgents.map(async agent => {
      try { return [agent, (await readMcp(this.env, agent))?.hash ?? "missing"]; } catch (error) { return [agent, `unavailable:${message(error)}`]; }
    }));
    const config = await this.configuration();
    return hash(json({ files, mcp, config, url, appPath: this.env.appPath, executables: this.env.executables }));
  }
  private async createPlan(mode: "install" | "remove", selections: Array<{ agent: AgentName; items: Array<typeof integrationItems[number]>; conflicts?: Partial<Record<typeof integrationItems[number], "preserve" | "replace">> }>, removeModified: Partial<Record<AgentName, Array<typeof integrationItems[number]>>>): Promise<IntegrationPlan> {
    if (this.busy) throw new Error("集成操作进行中，请稍后重试。");
    const config = await this.configuration(), url = `http://127.0.0.1:${config.port}/mcp`;
    const ledger = await readLedger(this.env.userData);
    const planId = randomUUID(), createdAt = this.env.now().toISOString();
    const backupRoot = join(this.env.userData, "backups", `${createdAt.replace(/[:.]/gu, "-")}-${planId}`);
    const paths = new Set([join(this.env.userData, "integrations.json"), join(this.env.userData, "app-config.json"), join(this.env.userData, "setup-state.json"), this.env.resources]);
    const mcpAgents: AgentName[] = [], items: PlanItem[] = [];
    const removing = new Set(selections.flatMap(selection => selection.items.map(item => ownerId(selection.agent, item))));
    const projected = new Set<string>();
    const specifications = new Map<string, Resource[] | Error>();
    for (const { agent, items: selected } of selections) for (const item of selected) {
      if (agent === "codex") paths.add(mcpPath(this.env, "codex"));
      if (item === "mcp") mcpAgents.push(agent);
      try {
        const resources = await desiredResources(this.env, agent, item, url);
        // Remove consumers before their protocol/launcher dependencies; a failed consumer
        // removal must not leave a still-installed Hook without its launcher.
        if (mode === "remove") resources.reverse();
        specifications.set(ownerId(agent, item), resources);
        for (const resource of resources) paths.add(resource.target);
      } catch (error) { specifications.set(ownerId(agent, item), new Error(message(error))); }
    }
    const initialFingerprint = await this.fingerprint([...paths], [...new Set(mcpAgents)], url, true);
    if (json(await readLedger(this.env.userData)) !== json(ledger)) throw new Error(changedMessage);
    const lastRemovalOwner = new Map<string, string>();
    if (mode === "remove") for (const { agent, items: selected } of selections) for (const item of integrationItems.filter(value => selected.includes(value))) {
      const resources = specifications.get(ownerId(agent, item));
      if (resources instanceof Error || !resources) continue;
      for (const resource of resources) if (ledger.artifacts[resource.id]?.owners.includes(ownerId(agent, item))) lastRemovalOwner.set(resource.id, ownerId(agent, item));
    }
    for (const selection of selections) for (const item of integrationItems.filter(value => selection.items.includes(value))) {
      const preview: IntegrationPlanItem = { agent: selection.agent, item, operations: [], error: null };
      const planned: PlanItem = { preview, operations: [] }; items.push(planned);
      try {
        const resources = specifications.get(ownerId(selection.agent, item))!;
        if (resources instanceof Error) throw resources;
        for (const resource of resources) {
          const record = managedArtifact(ledger, resource), actual = await readActual(this.env, resource);
          const own = ownerId(selection.agent, item);
          let preserve = false, reason: string | null = null, conflict: IntegrationOperation["conflict"] = null;
          let action: IntegrationOperation["action"] = "none";
          if (mode === "install") {
            if (actual.hash !== null && !record) {
              conflict = "external";
              preserve = selection.conflicts?.[item] !== "replace";
              reason = preserve ? "外部已存在，保留现有配置，未由本产品管理。" : "按明确选择替换整个同名条目或目录。";
            }
            if (!preserve && !desiredMatches(resource, actual, url)) action = actual.hash === null ? "create" : "modify";
          } else {
            if (!record || !record.owners.includes(own)) { preserve = true; reason = "没有本产品的安装记录，保留现有内容。"; }
            else if (record.owners.some(owner => !removing.has(owner))) { reason = "其他接入项仍在使用，保留共享文件。"; }
            else if (lastRemovalOwner.get(resource.id) !== own) { reason = "由本计划中最后一个使用项移除共享文件。"; }
            else if (actual.hash !== null) {
              if (actual.hash !== record.hash || (resource.id === "launcher" && actual.mode !== 0o755)) {
                conflict = "modified"; preserve = !removeModified[selection.agent]?.includes(item);
                reason = preserve ? "安装后内容已被修改，需明确选择仍然移除。" : "已明确选择仍然移除本产品内容。";
              }
              if (!preserve) action = "remove";
            }
          }
          if (mode === "install" && projected.has(resource.id)) { action = "none"; reason = "与本计划中的其他接入项共用，随依赖项处理。"; }
          if (!preserve && action !== "none") projected.add(resource.id);
          const backup = action !== "none" && await pathHash(resource.target) !== "missing"
            ? join(backupRoot, selection.agent, item, resource.id.replaceAll(":", "-"), basename(resource.target)) : null;
          const commands = resource.kind === "command" && action !== "none" ? mcpCommands(selection.agent, mode, url, actual.hash !== null) : [];
          // Show every removed MCP field, but never echo credentials, headers, env or
          // executable arguments from an external server in a renderer preview.
          const before = resource.kind === "command" ? (actual.mcp ? JSON.stringify(actual.mcp.value, (key, value: unknown) => {
            if (key === "" || key === "transport" || ["name", "type", "enabled"].includes(key) || value === null) return value;
            if (key === "url" && typeof value === "string") {
              try { const endpoint = new URL(value); endpoint.username = ""; endpoint.password = ""; endpoint.search = ""; endpoint.hash = ""; return endpoint.href; }
              catch { return "<无法识别的地址>"; }
            }
            return "<内容隐藏；替换会移除整个字段>";
          }, 2) : "") : actual.text ?? "";
          const after = mode === "remove" ? "" : resource.kind === "command"
            ? json(selection.agent === "codex" ? { name: "precedent", enabled: true, transport: { type: "streamable_http", url } } : { type: "http", url })
            : typeof resource.content === "string" ? resource.content : resource.kind === "directory" ? Object.keys(resource.content).join("\n") : json(resource.content);
          const beforeSnippet = resource.kind === "command" ? before : before.slice(0, 2400);
          const context = `--- ${resource.target}\n+++ ${resource.target}\n ${beforeSnippet.replaceAll("\n", "\n ")}`;
          const operation: IntegrationOperation = { target: resource.target, kind: resource.kind, action, commands: commands.map(args => [this.env.executables[selection.agent] ?? selection.agent, ...args]), backup, conflict, reason,
            diff: action === "none" ? "不修改" : `--- ${resource.target}\n+++ ${resource.target}\n-${beforeSnippet.replaceAll("\n", "\n-")}\n+${after.slice(0, 2400).replaceAll("\n", "\n+")}` };
          preview.operations.push(operation); planned.operations.push({ resource, preview: operation, actual, preserve, context });
        }
      } catch (error) { preview.error = message(error); }
      if (preview.error || (mode === "install" && planned.operations.some(operation => operation.preserve))) {
        for (const operation of planned.operations) {
          operation.preserve = true;
          operation.preview.action = "none"; operation.preview.commands = []; operation.preview.backup = null;
          operation.preview.diff = operation.preview.conflict === "external" ? operation.context : "不修改";
          operation.preview.reason ??= preview.error ?? "此接入项的依赖存在外部内容，整项保留；替换需重新预览。";
          projected.delete(operation.resource.id);
        }
      }
    }
    const fingerprint = await this.fingerprint([...paths], [...new Set(mcpAgents)], url, true);
    if (fingerprint !== initialFingerprint) throw new Error(changedMessage);
    const preview: IntegrationPlan = { planId, mode, createdAt, fingerprint, items: items.map(item => item.preview), notices: [
      "不会卸载 Codex 或 Claude Code，不会改动其他配置。",
      ...(selections.some(value => value.agent === "claude" && value.items.some(item => itemEvents(item).length)) ? ["Claude Hook 写入后，下次匹配事件即可生效。"] : []),
    ] };
    // Bound outstanding previews, and consume a plan on every execution attempt.
    if (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(planId, freeze({ preview, items, paths: [...paths], mcpAgents: [...new Set(mcpAgents)], url }));
    return freeze(structuredClone(preview));
  }

  /** Validate the frozen external state before an explicitly previewed port write.
   * apply() subsequently requires the exact resulting app-config bytes. */
  async validatePendingConfiguration(planId: string): Promise<void> {
    const plan = this.plans.get(planId);
    if (!plan || await this.fingerprint([...plan.paths], plan.mcpAgents, plan.url, true) !== plan.preview.fingerprint) throw new Error(changedMessage);
  }

  async apply(planId: string, onProgress?: (progress: IntegrationProgress) => void): Promise<IntegrationResult> {
    if (this.busy) throw new Error("集成操作进行中，请稍后重试。");
    const plan = this.plans.get(planId);
    if (!plan) throw new Error("计划不存在或已失效，请重新预览。");
    this.plans.delete(planId); this.busy = true;
    try {
      // No backups, ledger writes or CLI mutations before the whole-plan check.
      if (await this.fingerprint([...plan.paths], plan.mcpAgents, plan.url) !== plan.preview.fingerprint) throw new Error(changedMessage);
      const ledger = await readLedger(this.env.userData);
      const result: IntegrationResult = { planId, items: [] };
      const notify = (progress: IntegrationProgress) => {
        try { onProgress?.(progress); } catch { /* A closed renderer cannot interrupt confirmed writes. */ }
      };
      for (const item of plan.items) {
        notify({ planId, agent: item.preview.agent, item: item.preview.item, status: "running", reason: null });
        const backups: string[] = [], errors: string[] = [];
        let succeeded = 0, preserved = 0;
        if (item.preview.error) errors.push(item.preview.error);
        else for (const operation of item.operations) {
          if (operation.preserve) { preserved++; continue; }
          try {
            await this.applyOperation(plan, operation, ledger, backups);
            succeeded++;
          } catch (error) { errors.push(message(error)); break; }
        }
        const owner = ownerId(item.preview.agent, item.preview.item);
        if (errors.length) ledger.failures[owner] = { at: this.env.now().toISOString(), reason: errors.join("；") };
        else delete ledger.failures[owner];
        // Persist individual success and failure facts; a failed item never rolls back others.
        try { await writeLedger(this.env.userData, ledger); }
        catch (error) { errors.push(`账本保存失败：${message(error)}`); }
        result.items.push({ agent: item.preview.agent, item: item.preview.item,
          status: errors.length ? succeeded ? "partial" : "failed" : preserved ? succeeded ? "partial" : "preserved" : "success",
          reason: errors.length ? errors.join("；") : preserved ? "部分或全部外部内容按选择保留。" : null, backups });
        const completed = result.items.at(-1)!;
        notify({ planId, agent: completed.agent, item: completed.item, status: completed.status, reason: completed.reason });
      }
      return result;
    } finally { this.busy = false; }
  }

  private async applyOperation(plan: StoredPlan, operation: Operation, ledger: Ledger, backups: string[]): Promise<void> {
    const { resource } = operation, owner = ownerId(resource.agent, resource.item);
    const record = managedArtifact(ledger, resource);
    let actual = await readActual(this.env, resource);
    const removing = plan.preview.mode === "remove";
    // Shared resources are attached only after they are present; a failed earlier item may not create them.
    let change = removing ? operation.preview.action === "remove" : !desiredMatches(resource, actual, plan.url);
    if (removing && record?.owners.some(value => value !== owner)) {
      // Delete at the last successful consumer removal, not at the first previewed consumer.
      record.owners = record.owners.filter(value => value !== owner);
      await writeLedger(this.env.userData, ledger); return;
    }
    if (change) {
      await safeParents(resource.target);
      const backup = operation.preview.backup ?? (await pathHash(resource.target) !== "missing"
        ? join(this.env.userData, "backups", `${plan.preview.createdAt.replace(/[:.]/gu, "-")}-${plan.preview.planId}`, resource.agent, resource.item, resource.id.replaceAll(":", "-"), basename(resource.target)) : null);
      if (backup) {
        await safeParents(backup); await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
        await cp(resource.target, backup, { recursive: resource.kind === "directory", errorOnExist: true, force: false, dereference: false });
        backups.push(backup);
      }
      if (resource.kind === "command") {
        for (const args of mcpCommands(resource.agent, plan.preview.mode, plan.url, actual.hash !== null)) {
          const result = await runMcp(this.env, resource.agent, args);
          if (result.code !== 0) throw new Error(`${resource.agent} MCP ${args[1]} 失败或超时；已保留备份。`);
        }
      } else if (resource.kind === "hook") {
        // Re-read after earlier item writes: captureReminder and projectContext share one JSON file.
        const document = hookDocument(await readText(resource.target), resource.target);
        const merged = mergeHooks(document, itemEvents(resource.item), removing ? [] : resource.content as JsonObject[]);
        if (!removing && resource.agent === "codex") {
          const values = parseTrust(await readText(mcpPath(this.env, "codex")));
          const located = locateHooks(merged, resource.target, itemEvents(resource.item));
          // Persist the pre-write snapshot before the Hook is made visible to the host.
          ledger.artifacts[resource.id] = { target: resource.target, kind: resource.kind, hash: resource.hash, owners: [...new Set([...(record?.owners ?? []), owner])],
            installedAt: this.env.now().toISOString(), backups: [...(record?.backups ?? []), ...backups],
            trust: values === null ? null : located.map(hook => ({ key: hook.key, before: values[hook.key] ?? null, accepted: null })) };
          await writeLedger(this.env.userData, ledger);
        }
        await atomicWrite(resource.target, json(merged));
      } else if (removing) await rm(resource.target, { recursive: resource.kind === "directory", force: true });
      else if (resource.kind === "directory") await writeTree(resource.target, resource.content as FileTree);
      else await atomicWrite(resource.target, resource.content as string, resource.mode);
      actual = await readActual(this.env, resource);
      if (removing ? actual.hash !== null : !desiredMatches(resource, actual, plan.url)) throw new Error("写入后核对失败，请重新检测；备份已保留。");
    }
    if (removing) delete ledger.artifacts[resource.id];
    else {
      const currentRecord = ledger.artifacts[resource.id];
      ledger.artifacts[resource.id] = { target: resource.target, kind: resource.kind, hash: actual.hash!,
        owners: [...new Set([...(currentRecord?.owners ?? []), owner])], installedAt: change ? this.env.now().toISOString() : currentRecord?.installedAt ?? this.env.now().toISOString(),
        backups: [...new Set([...(currentRecord?.backups ?? []), ...backups])], trust: currentRecord?.trust ?? null };
    }
    await writeLedger(this.env.userData, ledger);
  }
}
