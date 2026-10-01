import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { agentNameSchema, setupDraftSchema, setupPathSchema } from "./setup-state.js";
import type { SetupService } from "./setup-service.js";
import type { AgentName } from "./setup-contract.js";
import { integrationPlanSchema, integrationRemoveSchema, integrationStatusSchema, planIdSchema, workspacePlanSchema } from "./integrations/contract.js";
import { aiOverridesSchema, portSchema } from "./settings-contract.js";

const empty = z.object({}).strict();
export const setupRequestSchemas = {
  getState: empty,
  saveDraft: setupDraftSchema,
  selectDirectory: empty,
  selectExecutable: z.object({ agent: agentNameSchema }).strict(),
  checkDirectory: z.object({ path: setupPathSchema }).strict(),
  prepareDirectory: z.object({ path: setupPathSchema, syncRiskConfirmed: z.boolean() }).strict(),
  detectAgents: z.object({ agent: agentNameSchema.optional() }).strict(), checkCore: empty, complete: empty, recheck: empty, selectRecoveryDirectory: empty, resetInvalidConfig: empty, openLogs: empty, quit: empty,
  getSettings: empty, saveAgentPath: z.object({ agent: agentNameSchema, path: setupPathSchema.nullable() }).strict(), getAppInfo: empty, checkForUpdates: empty,
  getIntegrationStatus: integrationStatusSchema, planIntegrations: integrationPlanSchema, applyIntegrations: planIdSchema,
  planIntegrationRemoval: integrationRemoveSchema, listCodexProjects: empty, planWorkspaceImport: workspacePlanSchema, importWorkspaces: planIdSchema,
  getLocalSettings: empty, revealSettingsPath: z.object({ target: z.enum(["data", "workspaces"]) }).strict(),
  listAiModels: empty, saveAiSettings: z.object({ ai: aiOverridesSchema }).strict(), savePort: z.object({ port: portSchema }).strict(),
  planPortChange: z.object({ repairMcp: z.boolean() }).strict(), applyPortChange: planIdSchema,
  restoreDefaults: empty, exportDiagnostics: empty,
  planDataMove: z.object({ mode: z.enum(["migrate", "associate"]) }).strict(),
  applyDataMove: z.object({ planId: z.string().uuid(), syncRiskConfirmed: z.boolean() }).strict(),
};
export type SetupMethod = keyof typeof setupRequestSchemas;
export const setupMethods: readonly SetupMethod[] = ["getState", "saveDraft", "selectDirectory", "selectExecutable", "checkDirectory", "prepareDirectory",
  "detectAgents", "checkCore", "complete", "recheck", "selectRecoveryDirectory", "resetInvalidConfig", "openLogs", "quit", "getIntegrationStatus",
  "planIntegrations", "applyIntegrations", "planIntegrationRemoval", "listCodexProjects", "planWorkspaceImport", "importWorkspaces"];
export const settingsMethods: readonly SetupMethod[] = ["detectAgents", "selectExecutable", "saveAgentPath", "getSettings", "getIntegrationStatus",
  "planIntegrations", "applyIntegrations", "planIntegrationRemoval", "openLogs", "getAppInfo", "checkForUpdates",
  "getLocalSettings", "revealSettingsPath", "listAiModels", "saveAiSettings", "savePort", "planPortChange", "applyPortChange", "restoreDefaults", "exportDiagnostics",
  "listCodexProjects", "planWorkspaceImport", "importWorkspaces", "planDataMove", "applyDataMove"];
export interface SetupCaller { url: string; mainWindow: boolean; mainFrame: boolean }
export function callerKind(caller: SetupCaller, setupFile: string, backendOrigin: string | null): "setup" | "hub" | null {
  if (!caller.mainWindow || !caller.mainFrame) return null;
  if (isSetupSender(caller.url, setupFile)) return "setup";
  if (!backendOrigin) return null;
  try {
    const url = new URL(caller.url);
    if (url.protocol === "http:" && !url.username && !url.password && url.origin === backendOrigin && url.pathname === "/" && !url.search) return "hub";
  } catch { /* Unknown sources are rejected. */ }
  return null;
}
export function isAllowedCaller(method: SetupMethod, caller: SetupCaller, setupFile: string, backendOrigin: string | null): boolean {
  const kind = callerKind(caller, setupFile, backendOrigin);
  return kind === "setup" ? setupMethods.includes(method) : kind === "hub" && settingsMethods.includes(method);
}
export function isSetupSender(url: string, setupFile: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" && parsed.host === "" && fileURLToPath(parsed) === resolve(setupFile);
  } catch { return false; }
}
export interface SetupHost {
  selectDirectory: () => Promise<string | null>;
  selectExecutable: (agent: AgentName) => Promise<string | null>;
  openLogs: () => Promise<void>;
  quit: () => void;
  getAppInfo: () => { version: string };
  checkForUpdates: () => Promise<void>;
  revealPath: (path: string) => Promise<void>;
  selectDiagnosticDestination: () => Promise<string | null>;
}
/** No Electron import: the same dispatcher is exercised by isolated non-UI tests. */
export function createSetupDispatcher(setupFile: string, service: SetupService, host: SetupHost, backendOrigin: () => string | null = () => null) {
  let busy = false;
  return async (method: SetupMethod, caller: SetupCaller, raw: unknown): Promise<unknown> => {
    const origin = backendOrigin();
    if (!isAllowedCaller(method, caller, setupFile, origin)) throw new Error("SETUP_CALLER_REJECTED：调用页面或方法不在允许范围内。");
    const schema = method === "getIntegrationStatus" && callerKind(caller, setupFile, origin) === "hub" ? empty : setupRequestSchemas[method];
    if (!schema) throw new Error("SETUP_CHANNEL_REJECTED");
    if (!schema.safeParse(raw).success) throw new Error("SETUP_INVALID_ARGUMENT：请求参数无效。");
    const exclusive = !["getState", "getSettings", "getLocalSettings", "getAppInfo", "checkDirectory", "checkCore", "openLogs", "quit"].includes(method);
    if (busy && exclusive) throw new Error("SETUP_BUSY：请等待当前操作完成。");
    if (exclusive) busy = true;
    try {
      switch (method) {
        case "getState": return await service.getState();
        case "saveDraft": return await service.saveDraft(setupDraftSchema.parse(raw));
        case "selectDirectory": return await host.selectDirectory();
        case "selectExecutable": {
          const agent = setupRequestSchemas.selectExecutable.parse(raw).agent;
          service.rememberExecutable(agent, null);
          const path = await host.selectExecutable(agent);
          service.rememberExecutable(agent, path);
          return path;
        }
        case "checkDirectory": return await service.checkDirectory(setupRequestSchemas.checkDirectory.parse(raw).path);
        case "prepareDirectory": return await service.prepareDirectory(setupRequestSchemas.prepareDirectory.parse(raw));
        case "detectAgents": return await service.detectAgents(setupRequestSchemas.detectAgents.parse(raw));
        case "getSettings": return await service.getSettings();
        case "saveAgentPath": return await service.saveAgentPath(setupRequestSchemas.saveAgentPath.parse(raw));
        case "getAppInfo": return host.getAppInfo();
        case "checkForUpdates": return await host.checkForUpdates();
        case "getLocalSettings": return await service.getLocalSettings();
        case "revealSettingsPath": {
          const { target } = setupRequestSchemas.revealSettingsPath.parse(raw), local = await service.getLocalSettings();
          return await host.revealPath(target === "data" ? local.dataDirectory : local.paths.workspaceConfigPath);
        }
        case "listAiModels": setupRequestSchemas.listAiModels.parse(raw); return await service.listAiModels();
        case "saveAiSettings": return await service.saveAiSettings(setupRequestSchemas.saveAiSettings.parse(raw).ai);
        case "savePort": return await service.savePort(setupRequestSchemas.savePort.parse(raw).port);
        case "planPortChange": return await service.planPortChange(setupRequestSchemas.planPortChange.parse(raw).repairMcp);
        case "applyPortChange": return await service.applyPortChange(planIdSchema.parse(raw).planId);
        case "restoreDefaults": return await service.restoreDefaults();
        case "planDataMove": {
          // The location always comes from the main-process dialog, never from the renderer.
          const { mode } = setupRequestSchemas.planDataMove.parse(raw), path = await host.selectDirectory();
          return path === null ? null : await service.planDataMove(mode, path);
        }
        case "applyDataMove": {
          const { planId, syncRiskConfirmed } = setupRequestSchemas.applyDataMove.parse(raw);
          return await service.applyDataMove(planId, syncRiskConfirmed);
        }
        case "exportDiagnostics": {
          const path = await host.selectDiagnosticDestination();
          if (path === null) return null;
          await service.diagnosticExport(path, host.getAppInfo().version);
          return { path };
        }
        case "getIntegrationStatus": return await service.getIntegrationStatus(integrationStatusSchema.parse(raw));
        case "planIntegrations": return await service.planIntegrations(integrationPlanSchema.parse(raw));
        case "applyIntegrations": return await service.applyIntegrations(planIdSchema.parse(raw).planId);
        case "planIntegrationRemoval": return await service.planIntegrationRemoval(integrationRemoveSchema.parse(raw));
        case "listCodexProjects": return await service.listCodexProjects();
        case "planWorkspaceImport": return await service.planWorkspaceImport(workspacePlanSchema.parse(raw));
        case "importWorkspaces": return await service.importWorkspaces(planIdSchema.parse(raw).planId);
        case "checkCore": return await service.checkCore();
        case "complete": return await service.complete();
        case "recheck": return await service.recheck();
        case "resetInvalidConfig": return await service.resetInvalidConfig();
        case "selectRecoveryDirectory": {
          const path = await host.selectDirectory();
          return path ? await service.selectRecoveryDirectory(path) : null;
        }
        case "openLogs": return await host.openLogs();
        case "quit": host.quit(); return;
      }
    } finally { if (exclusive) busy = false; }
  };
}
