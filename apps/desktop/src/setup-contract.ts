import type { AppConfig } from "./config.js";
import type { DataDirectoryInspection } from "./data-directory.js";
import type { StartupMode } from "./startup.js";
import type { AiModelCatalogs } from "./ai-models.js";
import type { AiOverrides, DataMoveMode, DataMovePlan, DataMoveResult, LocalSettings, PortChangePlan, PortChangeResult } from "./settings-contract.js";
import type { IntegrationChoices, IntegrationPlan, IntegrationProgress, IntegrationResult, IntegrationStatus, PlanRequest, RemoveRequest, StatusRequest, WorkspaceImportPlan, WorkspaceImportPreview, WorkspaceImportResult } from "./integrations/contract.js";

export type AgentName = "codex" | "claude";
export interface AgentDetection {
  agent: AgentName;
  source: "manual" | "auto";
  path?: string;
  found: boolean;
  runnable: boolean;
  version?: string;
  login: "logged-in" | "logged-out" | "unverified";
  reason?: string;
  checkedAt: string;
}
export interface SetupDraft {
  step: 1 | 2 | 3 | 4;
  dataDirectory: string;
  agents: Record<AgentName, boolean>;
  manualPaths: Record<AgentName, string | null>;
  aiProvider: AgentName | null;
  integrationChoices?: IntegrationChoices | undefined;
}
export interface SetupStateFile extends SetupDraft {
  formatVersion: 1;
  updatedAt: string;
  detections: AgentDetection[];
}
export type PreparationStep = "folders" | "storage" | "service";
export interface PreparationProgress {
  step: PreparationStep;
  status: "waiting" | "running" | "done" | "failed";
  reason?: string;
}
export interface DirectoryCheck {
  selectedPath: string;
  dataDirectory: string;
  inspection: DataDirectoryInspection;
  paths: { assetRepositoryPath: string; databasePath: string; workspaceConfigPath: string; logPath: string; desktopLogPath: string };
  port: number | null;
  portReason?: string;
  statistics?: { assets?: number; candidates?: number; workspaces?: number };
}
export interface CoreCheck {
  id: "directory" | "storage" | "runtime" | "service" | "mcp";
  ok: boolean;
  detail: string;
}
export interface SetupSnapshot {
  startup: StartupMode;
  draft: SetupStateFile;
  resumed: boolean;
  draftWarning?: string;
  defaultDataDirectory: string;
  config: AppConfig | null;
  dataCommitted: boolean;
  progress: PreparationProgress[];
}
export interface PrepareRequest {
  path: string;
  syncRiskConfirmed: boolean;
}
export interface SetupCoreBridge {
  getState(): Promise<SetupSnapshot>;
  saveDraft(draft: SetupDraft): Promise<SetupStateFile>;
  selectDirectory(): Promise<string | null>;
  selectExecutable(input: { agent: AgentName }): Promise<string | null>;
  checkDirectory(input: { path: string }): Promise<DirectoryCheck>;
  prepareDirectory(input: PrepareRequest): Promise<SetupSnapshot>;
  detectAgents(input?: { agent?: AgentName }): Promise<AgentDetection[]>;
  checkCore(): Promise<CoreCheck[]>;
  complete(): Promise<void>;
  recheck(): Promise<SetupSnapshot>;
  selectRecoveryDirectory(): Promise<SetupSnapshot | null>;
  resetInvalidConfig(): Promise<SetupSnapshot>;
  openLogs(): Promise<void>;
  quit(): Promise<void>;
  onProgress(listener: (progress: PreparationProgress) => void): () => void;
}
export interface SetupIntegrationBridge {
  onIntegrationProgress(listener: (progress: IntegrationProgress) => void): () => void;
  getIntegrationStatus(input: StatusRequest): Promise<IntegrationStatus[]>;
  planIntegrations(input: PlanRequest): Promise<IntegrationPlan>;
  applyIntegrations(input: { planId: string }): Promise<IntegrationResult>;
  planIntegrationRemoval(input: RemoveRequest): Promise<IntegrationPlan>;
  listCodexProjects(): Promise<WorkspaceImportPreview>;
  planWorkspaceImport(input: { listId: string; candidateIds: string[] }): Promise<WorkspaceImportPlan>;
  importWorkspaces(input: { planId: string }): Promise<WorkspaceImportResult>;
}
export interface SettingsSnapshot {
  agents: Partial<Record<AgentName, boolean>>;
  manualPaths: Partial<Record<AgentName, string>>;
  integrationChoices: IntegrationChoices;
  port: number;
  setupCompleted: boolean;
}
export interface SettingsBridge extends Pick<SetupCoreBridge, "detectAgents" | "selectExecutable" | "openLogs">,
  Pick<SetupIntegrationBridge, "onIntegrationProgress" | "getIntegrationStatus" | "planIntegrations" | "applyIntegrations" | "planIntegrationRemoval" | "listCodexProjects" | "planWorkspaceImport" | "importWorkspaces"> {
  getSettings(): Promise<SettingsSnapshot>;
  saveAgentPath(input: { agent: AgentName; path: string | null }): Promise<AgentDetection[]>;
  getAppInfo(): Promise<{ version: string }>;
  checkForUpdates(): Promise<void>;
  getLocalSettings(): Promise<LocalSettings>;
  revealSettingsPath(input: { target: "data" | "workspaces" }): Promise<void>;
  listAiModels(): Promise<AiModelCatalogs>;
  saveAiSettings(input: { ai: AiOverrides }): Promise<void>;
  savePort(input: { port: number }): Promise<LocalSettings>;
  planPortChange(input: { repairMcp: boolean }): Promise<PortChangePlan>;
  applyPortChange(input: { planId: string }): Promise<PortChangeResult>;
  restoreDefaults(): Promise<LocalSettings>;
  exportDiagnostics(): Promise<{ path: string } | null>;
  /** Opens the main-process directory dialog; null when canceled. */
  planDataMove(input: { mode: DataMoveMode }): Promise<DataMovePlan | null>;
  applyDataMove(input: { planId: string; syncRiskConfirmed: boolean }): Promise<DataMoveResult>;
}
export interface SetupBridge extends SetupCoreBridge, SetupIntegrationBridge, SettingsBridge {
  onOpenInbox?(listener: () => void): () => void;
}
