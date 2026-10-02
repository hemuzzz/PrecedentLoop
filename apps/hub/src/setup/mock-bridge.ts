import type { AgentDetection, CoreCheck, DirectoryCheck, PreparationProgress, SetupBridge, SetupDraft, SetupSnapshot } from "./bridge.js";
import { createMockIntegrations } from "./mock-integrations.js";
import type { DirectoryInspection } from "../../../desktop/src/data-directory.js";

export function createMockBridge(scenario: string, options = new URLSearchParams()): SetupBridge {
  const settingsUnavailable = async (): Promise<never> => { throw new Error("请在 Settings 开发场景中查看或修改本机设置。"); };
  const directory = scenario === "S1-f" ? "/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/PrecedentLoop"
    : scenario === "S1-d" ? "/Users/alex/Projects" : "/Users/alex/PrecedentLoop";
  const step = scenario.startsWith("S2") ? 2 : scenario.startsWith("S3") ? 3 : scenario.startsWith("S4") ? 4 : 1;
  let prepared = step > 1 || scenario === "S1-h";
  let retried = false;
  let invalidConfig = scenario === "R1-config-invalid";
  const detections: AgentDetection[] = (["codex", "claude"] as const).map(agent => {
    const missing = scenario === "S2-c" || scenario === "S4-d" || (["S2-b", "S4-b"].includes(scenario) && agent === "claude");
    const invalid = scenario === "S2-e" && agent === "codex";
    return { agent, source: invalid ? "manual" : "auto", found: !missing, runnable: !missing && !invalid,
      ...(missing ? {} : { path: invalid ? "/Users/alex/bin/codex" : agent === "codex" ? "/opt/homebrew/bin/codex" : "/Users/alex/.local/bin/claude" }),
      ...(invalid || missing ? {} : { version: agent === "codex" ? "0.160.0" : "2.3.1" }),
      login: missing || invalid || agent === "claude" ? "unverified" : "logged-in", checkedAt: new Date().toISOString(),
      ...(invalid ? { reason: "手动指定的路径无法运行：文件没有执行权限。知识接入仍可配置，AI 整理暂不可用。" } : {}) };
  });
  let draft: SetupDraft = { step, dataDirectory: directory, agents: { codex: detections[0]!.found, claude: detections[1]!.found },
    manualPaths: { codex: scenario === "S2-e" ? "/Users/alex/bin/codex" : null, claude: null }, aiProvider: scenario === "S2-c" ? null : "codex" };
  const progress: PreparationProgress[] = scenario.startsWith("S1-g") ? [
    { step: "folders", status: "done" }, { step: "storage", status: "done" },
    { step: "service", status: scenario === "S1-g-error" ? "failed" : "running", ...(scenario === "S1-g-error" ? { reason: "服务启动超时，未能在 30 秒内就绪。" } : {}) },
  ] : [];
  const listeners = new Set<(value: PreparationProgress) => void>();
  const getState = async (): Promise<SetupSnapshot> => ({
    startup: invalidConfig ? { mode: "RECOVERY", code: "CONFIG_INVALID", reason: "配置文件无效，原文件已保留。app-config.json 无法解析。", dataDirectory: "无法读取" }
      : scenario === "R1-a" ? { mode: "RECOVERY", code: "DATA_MISSING", reason: "目录不存在：/Volumes/Work/PrecedentLoop", dataDirectory: "/Volumes/Work/PrecedentLoop" }
      : { mode: "SETUP", code: "SETUP_INCOMPLETE", reason: "初始化尚未完成", dataDirectory: draft.dataDirectory },
    draft: { ...draft, formatVersion: 1, updatedAt: new Date().toISOString(), detections: draft.step > 1 ? detections : [] }, resumed: scenario === "S2-resume",
    defaultDataDirectory: "/Users/alex/PrecedentLoop", config: prepared ? { configVersion: 1, setupVersion: 1, setupCompleted: false,
      dataDirectory: draft.dataDirectory, port: 18888, startupTimeoutMs: 30000, shutdownTimeoutMs: 15000 } : null,
    dataCommitted: prepared, progress,
  });
  return {
    getLocalSettings: settingsUnavailable, revealSettingsPath: settingsUnavailable, listAiModels: settingsUnavailable, saveAiSettings: settingsUnavailable,
    savePort: settingsUnavailable, planPortChange: settingsUnavailable, applyPortChange: settingsUnavailable,
    restoreDefaults: settingsUnavailable, exportDiagnostics: settingsUnavailable, planDataMove: settingsUnavailable, applyDataMove: settingsUnavailable,
    getSettings: async () => ({ agents: draft.agents, manualPaths: {}, integrationChoices: draft.integrationChoices ?? {}, port: 18888, setupCompleted: false }),
    saveAgentPath: async () => { throw new Error("请在 Settings 开发场景中修改路径。"); },
    getAppInfo: async () => ({ version: "0.2.0-dev" }), checkForUpdates: async () => {},
    ...createMockIntegrations(scenario, options, () => detections, () => scenario !== "S4-c" || retried),
    getState,
    saveDraft: async value => { draft = value; return (await getState()).draft; },
    selectDirectory: async () => "/Users/alex/PrecedentLoop",
    selectExecutable: async ({ agent }) => `/Users/alex/bin/${agent}`,
    checkDirectory: async ({ path }): Promise<DirectoryCheck> => {
      const kind = prepared ? "PRODUCT" : scenario === "S1-b" || scenario === "R1-config-invalid" ? "PRODUCT" : scenario.startsWith("S1-c") ? "PRODUCT_UNSUPPORTED"
        : scenario === "S1-d" ? "OTHER_NON_EMPTY" : scenario === "S1-e" ? "NOT_WRITABLE" : scenario === "S1-i" ? "PRODUCT_UNSUPPORTED"
          : scenario === "S1-incomplete" ? "PRODUCT_INCOMPLETE" : "MISSING";
      const actual = kind === "OTHER_NON_EMPTY" ? `${path}/PrecedentLoop` : path;
      const inspection: DirectoryInspection = kind === "PRODUCT" ? { kind, storageVersion: 2 }
          : kind === "PRODUCT_UNSUPPORTED" ? { kind, storageVersion: 1, reason: "检测到存储版本 1，当前应用仅支持基线版本 2。请选择已准备好的数据目录。不会升级或覆盖已有数据。" }
            : kind === "NOT_WRITABLE" ? { kind, reason: "无法在此目录创建文件。请选择有写入权限的文件夹。" } : { kind };
      return { selectedPath: path, dataDirectory: actual, inspection: scenario === "S1-f" ? { kind: "SYNC_RISK", inspection } : inspection,
        paths: { databasePath: `${actual}/runtime/precedent-loop.sqlite`,
          workspaceConfigPath: `${actual}/config/workspaces.json`, logPath: `${actual}/logs/server.log`, desktopLogPath: `${actual}/logs/desktop.log` },
        port: 18888,
        ...(kind === "PRODUCT" ? { statistics: { workspaces: 2 } } : {}) };
    },
    prepareDirectory: async ({ path }) => {
      for (const item of ["folders", "storage", "service"] as const) {
        listeners.forEach(listener => listener({ step: item, status: "running" }));
        await new Promise(resolve => setTimeout(resolve, 350));
        listeners.forEach(listener => listener({ step: item, status: "done" }));
      }
      prepared = true; draft.dataDirectory = scenario === "S1-d" ? `${path}/PrecedentLoop` : path; draft.step = 2;
      return getState();
    },
    detectAgents: async () => {
      if (scenario === "S2-d") await new Promise(resolve => setTimeout(resolve, 5000));
      for (const result of detections) {
        const manualPath = draft.manualPaths[result.agent];
        if (manualPath) { result.path = manualPath; result.source = "manual"; result.found = true; }
        else if (result.source === "manual") {
          result.source = "auto"; result.path = result.agent === "codex" ? "/opt/homebrew/bin/codex" : "/Users/alex/.local/bin/claude";
          result.runnable = true; result.version = "1.2.3"; delete result.reason;
        }
      }
      return detections;
    },
    checkCore: async (): Promise<CoreCheck[]> => (["directory", "storage", "runtime", "service", "mcp"] as const).map(id => ({ id,
      ok: !(scenario === "S4-c" && !retried && ["service", "mcp"].includes(id)),
      detail: id === "directory" ? directory : id === "storage" ? "基线版本 2 · 存储已就绪" : id === "runtime" ? "内置 Node 22.16.0 · arm64"
        : id === "mcp" ? "http://127.0.0.1:18888/mcp" : scenario === "S4-c" && !retried ? "本地服务尚未就绪，请重试。" : "服务已就绪" })),
    complete: async () => { /* Development preview stays on the current screen. */ },
    recheck: async () => { retried = true; return getState(); },
    resetInvalidConfig: async () => {
      if (!invalidConfig) throw new Error("仅配置文件无效时允许备份并重新设置。");
      invalidConfig = false; prepared = false; draft.step = 1;
      return getState();
    },
    selectRecoveryDirectory: async () => getState(), openLogs: async () => {}, quit: async () => {},
    onProgress: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
