import type { SetupIntegrationBridge } from "../../../desktop/src/setup-contract.js";
import type { AgentDetection, AgentName, IntegrationItem, IntegrationItemStatus, IntegrationOperation, IntegrationPlan, IntegrationProgress, IntegrationResult,
  IntegrationStatus, CodexProject, RegisteredWorkspace, WorkspaceImportPlan, WorkspaceImportPreview } from "./bridge.js";
import { agents, items } from "./integration-presentation.js";

/** Imported only by the DEV mock bridge. Every path/command below is display data. */
export function createMockIntegrations(scenario: string, options: URLSearchParams, getDetections: () => AgentDetection[], serviceReady: () => boolean): SetupIntegrationBridge {
  const configured: Record<AgentName, Set<IntegrationItem>> = { codex: new Set(), claude: new Set() };
  const failures = new Set<string>();
  const complete = ["S3-e", "S3-f", "S4-a", "S4-b", "S4-c", "S4-e", "S5-a"].includes(scenario) || scenario.startsWith("T");
  if (complete) for (const agent of agents) for (const item of items) if (!(scenario === "S4-b" && agent === "claude")) configured[agent].add(item);
  if (scenario === "S3-g") configured.codex.add("mcp");
  if (scenario === "S3-e") { configured.codex.delete("projectContext"); failures.add("codex:projectContext"); }
  if (scenario === "T5-c") configured.claude.clear();
  if (scenario === "T9-c") configured.codex.delete("captureReminder");
  const repairs = new Set<string>(["T4-b", "T4-e"].includes(scenario) ? ["codex:mcp"] : ["T5-b", "T5-d"].includes(scenario) ? ["claude:mcp"] : ["T4-c", "T4-d"].includes(scenario) ? ["codex:projectContext"] : []);
  const modified = new Set<string>(["T4-c", "T4-d"].includes(scenario) ? ["codex:projectContext"] : []);
  let external = scenario === "S3-c" || options.get("conflict") === "codex:mcp", revision = 0, externalChange = options.get("externalChange") === "1";
  let failOnce = options.get("fail");
  const base = "/Users/alex", userData = `${base}/Library/Application Support/PrecedentLoop`;
  // Registered workspaces (append mode): imports add to this list, never replace it.
  const registered: RegisteredWorkspace[] = options.get("workspaces") === "existing" || scenario === "S3-f"
    ? [{ name: "PrecedentLoop", paths: [`${base}/Projects/PrecedentLoop`], aliases: ["知识库项目"], sources: ["claude", "codex"] },
      { name: "demo-api", paths: [`${base}/Projects/demo-api`], aliases: [], sources: ["codex"] }] : [];
  const listeners = new Set<(progress: IntegrationProgress) => void>();
  const plans = new Map<string, { plan: IntegrationPlan; revision: number }>();
  const workspacePlans = new Map<string, WorkspaceImportPlan>();
  let currentList: WorkspaceImportPreview | null = null;
  const installedAt = "2026-09-24T05:00:00.000Z", observedAt = "2026-09-24T06:02:00.000Z";
  function targets(agent: AgentName, item: IntegrationItem): string[] {
    const directory = `${base}/.${agent}`, hook = `${directory}/${agent === "codex" ? "hooks.json" : "settings.json"}`;
    if (item === "mcp") return [agent === "codex" ? `${directory}/config.toml` : `${base}/.claude.json`];
    return [hook, "/Users/alex/.precedent/bin/precedent-hook"];
  }
  const failureReason = "无法写入 /Users/alex/.codex/hooks.json：目录没有写入权限。";
  return {
    onIntegrationProgress: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getIntegrationStatus: async request => agents.map((agent): IntegrationStatus => {
      const detection = getDetections().find(value => value.agent === agent) ?? null;
      const statuses = items.map((item): IntegrationItemStatus => {
        const choice = request.choices?.[agent]?.[item] ?? "undecided";
        const hook = item === "projectContext" || item === "captureReminder";
        const installed = configured[agent].has(item);
        const verified = installed && (scenario === "S4-a" || /^T[45]-[abcde]$/u.test(scenario) || scenario === "T9-c" || options.get("observed") === "1");
        const pending = installed && hook && agent === "codex" && !verified && options.get("trust") !== "trusted";
        const policy = installed && hook && agent === "claude" && options.get("hooks") === "policy";
        const disabled = installed && hook && agent === "claude" && options.get("hooks") === "disabled";
        const failed = failures.has(`${agent}:${item}`);
        const conflict = external && agent === "codex" && item === "mcp";
        const repair = repairs.has(`${agent}:${item}`);
        const label = policy ? "被策略禁用" : failed ? "异常" : repair || pending || disabled ? "待处理" : conflict ? "外部已存在"
          : installed ? item === "mcp" && !serviceReady() ? "等待服务" : verified ? "正常" : "已配置，未验证" : choice === "skipped" ? "已跳过" : "未配置";
        return { item, choice, detection: detection?.found ? "found" : "not-found", configuration: policy ? "policy-disabled" : repair ? "repair" : pending ? "pending-trust" : installed ? "configured" : conflict ? "external" : "unconfigured",
          verification: failed ? "failed" : verified && !policy && !disabled && (item !== "mcp" || serviceReady()) ? "verified" : "unverified", label, targets: targets(agent, item),
          reasons: repair ? [item === "projectContext" ? "Hook 内容与安装记录不同，移除时可保留修改。" : agent === "codex" ? "登记地址：127.0.0.1:18000/mcp · 当前地址：127.0.0.1:18888/mcp。MCP 地址与当前端口不一致。" : "知识库连接已被手动移除，可重新配置。"] : failed ? [failureReason] : policy ? ["被管理策略禁用，需要管理员调整。"] : disabled ? ["Claude 设置中已停用全部 Hook。"] : item === "mcp" && installed && !serviceReady() ? ["本地服务就绪后检测。"] : [],
          evidence: { installedAt: installed ? installedAt : null, lastTriggered: hook && verified ? observedAt : null,
            lastConnected: item === "mcp" && verified ? observedAt : null, trust: hook && agent === "codex" && installed ? pending ? "pending" : "trusted" : null } };
      });
      const chosen = statuses.filter(item => item.choice === "enabled");
      const label = !chosen.length ? "已跳过" : !serviceReady() ? "等待服务" : chosen.every(item => ["正常", "已配置，未验证"].includes(item.label)) ? "正常"
        : chosen.some(item => item.configuration === "configured") ? "部分完成" : "待处理";
      return { agent, detection, label, items: statuses };
    }),
    planIntegrations: async request => {
      const selections = "selections" in request ? request.selections : [request];
      const planId = crypto.randomUUID();
      const plan: IntegrationPlan = { planId, mode: "install", createdAt: new Date().toISOString(), fingerprint: String(revision), items: [], notices: ["开发演示：不会读取或写入本机配置。", "Claude 写入后下一次匹配事件使用新配置。"] };
      for (const selection of selections) for (const item of items.filter(item => selection.items.includes(item))) {
        const conflict = external && selection.agent === "codex" && item === "mcp";
        const preserve = conflict && selection.conflicts?.[item] !== "replace";
        const operations = targets(selection.agent, item).map((target): IntegrationOperation => {
          const repair = repairs.has(`${selection.agent}:${item}`);
          const action = preserve || (configured[selection.agent].has(item) && !repair) ? "none" : conflict || repair || target.endsWith("hooks.json") || target.endsWith("settings.json") ? "modify" : "create";
          const before = conflict || (repair && item === "mcp" && selection.agent === "codex") ? '[mcp_servers.precedent]\nurl = "http://127.0.0.1:18000/mcp"' : "";
          const after = item === "mcp" ? selection.agent === "codex" ? '[mcp_servers.precedent]\nurl = "http://127.0.0.1:18888/mcp"' : '{ "type": "http", "url": "http://127.0.0.1:18888/mcp" }'
            : target.endsWith("/precedent-hook") ? "稳定 Hook 启动器"
              : JSON.stringify({ event: item === "projectContext" ? "UserPromptSubmit" : "PostToolUse / Stop", command: `"$HOME/.precedent/bin/precedent-hook" ${selection.agent} ${item === "projectContext" ? "user-prompt-submit" : "stop"}` }, null, 2);
          return { target, kind: item === "mcp" ? "command" : target.endsWith("/precedent-hook") ? "file" : "hook", action,
            diff: preserve ? `--- ${target}\n+++ ${target}\n ${before.replaceAll("\n", "\n ")}` : action === "none" ? "不修改" : `--- ${target}\n+++ ${target}\n${before ? `-${before.replaceAll("\n", "\n-")}\n` : ""}+${after.replaceAll("\n", "\n+")}`,
            commands: item === "mcp" && action !== "none" ? [selection.agent === "claude"
              ? ["claude", "mcp", "add", "--transport", "http", "--scope", "user", "precedent", "http://127.0.0.1:18888/mcp"]
              : ["codex", "mcp", "add", "precedent", "--url", "http://127.0.0.1:18888/mcp"]] : [],
            backup: action === "modify" ? `${userData}/backups/${planId}/${selection.agent}/${target.split('/').at(-1)}` : null,
            conflict: conflict ? "external" : null, reason: preserve ? "保留现有配置，此文件不修改。" : null };
        });
        plan.items.push({ agent: selection.agent, item, operations, error: null });
      }
      plans.set(planId, { plan: structuredClone(plan), revision });
      return plan;
    },
    applyIntegrations: async ({ planId }) => {
      const stored = plans.get(planId); plans.delete(planId);
      if (externalChange) { externalChange = false; revision++; throw new Error("外部配置已变化，请重新预览"); }
      if (!stored || stored.revision !== revision) throw new Error("外部配置已变化，请重新预览");
      const result: IntegrationResult = { planId, items: [] };
      for (const item of stored.plan.items) {
        listeners.forEach(listener => listener({ planId, agent: item.agent, item: item.item, status: "running", reason: null }));
        const requestedDelay = Number(options.get("delay") ?? (scenario === "S3-d" ? 1600 : 350));
        await new Promise(resolve => setTimeout(resolve, Number.isFinite(requestedDelay) ? Math.min(5000, Math.max(0, requestedDelay)) : 350));
        const failure = failOnce === `${item.agent}:${item.item}`;
        const preserved = item.operations.some(operation => operation.conflict && operation.action === "none");
        if (failure) { failures.add(`${item.agent}:${item.item}`); failOnce = null; }
        else if (!preserved) {
          if (stored.plan.mode === "remove") configured[item.agent].delete(item.item); else configured[item.agent].add(item.item);
          repairs.delete(`${item.agent}:${item.item}`); modified.delete(`${item.agent}:${item.item}`);
          failures.delete(`${item.agent}:${item.item}`); if (item.agent === "codex" && item.item === "mcp") external = false;
        }
        const row: IntegrationResult["items"][number] = { agent: item.agent, item: item.item, status: failure ? "failed" : preserved ? "preserved" : "success",
          reason: failure ? failureReason : preserved ? "外部配置已保留。" : null, backups: item.operations.flatMap(operation => operation.backup ? [operation.backup] : []) };
        result.items.push(row); listeners.forEach(listener => listener({ planId, ...row }));
      }
      revision++; return result;
    },
    planIntegrationRemoval: async request => {
      const plan: IntegrationPlan = { planId: crypto.randomUUID(), mode: "remove", createdAt: new Date().toISOString(), fingerprint: String(revision), items: [], notices: ["开发演示：不会读取或写入本机配置。"] };
      for (const agent of agents.filter(agent => request.agent === "all" || request.agent === agent)) for (const item of request.agent === "all" ? items : request.items) {
        const conflict = modified.has(`${agent}:${item}`);
        const preserve = conflict && !(request.removeModifiedByAgent?.[agent] ?? request.removeModified ?? []).includes(item);
        plan.items.push({ agent, item, error: null, operations: targets(agent, item).map(target => ({ target,
          kind: item === "mcp" ? "command" : "hook", action: preserve || !configured[agent].has(item) ? "none" : "remove",
          diff: preserve || !configured[agent].has(item) ? "不修改" : `--- ${target}\n+++ ${target}\n-${item === "mcp" ? '本产品的 MCP 配置条目' : '本产品的工作流程及注册内容'}`,
          conflict: conflict ? "modified" : null, reason: preserve ? "安装后内容已被修改，需明确选择仍然移除。" : null,
          commands: item === "mcp" && configured[agent].has(item) ? [[agent, "mcp", "remove", ...(agent === "claude" ? ["--scope", "user", "precedent"] : ["precedent"])]] : [],
          backup: preserve || !configured[agent].has(item) ? null : `${userData}/backups/${plan.planId}/${agent}/${target.split('/').at(-1)}` })) });
      }
      plans.set(plan.planId, { plan: structuredClone(plan), revision }); return plan;
    },
    listCodexProjects: async () => {
      const names = new Set(registered.map(value => value.name));
      const candidate = (name: string, sources: Array<"codex" | "claude">, path: string, reason?: string) =>
        ({ name, sources, paths: [{ candidateId: crypto.randomUUID(), path, exists: reason !== "目录不存在", ...(reason ? { reason } : names.has(name) ? { reason: "已登记", registeredAs: name } : {}) }] });
      const projects: CodexProject[] = options.get("workspaces") === "empty" ? [] : [
        candidate("web-app", ["claude", "codex"], `${base}/Projects/web-app`), candidate("infra-scripts", ["codex"], `${base}/Projects/infra-scripts`),
        candidate("资料", ["claude"], `${base}/Desktop/资料`), candidate("old-demo", ["codex"], `${base}/Projects/old-demo`, "目录不存在"),
        candidate("alex", ["claude"], base, "主目录或其上级目录，会匹配所有项目"), candidate("kind-1", ["claude"], `${base}/Projects/web-app/.claude/worktrees/kind-1`, "临时工作副本"),
        ...registered.map(value => candidate(value.name, value.sources, value.paths[0]!)) ];
      currentList = { planId: crypto.randomUUID(), fingerprint: "mock-workspaces", existingCount: registered.length, registered: structuredClone(registered), projects, reason: null };
      return structuredClone(currentList);
    },
    planWorkspaceImport: async ({ listId, candidateIds }) => {
      if (!currentList || currentList.planId !== listId) throw new Error("外部配置已变化，请重新读取");
      const selected = currentList.projects.flatMap(project => project.paths).filter(path => path.exists && !path.reason && candidateIds.includes(path.candidateId));
      if (!selected.length || selected.length !== candidateIds.length) throw new Error("所选项目不是本次列出的可用目录。");
      const plan: WorkspaceImportPlan = { planId: crypto.randomUUID(), fingerprint: "mock-workspaces", target: `${base}/PrecedentLoop/config/workspaces.json`,
        paths: selected.map(path => path.path), diff: JSON.stringify({ workspaces: selected.map(path => ({ name: path.path.split('/').at(-1), paths: [path.path] })) }, null, 2) };
      workspacePlans.set(plan.planId, structuredClone(plan)); return plan;
    },
    importWorkspaces: async ({ planId }) => {
      const plan = workspacePlans.get(planId); workspacePlans.delete(planId);
      if (!plan) throw new Error("外部配置已变化，请重新读取");
      const added = currentList!.projects.filter(project => project.paths.some(path => plan.paths.includes(path.path)));
      registered.push(...added.map(project => ({ name: project.name, paths: project.paths.map(path => path.path), aliases: [], sources: project.sources })));
      return { imported: added.length, paths: plan.paths };
    },
  };
}
