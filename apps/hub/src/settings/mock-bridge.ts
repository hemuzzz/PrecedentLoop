import type { SettingsBridge, SettingsSnapshot } from "./bridge.js";
import type { AgentDetection } from "../setup/bridge.js";
import { createMockIntegrations } from "../setup/mock-integrations.js";
import { agents, items } from "../setup/integration-presentation.js";
import { createLocalSettingsMock } from "./mock-settings.js";

/** DEV only. No filesystem, CLI, network or real settings writes. */
export function createSettingsMock(scenario: string, options: URLSearchParams): SettingsBridge {
  const snapshot: SettingsSnapshot = { agents: { codex: true, claude: scenario !== "T5-c" }, manualPaths: {},
    integrationChoices: Object.fromEntries(agents.map(agent => [agent, Object.fromEntries(items.map(item => [item,
      agent === "claude" && scenario === "T5-c" ? "skipped" : agent === "codex" && item === "captureReminder" && scenario === "T9-c" ? "undecided" : "enabled"]))])),
    port: 18888, setupCompleted: true };
  let detections: AgentDetection[] = [];
  const detect: SettingsBridge["detectAgents"] = async input => {
    for (const agent of agents.filter(agent => !input?.agent || input.agent === agent)) {
      const path = snapshot.manualPaths[agent];
      const missing = scenario === "T5-c" && agent === "claude" && !path;
      const invalid = !!path && options.get("invalidPath") === "1";
      const result: AgentDetection = { agent, source: path ? "manual" : "auto", found: !missing && !invalid, runnable: !missing && !invalid,
        ...(missing ? {} : { path: path ?? (agent === "codex" ? "/opt/homebrew/bin/codex" : "/Users/alex/.local/bin/claude") }),
        ...(!missing && !invalid ? { version: agent === "codex" ? "0.160.0" : "2.3.1" } : {}),
        login: missing || invalid || agent === "claude" ? "unverified" : "logged-in", checkedAt: new Date().toISOString(),
        ...(invalid ? { reason: "手动指定的路径已不可用，请恢复自动检测或重新指定。" } : {}) };
      detections = [...detections.filter(value => value.agent !== agent), result];
    }
    return structuredClone(detections);
  };
  const integrations = createMockIntegrations(scenario, options, () => detections, () => options.get("service") !== "offline");
  const modes = new Map<string, "install" | "remove">();
  return {
    ...integrations,
    ...createLocalSettingsMock(scenario, options, integrations),
    getSettings: async () => structuredClone(snapshot),
    getAppInfo: async () => ({ version: options.get("version") ?? "0.2.0-dev" }),
    checkForUpdates: async () => { /* No real update from a preview. */ },
    openLogs: async () => {}, selectExecutable: async ({ agent }) => `/Users/alex/bin/${agent}`,
    detectAgents: detect,
    saveAgentPath: async ({ agent, path }) => { if (path === null) delete snapshot.manualPaths[agent]; else snapshot.manualPaths[agent] = path; return detect({ agent }); },
    getIntegrationStatus: async () => { if (!detections.length) await detect(); return integrations.getIntegrationStatus({ choices: snapshot.integrationChoices }); },
    planIntegrations: async input => { const plan = await integrations.planIntegrations(input); modes.set(plan.planId, plan.mode); return plan; },
    planIntegrationRemoval: async input => { const plan = await integrations.planIntegrationRemoval(input); modes.set(plan.planId, plan.mode); return plan; },
    applyIntegrations: async input => {
      const mode = modes.get(input.planId); modes.delete(input.planId);
      const result = await integrations.applyIntegrations(input);
      for (const item of result.items) if (item.status === "success") {
        (snapshot.integrationChoices[item.agent] ??= {})[item.item] = mode === "remove" ? "skipped" : "enabled";
        if (mode === "install") snapshot.agents[item.agent] = true;
      }
      return result;
    },
  };
}
