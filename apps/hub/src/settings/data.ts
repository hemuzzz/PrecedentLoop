import { HubApiClient } from "../api/client.js";
import type { AiConfiguration, AiTestResult, WorkspaceProjection } from "../api/types.js";

export type SettingsWorkspace = Pick<WorkspaceProjection["items"][number], "name" | "paths" | "aliases" | "description">;
export interface SettingsApi {
  storage(): Promise<{ managed: boolean; pending: number }>;
  workspaces(): Promise<SettingsWorkspace[]>;
  aiSettings(): Promise<AiConfiguration>;
  testAi(provider: "codex" | "claude"): Promise<AiTestResult>;
}
const api = new HubApiClient();
export async function settingsData(): Promise<SettingsApi> {
  if (import.meta.env.DEV && !window.precedentSetup && new URLSearchParams(location.search).has("scenario")) {
    const { getMockSettingsApi } = await import("./mock-settings.js");
    const mock = getMockSettingsApi();
    if (mock) return mock;
  }
  return {
    storage: async () => { const inbox = await api.getInbox(); return { managed: inbox.managed === true, pending: inbox.items.filter(item => item.reviewBucket !== "DEFERRED").length }; },
    workspaces: async () => (await api.getWorkspaces()).items,
    aiSettings: () => api.aiSettings(), testAi: provider => api.testAi(provider),
  };
}
