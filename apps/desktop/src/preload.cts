import type { SetupBridge, PreparationProgress } from "./setup-contract.js" with { "resolution-mode": "import" };
import type { IpcRendererEvent } from "electron";
import type { IntegrationProgress } from "./integrations/contract.js" with { "resolution-mode": "import" };

// Electron 44 sandboxed preloads only support the limited CommonJS require shim.
// Keep this file self-contained: no runtime imports other than electron.
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
const bridge: SetupBridge = {
  getState: () => ipcRenderer.invoke("setup:getState", {}),
  saveDraft: draft => ipcRenderer.invoke("setup:saveDraft", draft),
  selectDirectory: () => ipcRenderer.invoke("setup:selectDirectory", {}),
  selectExecutable: input => ipcRenderer.invoke("setup:selectExecutable", input),
  checkDirectory: input => ipcRenderer.invoke("setup:checkDirectory", input),
  prepareDirectory: input => ipcRenderer.invoke("setup:prepareDirectory", input),
  detectAgents: input => ipcRenderer.invoke("setup:detectAgents", input ?? {}),
  getSettings: () => ipcRenderer.invoke("setup:getSettings", {}),
  saveAgentPath: input => ipcRenderer.invoke("setup:saveAgentPath", input),
  getAppInfo: () => ipcRenderer.invoke("setup:getAppInfo", {}),
  checkForUpdates: () => ipcRenderer.invoke("setup:checkForUpdates", {}),
  getLocalSettings: () => ipcRenderer.invoke("setup:getLocalSettings", {}),
  revealSettingsPath: input => ipcRenderer.invoke("setup:revealSettingsPath", input),
  listAiModels: () => ipcRenderer.invoke("setup:listAiModels", {}),
  saveAiSettings: input => ipcRenderer.invoke("setup:saveAiSettings", input),
  savePort: input => ipcRenderer.invoke("setup:savePort", input),
  planPortChange: input => ipcRenderer.invoke("setup:planPortChange", input),
  applyPortChange: input => ipcRenderer.invoke("setup:applyPortChange", input),
  restoreDefaults: () => ipcRenderer.invoke("setup:restoreDefaults", {}),
  exportDiagnostics: () => ipcRenderer.invoke("setup:exportDiagnostics", {}),
  planDataMove: input => ipcRenderer.invoke("setup:planDataMove", input),
  applyDataMove: input => ipcRenderer.invoke("setup:applyDataMove", input),
  getIntegrationStatus: input => ipcRenderer.invoke("setup:getIntegrationStatus", input),
  planIntegrations: input => ipcRenderer.invoke("setup:planIntegrations", input),
  applyIntegrations: input => ipcRenderer.invoke("setup:applyIntegrations", input),
  planIntegrationRemoval: input => ipcRenderer.invoke("setup:planIntegrationRemoval", input),
  listCodexProjects: () => ipcRenderer.invoke("setup:listCodexProjects", {}),
  planWorkspaceImport: input => ipcRenderer.invoke("setup:planWorkspaceImport", input),
  importWorkspaces: input => ipcRenderer.invoke("setup:importWorkspaces", input),
  checkCore: () => ipcRenderer.invoke("setup:checkCore", {}),
  complete: () => ipcRenderer.invoke("setup:complete", {}),
  recheck: () => ipcRenderer.invoke("setup:recheck", {}),
  selectRecoveryDirectory: () => ipcRenderer.invoke("setup:selectRecoveryDirectory", {}),
  resetInvalidConfig: () => ipcRenderer.invoke("setup:resetInvalidConfig", {}),
  openLogs: () => ipcRenderer.invoke("setup:openLogs", {}),
  quit: () => ipcRenderer.invoke("setup:quit", {}),
  onOpenInbox: listener => {
    const receive = (): void => listener();
    ipcRenderer.on("hub:open-inbox", receive);
    return () => { ipcRenderer.removeListener("hub:open-inbox", receive); };
  },
  onProgress: listener => {
    const receive = (_event: IpcRendererEvent, progress: PreparationProgress): void => listener(progress);
    ipcRenderer.on("setup:progress", receive);
    return () => { ipcRenderer.removeListener("setup:progress", receive); };
  },
  onIntegrationProgress: listener => {
    const receive = (_event: IpcRendererEvent, progress: IntegrationProgress): void => listener(progress);
    ipcRenderer.on("setup:integration-progress", receive);
    return () => { ipcRenderer.removeListener("setup:integration-progress", receive); };
  },
};
contextBridge.exposeInMainWorld("precedentSetup", bridge);
