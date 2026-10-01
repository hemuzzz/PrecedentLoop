import type { SettingsBridge } from "./bridge.js";
import type { SettingsApi, SettingsWorkspace } from "./data.js";
import type { AiConfiguration, AiOverrides } from "../api/types.js";
import type { DataMovePlan, LocalSettings, PortChangePlan } from "../../../desktop/src/settings-contract.js";
import type { WorkspaceImportPlan, WorkspaceImportPreview } from "../setup/bridge.js";

let api: SettingsApi | undefined;
export const getMockSettingsApi = () => api;
type LocalBridge = Pick<SettingsBridge, "getLocalSettings" | "revealSettingsPath" | "listAiModels" | "saveAiSettings" | "savePort" | "planPortChange" | "applyPortChange" | "restoreDefaults" | "exportDiagnostics" | "planDataMove" | "applyDataMove" | "listCodexProjects" | "planWorkspaceImport" | "importWorkspaces">;
/** Loaded only through DEV dynamic imports. All state is in memory. */
export function createLocalSettingsMock(scenario: string, options: URLSearchParams, integration: Pick<SettingsBridge, "planIntegrations">): LocalBridge {
  const directory = "/Users/alex/PrecedentLoop";
  const local: LocalSettings = { dataDirectory: directory, paths: { assetRepositoryPath: `${directory}/repository`, databasePath: `${directory}/runtime/precedent-loop.sqlite`, workspaceConfigPath: `${directory}/config/workspaces.json`, logPath: `${directory}/logs/server.log`, desktopLogPath: `${directory}/logs/desktop.log` }, storageVersion: 1,
    runtime: { nodeVersion: "v22.16.0", arch: "arm64", modules: "127" }, port: 18888, pendingPort: ["T8-b", "T8-d"].includes(scenario) ? 18889 : null, lastRestart: null, lastDataMove: null };
  let overrides: AiOverrides = {};
  const defaults: AiConfiguration["defaults"] = [{ id: "codex", executable: "/opt/homebrew/bin/codex", timeoutMs: 600000 }, { id: "claude", executable: "/Users/alex/.local/bin/claude", timeoutMs: 600000 }];
  const projects: SettingsWorkspace[] = [{ name: "web-app", paths: ["/Users/alex/Projects/web-app"], aliases: ["前端项目"], description: "产品前端与用户界面" }, { name: "infra-scripts", paths: ["/Users/alex/Projects/infra-scripts"], aliases: ["运维脚本"], description: "本地基础设施脚本" }];
  api = {
    storage: async () => ({ managed: true, pending: 5 }), workspaces: async () => structuredClone(projects),
    aiSettings: async () => ({ defaults: structuredClone(defaults), overrides: structuredClone(overrides), defaultProvider: overrides.defaultProvider ?? "codex", providers: defaults.map(provider => { const override = overrides.providers?.[provider.id]; return { ...provider, ...override, timeoutMs: override?.timeoutMs ?? provider.timeoutMs }; }) }),
    testAi: async () => { await new Promise(resolve => setTimeout(resolve, 700)); return scenario === "T6-e" ? { success: false, durationMs: 600000, error: { code: "AI_TIMEOUT", message: "请求在 600 秒内未完成。请检查 CLI 状态或调整超时后重试。" } } : { success: true, durationMs: 1200 }; },
  };
  let list: WorkspaceImportPreview | undefined, workspacePlan: WorkspaceImportPlan | undefined, portPlan: PortChangePlan | undefined, movePlan: DataMovePlan | undefined;
  // DEV parameters: move=invalid (unusable location), move=sync (sync drive), move=fail (copy failure).
  const moveOption = options.get("move");
  return {
    getLocalSettings: async () => structuredClone(local), revealSettingsPath: async () => {},
    listAiModels: async () => {
      const codexLevels = ["low", "medium", "high", "xhigh", "max"], claudeLevels = ["low", "medium", "high", "xhigh", "max"];
      return { codex: { models: [{ id: "gpt-6-astra", label: "GPT-6-Astra", efforts: [...codexLevels, "ultra"], defaultEffort: "medium" }, { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: codexLevels, defaultEffort: "medium" }],
        efforts: [...codexLevels, "ultra"], current: { model: "gpt-6-astra", effort: "medium" } },
      claude: { models: ["fable", "opus", "sonnet"].map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1), efforts: claudeLevels, defaultEffort: null })),
        efforts: claudeLevels, current: { model: "opus", effort: null } } };
    },
    saveAiSettings: async ({ ai }) => { overrides = structuredClone(ai); },
    savePort: async ({ port }) => { local.pendingPort = port === local.port ? null : port; return structuredClone(local); },
    restoreDefaults: async () => { overrides = {}; local.pendingPort = local.port === 18888 ? null : 18888; return structuredClone(local); },
    exportDiagnostics: async () => ({ path: "/Users/alex/Desktop/PrecedentLoop-diagnostics.json（演示，未写入）" }),
    planDataMove: async ({ mode }) => {
      const to = mode === "migrate" ? (moveOption === "sync" ? "/Users/alex/Library/CloudStorage/Drive/PrecedentLoop" : "/Volumes/Data/PrecedentLoop") : "/Users/alex/Archive/PrecedentLoop";
      const reason = moveOption === "invalid" ? (mode === "migrate" ? "迁移目标必须是不存在或空的目录；已有知识库请使用“关联其他数据目录”。" : "请选择存储版本 6 的已有本产品数据目录；关联不会创建或覆盖文件。") : null;
      movePlan = { planId: reason ? null : crypto.randomUUID(), mode, from: local.dataDirectory, to, syncRisk: moveOption === "sync",
        statistics: reason ? {} : { assets: 46, candidates: 5, workspaces: 2 }, reason };
      return structuredClone(movePlan);
    },
    applyDataMove: async ({ planId, syncRiskConfirmed }) => {
      if (!movePlan || movePlan.planId !== planId) throw new Error("迁移计划已失效，请重新选择位置。");
      if (movePlan.syncRisk && !syncRiskConfirmed) throw new Error("请先确认同步盘风险。");
      await new Promise(resolve => setTimeout(resolve, 900));
      const { mode, from, to } = movePlan; movePlan = undefined;
      local.lastDataMove = moveOption === "fail"
        ? { mode, from, to, status: "failed", reason: "复制并校验数据失败：数据目录包含符号链接或特殊文件，未迁移：repository/link.md；数据目录未切换，已保留原目录，新位置中已复制的文件可自行删除。（演示）" }
        : { mode, from, to, status: "success", ...(mode === "migrate" ? { files: 412, bytes: 18_874_368 } : {}),
          reason: mode === "migrate" ? "迁移完成。旧目录已保留，确认数据无误后可自行删除。（演示）" : "已关联新的数据目录。原知识库文件保留在原位置。（演示）" };
      if (local.lastDataMove.status === "success") {
        local.dataDirectory = to;
        local.paths = { assetRepositoryPath: `${to}/repository`, databasePath: `${to}/runtime/precedent-loop.sqlite`, workspaceConfigPath: `${to}/config/workspaces.json`, logPath: `${to}/logs/server.log`, desktopLogPath: `${to}/logs/desktop.log` };
      }
      return structuredClone(local.lastDataMove);
    },
    planPortChange: async ({ repairMcp }) => {
      if (!local.pendingPort) throw new Error("没有待生效的端口修改。");
      const planned = repairMcp ? await integration.planIntegrations({ selections: [{ agent: "codex", items: ["mcp"], conflicts: { mcp: "replace" } }, { agent: "claude", items: ["mcp"], conflicts: { mcp: "replace" } }] }) : null;
      if (planned) for (const item of planned.items) for (const operation of item.operations) {
        const old = `http://127.0.0.1:${local.port}/mcp`, next = `http://127.0.0.1:${local.pendingPort}/mcp`;
        operation.action = "modify";
        operation.diff = item.agent === "codex" ? `--- ${operation.target}\n+++ ${operation.target}\n-[mcp_servers.precedent]\n-url = "${old}"\n+[mcp_servers.precedent]\n+url = "${next}"` : `--- Claude 用户级 MCP\n+++ Claude 用户级 MCP\n-${JSON.stringify({ type: 'http', url: old })}\n+${JSON.stringify({ type: 'http', url: next })}`;
        operation.commands = item.agent === "codex" ? [[defaults[0]!.executable, "mcp", "remove", "precedent"], [defaults[0]!.executable, "mcp", "add", "precedent", "--url", next]] : [[defaults[1]!.executable, "mcp", "remove", "--scope", "user", "precedent"], [defaults[1]!.executable, "mcp", "add", "--transport", "http", "--scope", "user", "precedent", next]];
      }
      portPlan = { planId: crypto.randomUUID(), from: local.port, to: local.pendingPort, target: "/Users/alex/Library/Application Support/PrecedentLoop/app-config.json", diff: `-  "port": ${local.port}\n+  "port": ${local.pendingPort}`, integration: planned };
      return structuredClone(portPlan);
    },
    applyPortChange: async ({ planId }) => {
      if (!portPlan || planId !== portPlan.planId) throw new Error("请重新预览");
      if (options.get("portFailure") === "occupied") throw new Error("新端口已被占用；原配置与服务已保留。");
      if (options.get("portFailure") === "startup") local.lastRestart = { port: local.port, status: "rolled-back", reason: "演示：新端口启动失败，已恢复原端口。", integration: null };
      else {
        local.port = portPlan.to; local.pendingPort = null;
        local.lastRestart = { port: local.port, status: "success", reason: options.get("portFailure") === "mcp" ? "端口已生效；Claude MCP 需要修复。" : null, integration: portPlan.integration ? { planId: portPlan.integration.planId, items: portPlan.integration.items.map(item => ({ agent: item.agent, item: "mcp", status: item.agent === "claude" && options.get("portFailure") === "mcp" ? "failed" : "success", reason: null, backups: [] })) } : null };
      }
      portPlan = undefined; return structuredClone(local.lastRestart);
    },
    listCodexProjects: async () => {
      const c = (name: string, sources: Array<"codex" | "claude">, path: string, reason?: string) => ({ name, sources, paths: [{ path, exists: reason !== "目录不存在", candidateId: crypto.randomUUID(), ...(reason ? { reason } : {}) }] });
      list = { planId: crypto.randomUUID(), fingerprint: "dev-fixture", existingCount: projects.length, reason: null,
        registered: projects.map(value => ({ name: value.name, paths: value.paths, aliases: value.aliases, sources: ["codex"] as Array<"codex" | "claude"> })),
        projects: [
          c("api-service", ["claude", "codex"], "/Users/alex/Projects/api-service"), c("docs", ["claude"], "/Users/alex/Projects/docs"),
          c("web-app", ["codex"], "/Users/alex/Other/web-app", "已登记"), c("nested", ["claude"], "/Users/alex/Projects/web-app/src", "已登记"),
          c("global", ["codex"], "/Users/alex/Projects/global", "global 是保留名称，无法登记"), c("archived", ["codex"], "/Users/alex/Projects/archived", "目录不存在"),
        ] };
      return structuredClone(list);
    },
    planWorkspaceImport: async ({ listId, candidateIds }) => {
      if (list?.planId !== listId) throw new Error("请重新预览");
      const workspaces = list.projects.filter(project => project.paths.some(path => candidateIds.includes(path.candidateId) && !path.reason)).map(project => ({ name: project.name, paths: project.paths.map(path => path.path) }));
      workspacePlan = { planId: crypto.randomUUID(), fingerprint: "dev-fixture", paths: workspaces.flatMap(value => value.paths), target: local.paths.workspaceConfigPath, diff: JSON.stringify({ workspaces }, null, 2) }; return structuredClone(workspacePlan);
    },
    importWorkspaces: async ({ planId }) => {
      if (options.get("changed") === "1") throw new Error("外部配置已变化，请重新预览");
      if (workspacePlan?.planId !== planId) throw new Error("请重新预览");
      const added = (JSON.parse(workspacePlan.diff) as { workspaces: Array<{ name: string; paths: string[] }> }).workspaces;
      projects.push(...added.map(value => ({ ...value, aliases: [], description: "" })));
      const paths = workspacePlan.paths; workspacePlan = undefined; return { imported: added.length, paths };
    },
  };
}
