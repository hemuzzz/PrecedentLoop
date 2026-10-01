import type { SetupBridge } from "../../../desktop/src/setup-contract.js";
export type { AgentName, AgentDetection, CoreCheck, DirectoryCheck, PreparationProgress, SetupBridge, SetupDraft, SetupSnapshot } from "../../../desktop/src/setup-contract.js";
export type { IntegrationItem, IntegrationItemStatus, IntegrationOperation, IntegrationPlan, IntegrationPlanItem, IntegrationProgress, IntegrationResult, IntegrationStatus, PlanRequest, StatusRequest, CodexProject, RegisteredWorkspace, WorkspaceImportPlan, WorkspaceImportPreview, WorkspaceImportResult } from "../../../desktop/src/integrations/contract.js";

declare global { interface Window { precedentSetup?: SetupBridge } }
export async function setupBridge(): Promise<{ bridge: SetupBridge; scenario?: string }> {
  if (window.precedentSetup) return { bridge: window.precedentSetup };
  // Vite removes this branch and the mock module from production builds.
  // A packaged file:// page can never fall back to a simulated privileged bridge.
  if (import.meta.env.DEV && ["http:", "https:"].includes(location.protocol)) {
    const scenario = new URLSearchParams(location.search).get("scenario") ?? "S1-a";
    const { createMockBridge } = await import("./mock-bridge.js");
    return { bridge: createMockBridge(scenario, new URLSearchParams(location.search)), scenario };
  }
  throw new Error("请在桌面应用中打开设置。当前页面未连接本机设置桥接。");
}
