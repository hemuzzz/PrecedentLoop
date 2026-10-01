import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDetection, AgentName } from "../setup-contract.js";
import { integrationItems, integrationStatusSchema, type IntegrationItemStatus, type IntegrationStatus, type StatusRequest } from "./contract.js";
import { hookDocument, hookPath, itemEvents, locateHooks, mcpPath, parseTrust } from "./adapters.js";
import { desiredMatches, managedArtifact, ownerId, readActual, type IntegrationConfiguration } from "./engine.js";
import type { IntegrationEnvironment } from "./environment.js";
import { json, message, object, parseObject, readText } from "./files.js";
import { readLedger, writeLedger, type LedgerArtifact } from "./ledger.js";
import { desiredResources } from "./resources.js";

/** Unknown/revoked/moved trust never becomes trusted just because a hash exists. */
export function evaluateTrust(record: LedgerArtifact, keys: string[], values: Record<string, string> | null): "trusted" | "pending" | "unverified" {
  if (values === null || record.trust === null) return "unverified";
  let trusted = true;
  const snapshots = keys.map(key => {
    const current = values[key] ?? null;
    const previous = record.trust!.find(snapshot => snapshot.key === key);
    if (!previous) { trusted = false; return { key, before: current, accepted: null }; }
    if (previous.accepted !== null) {
      if (current === previous.accepted) return previous;
      trusted = false;
      return { key, before: current, accepted: null };
    }
    if (current !== null && current !== previous.before) return { ...previous, accepted: current };
    trusted = false; return previous;
  });
  if (!keys.length) trusted = false;
  record.trust = snapshots;
  return trusted ? "trusted" : "pending";
}
export async function readActivity(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (!entry.isFile() || !/^(hook-(codex|claude)-(user-prompt-submit|post-tool-use|stop|record)|mcp-[A-Za-z0-9._-]{1,64})\.json$/u.test(entry.name)) continue;
    try {
      const text = await readText(join(directory, entry.name), 512);
      const value: unknown = text === null ? null : JSON.parse(text);
      if (object(value) && typeof value.at === "string" && new Date(value.at).toISOString() === value.at) result[entry.name.slice(0, -5)] = value.at;
    } catch { /* A malformed observation is not a connection/verification failure. */ }
  }
  return result;
}
function latest(values: Array<string | undefined>): string | null { return values.filter((value): value is string => value !== undefined).sort().at(-1) ?? null; }
export async function integrationStatus(env: IntegrationEnvironment, config: IntegrationConfiguration, request: StatusRequest, serviceReady: boolean, detections: AgentDetection[] = []): Promise<IntegrationStatus[]> {
  const choices = integrationStatusSchema.parse(request).choices, ledger = await readLedger(env.userData);
  const before = json(ledger), url = `http://127.0.0.1:${config.port}/mcp`;
  const activity = await readActivity(join(config.dataDirectory, "runtime/integration-activity"));
  const result: IntegrationStatus[] = [];
  for (const agent of ["codex", "claude"] as const) {
    const detection = detections.find(value => value.agent === agent) ?? null;
    const items: IntegrationItemStatus[] = [];
    for (const item of integrationItems) {
      const choice = choices[agent]?.[item] ?? "undecided";
      const status: IntegrationItemStatus = { item, choice, detection: detection ? detection.found ? detection.runnable ? "found" : "failed" : "not-found" : "not-checked",
        configuration: "unconfigured", verification: "unverified", label: choice === "skipped" ? "已跳过" : "未配置", targets: [], reasons: [],
        evidence: { lastTriggered: null, lastConnected: null, installedAt: null, trust: null } };
      items.push(status);
      let external = 0, configured = 0, repair = 0;
      try {
        const resources = await desiredResources(env, agent, item, url);
        for (const resource of resources) {
          status.targets.push(resource.target);
          const record = managedArtifact(ledger, resource), actual = await readActual(env, resource);
          const owned = record?.owners.includes(ownerId(agent, item));
          if (owned && record) {
            status.evidence.installedAt = latest([status.evidence.installedAt ?? undefined, record.installedAt]);
            if (record.hash !== actual.hash || !desiredMatches(resource, actual, url)) { repair++; status.reasons.push(`安装内容缺失、被修改或已过期：${resource.target}`); }
            else configured++;
          } else if (actual.hash !== null && !record) external++;
        }
        status.configuration = repair ? "repair" : configured === resources.length ? "configured" : external ? "external" : configured ? "partial" : "unconfigured";
        if (itemEvents(item).length) {
          const events = itemEvents(item);
          const names = { UserPromptSubmit: "user-prompt-submit", PostToolUse: "post-tool-use", Stop: "stop" };
          status.evidence.lastTriggered = latest(events.map(event => activity[`hook-${agent}-${names[event]}`]));
          // Both reminder events need an observation newer than the installation they verify.
          if (events.every(event => (activity[`hook-${agent}-${names[event]}`] ?? "") >= (status.evidence.installedAt ?? "\uffff"))) status.verification = "verified";
          if (agent === "codex" && status.configuration === "configured") {
            const record = ledger.artifacts[`${agent}:hooks:${item}`];
            if (record) {
              let values: Record<string, string> | null = null;
              try { values = parseTrust(await readText(mcpPath(env, agent))); } catch { /* Trust inspection is optional. */ }
              const locations = locateHooks(hookDocument(await readText(hookPath(env, agent)), hookPath(env, agent)), hookPath(env, agent), events);
              status.evidence.trust = evaluateTrust(record, locations.map(value => value.key), values);
              if (status.evidence.trust === "pending") { status.configuration = "pending-trust"; status.verification = "unverified"; status.reasons.push("请在 Codex /hooks 或桌面版设置中信任条目，再重新检测。"); }
              if (status.evidence.trust === "unverified") status.reasons.push("信任记录无法识别，仅显示最近触发证据。");
            }
          }
          if (agent === "claude") {
            const settings = hookDocument(await readText(hookPath(env, agent)), hookPath(env, agent));
            const managedText = await readText(env.managedSettings);
            const managed = managedText === null ? {} : parseObject(managedText, env.managedSettings);
            if (managed.allowManagedHooksOnly === true) { status.configuration = "policy-disabled"; status.verification = "unverified"; status.reasons.push("被管理策略禁用，需要管理员调整。"); }
            else if (settings.disableAllHooks === true) { status.label = "待处理"; status.verification = "unverified"; status.reasons.push("Claude 设置中已停用全部 Hook。"); }
          }
        } else if (item === "mcp") {
          const known = env.mcpClientNames[agent].filter(name => !env.mcpClientNames[agent === "codex" ? "claude" : "codex"].includes(name));
          status.evidence.lastConnected = latest(known.map(name => activity[`mcp-${name}`]));
          if (status.evidence.lastConnected && status.evidence.installedAt && status.evidence.lastConnected >= status.evidence.installedAt) status.verification = "verified";
          if (!known.length) status.reasons.push("尚无实测确认的 MCP 客户端名称映射，不将未知名称归属此 Agent。");
        }
      } catch (error) { status.verification = "failed"; status.reasons.push(message(error)); }
      if (status.configuration !== "configured" && status.verification === "verified") status.verification = "unverified";
      const failure = ledger.failures[ownerId(agent, item)];
      if (failure) { status.verification = "failed"; status.reasons.push(failure.reason); }
      if (status.configuration === "policy-disabled") status.label = "被策略禁用";
      else if (choice === "enabled" && (status.verification === "failed" || status.detection === "failed")) status.label = "异常";
      else if (status.label === "待处理" || ["pending-trust", "repair"].includes(status.configuration)) status.label = "待处理";
      else if (status.configuration === "external") status.label = "外部已存在";
      else if (status.configuration === "partial") status.label = "部分完成";
      else if (status.configuration === "configured") status.label = status.verification === "verified" ? "正常" : "已配置，未验证";
      // Hook evidence comes from launcher files, independent of the local server.
      if (!serviceReady && item === "mcp") {
        status.verification = "unverified";
        if (status.configuration === "configured") status.label = "等待服务";
        status.reasons.push("等待服务；历史活动不证明当前可用。");
      }
    }
    const selected = items.filter(item => item.choice === "enabled");
    const label = !serviceReady && selected.length ? "等待服务" : !selected.length ? "已跳过" : selected.every(item => ["正常", "已配置，未验证"].includes(item.label)) ? "正常"
      : selected.some(item => ["正常", "已配置，未验证"].includes(item.label)) ? "部分完成" : selected.some(item => item.label === "异常") ? "异常" : "待处理";
    result.push({ agent, detection, label, items });
  }
  if (json(ledger) !== before) await writeLedger(env.userData, ledger);
  return result;
}
