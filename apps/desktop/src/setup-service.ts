import { copyFile, lstat, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectAgent } from "./agent-detection.js";
import { appConfigSchema, dataPaths, readAppConfig, readBuildInfo, serializeAppConfig, writeAppConfig, type AppConfig } from "./config.js";
import { copyDataDirectory, ensureMarker, initializeStorage, inspectDataDirectory, pathsOverlap, prepareDirectoryLayout, type DataDirectoryInspection } from "./data-directory.js";
import { backendFailureMode, determineStartupMode, type StartupMode } from "./startup.js";
import { readSetupState, setupDraftSchema, writeSetupState } from "./setup-state.js";
import type { AgentDetection, AgentName, CoreCheck, DirectoryCheck, PreparationProgress, PreparationStep, PrepareRequest, SettingsSnapshot, SetupDraft, SetupSnapshot, SetupStateFile } from "./setup-contract.js";
import { IntegrationEngine } from "./integrations/engine.js";
import type { IntegrationEnvironment } from "./integrations/environment.js";
import { integrationStatus } from "./integrations/status.js";
import { bundledWorkspaceWorker, WorkspaceImporter, type WorkspaceWorker } from "./integrations/workspaces.js";
import { integrationItems, type IntegrationProgress, type PlanRequest, type RemoveRequest, type StatusRequest } from "./integrations/contract.js";
import { aiOverridesSchema, portSchema, type AiOverrides, type DataMoveMode, type DataMovePlan, type DataMoveResult, type LocalSettings, type PortChangePlan, type PortChangeResult } from "./settings-contract.js";
import { readLedger } from "./integrations/ledger.js";
import { exportDiagnostics } from "./diagnostics.js";
import { readAiModelCatalogs, type AiModelCatalogs } from "./ai-models.js";

export async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE" ? resolve(false) : reject(error));
    server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : resolve(true)));
  });
}
export async function chooseSetupPort(available = portAvailable): Promise<number> {
  for (let port = 18888; port <= 18898; port++) if (await available(port)) return port;
  throw new Error("18888–18898 端口均被占用，请释放一个端口后重试。");
}
const inner = (inspection: DataDirectoryInspection) => inspection.kind === "SYNC_RISK" ? inspection.inspection : inspection;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
async function statistics(path: string): Promise<NonNullable<DirectoryCheck["statistics"]>> {
  const result: NonNullable<DirectoryCheck["statistics"]> = {};
  const paths = dataPaths(path);
  try {
    const value: unknown = JSON.parse(await readFile(paths.workspaceConfigPath, "utf8"));
    if (typeof value === "object" && value !== null && "workspaces" in value && Array.isArray(value.workspaces)) result.workspaces = value.workspaces.length;
  } catch { /* Optional; never turn unreadable statistics into a setup failure. */ }
  return result;
}
export interface SetupDependencies {
  userData: string;
  runtime: string;
  home?: string;
  portAvailable?: (port: number) => Promise<boolean>;
  startBackend: (config: AppConfig) => Promise<void>;
  stopBackend: () => Promise<void>;
  backendStatus: (config: AppConfig) => Promise<{ serviceReady: boolean; mcpReady: boolean }>;
  verifyRuntime: () => Promise<string>;
  changeMode: (mode: StartupMode) => Promise<void>;
  progress: (progress: PreparationProgress) => void;
  integrationProgress?: (progress: IntegrationProgress) => void;
  detect?: typeof detectAgent;
  now?: () => Date;
  integrations?: IntegrationEnvironment;
  workspaceWorker?: WorkspaceWorker;
  reloadSettings?: (port: number, page?: "advanced" | "storage") => Promise<void>;
}
export class SetupService {
  startup: StartupMode = determineStartupMode({ kind: "MISSING" });
  private draft!: SetupStateFile;
  private resumed = false;
  private draftWarning: string | undefined;
  private readonly progress = new Map<PreparationStep, PreparationProgress>();
  private backendStarting: Promise<void> | undefined;
  private backendDirectory: string | undefined;
  readonly defaultDataDirectory: string;
  private engine: IntegrationEngine | undefined;
  private workspaces: WorkspaceImporter | undefined;
  private settingsDetections: AgentDetection[] = [];
  private readonly selectedExecutables = new Map<AgentName, string>();
  private pendingPort: number | null = null;
  private lastRestart: PortChangeResult | null = null;
  private lastDataMove: DataMoveResult | null = null;
  private readonly dataMovePlans = new Map<string, DataMovePlan>();
  restarting = false;
  private readonly portPlans = new Map<string, { before: string; next: AppConfig; engine: IntegrationEngine | null; integrationId: string | null; agents: AgentName[] }>();
  /** Issued only by the main-process file dialog. A new dialog (including cancel)
   * invalidates the previous choice for this Agent; a successful save consumes it. */
  rememberExecutable(agent: AgentName, path: string | null): void {
    this.selectedExecutables.delete(agent);
    if (path !== null) this.selectedExecutables.set(agent, path);
  }
  private assertSelectedExecutable(agent: AgentName, path: string | null): void {
    if (path !== null && this.selectedExecutables.get(agent) !== path) throw new Error("EXECUTABLE_SELECTION_REQUIRED：请通过文件选择对话框指定此 Agent 的命令行工具。");
  }
  private readonly settingsPlans = new Map<string, "install" | "remove">();
  constructor(readonly dependencies: SetupDependencies) {
    this.defaultDataDirectory = join(dependencies.home ?? homedir(), "PrecedentLoop");
    if (dependencies.integrations) {
      this.engine = new IntegrationEngine(dependencies.integrations, () => this.integrationConfig());
      this.workspaces = new WorkspaceImporter(dependencies.integrations, () => this.integrationConfig(),
        dependencies.workspaceWorker ?? bundledWorkspaceWorker(dependencies.runtime, dependencies.integrations));
    }
  }
  private async integrationConfig(): Promise<AppConfig> {
    const config = await readAppConfig(this.dependencies.userData);
    if (config.kind !== "VALID") throw new Error("请先准备本地数据目录和应用配置。");
    return config.config;
  }
  private async integrationEngine(): Promise<IntegrationEngine> {
    if (!this.engine) throw new Error("当前环境没有提供集成引擎。");
    const normal = this.startup.mode === "NORMAL";
    const config = normal ? await this.integrationConfig() : null;
    if (normal && this.settingsDetections.length < 2) await this.detectAgents();
    for (const agent of ["codex", "claude"] as const) {
      this.engine.env.executables[agent] = normal
        ? config?.manualPaths?.[agent] ?? this.settingsDetections.find(value => value.agent === agent)?.path ?? null
        : this.draft.manualPaths[agent] ?? this.draft.detections.find(value => value.agent === agent)?.path ?? null;
    }
    return this.engine;
  }
  async getIntegrationStatus(input: StatusRequest) {
    const engine = await this.integrationEngine(), config = await this.integrationConfig();
    const service = await this.dependencies.backendStatus(config).catch(() => ({ serviceReady: false }));
    const normal = this.startup.mode === "NORMAL";
    const statuses = await integrationStatus(engine.env, config, normal ? { choices: config.integrationChoices ?? {} } : input,
      service.serviceReady, normal ? this.settingsDetections : this.draft.detections);
    if (normal) for (const status of statuses) if (!config.agents?.[status.agent]) {
      for (const item of status.items) if (item.configuration === "unconfigured" && !item.evidence.installedAt && item.verification !== "failed") item.label = "未接入";
      const actual = status.items.filter(item => item.label !== "未接入");
      status.label = !actual.length ? "未接入" : actual.some(item => ["repair", "partial"].includes(item.configuration) || item.verification === "failed") ? "待处理"
        : actual.every(item => item.configuration === "external") ? "外部已存在" : actual.length < status.items.length ? "部分完成" : actual[0]!.label;
    }
    return statuses;
  }
  async planIntegrations(input: PlanRequest) {
    const plan = await (await this.integrationEngine()).plan(input);
    if (this.startup.mode === "NORMAL") this.rememberSettingsPlan(plan.planId, plan.mode);
    return plan;
  }
  async planIntegrationRemoval(input: RemoveRequest) {
    // All four items are mandatory for a connected Agent (2026-09-24): Settings removes an Agent as a whole.
    if (this.startup.mode === "NORMAL" && input.agent !== "all" && !integrationItems.every(item => input.items.includes(item))) {
      throw new Error("接入项需整体移除：请移除整个 Agent 的接入。");
    }
    const plan = await (await this.integrationEngine()).planRemoval(input);
    if (this.startup.mode === "NORMAL") this.rememberSettingsPlan(plan.planId, plan.mode);
    return plan;
  }
  private rememberSettingsPlan(id: string, mode: "install" | "remove"): void {
    if (this.settingsPlans.size >= 32) this.settingsPlans.delete(this.settingsPlans.keys().next().value!);
    this.settingsPlans.set(id, mode);
  }
  async applyIntegrations(planId: string) {
    const mode = this.settingsPlans.get(planId);
    this.settingsPlans.delete(planId);
    const result = await (await this.integrationEngine()).apply(planId, this.dependencies.integrationProgress);
    if (mode) {
      const config = await this.integrationConfig();
      const choices = structuredClone(config.integrationChoices ?? {}), agents = { ...config.agents };
      for (const item of result.items) if (item.status === "success") {
        (choices[item.agent] ??= {})[item.item] = mode === "install" ? "enabled" : "skipped";
        if (mode === "install") agents[item.agent] = true;
      }
      try { await writeAppConfig(this.dependencies.userData, { ...config, agents, integrationChoices: choices }); }
      catch (error) { throw new Error(`接入执行结果已保存在账本，但期望状态保存失败，请重新预览并重试：${message(error)}`); }
    }
    return result;
  }
  async getSettings(): Promise<SettingsSnapshot> {
    if (this.startup.mode !== "NORMAL") throw new Error("当前模式不允许读取本机设置。");
    const config = await this.integrationConfig();
    return { agents: config.agents ?? {}, manualPaths: config.manualPaths ?? {}, integrationChoices: config.integrationChoices ?? {},
      port: config.port, setupCompleted: config.setupCompleted };
  }
  async saveAgentPath(input: { agent: AgentName; path: string | null }): Promise<AgentDetection[]> {
    if (this.startup.mode !== "NORMAL") throw new Error("当前模式不允许修改本机设置。");
    this.assertSelectedExecutable(input.agent, input.path);
    const config = await this.integrationConfig(), manualPaths = { ...config.manualPaths };
    if (input.path === null) delete manualPaths[input.agent];
    else manualPaths[input.agent] = input.path;
    await writeAppConfig(this.dependencies.userData, { ...config, manualPaths });
    this.selectedExecutables.delete(input.agent);
    this.settingsDetections = this.settingsDetections.filter(value => value.agent !== input.agent);
    return this.detectAgents({ agent: input.agent });
  }
  private assertSettings(): void { if (this.startup.mode !== "NORMAL") throw new Error("当前模式不允许修改本机设置。"); }
  async getLocalSettings(): Promise<LocalSettings> {
    this.assertSettings();
    const config = await this.integrationConfig(), paths = dataPaths(config.dataDirectory), build = await readBuildInfo(this.dependencies.runtime);
    return { dataDirectory: config.dataDirectory, paths,
      runtime: { nodeVersion: build.nodeVersion, arch: build.arch, modules: build.modules }, port: config.port,
      pendingPort: this.pendingPort, lastRestart: this.lastRestart, lastDataMove: this.lastDataMove };
  }
  /** Read-only: the models and reasoning levels the local CLIs currently offer, plus their own defaults. */
  async listAiModels(): Promise<AiModelCatalogs> {
    this.assertSettings();
    const config = await this.integrationConfig(), home = this.dependencies.integrations?.home ?? this.dependencies.home ?? homedir();
    return readAiModelCatalogs({ home, codexHome: this.dependencies.integrations?.codexHome ?? join(home, ".codex"),
      claudeDirectory: this.dependencies.integrations?.claudeDirectory ?? join(home, ".claude"),
      claudeExecutable: config.manualPaths?.claude ?? config.detectedPaths?.claude ?? null });
  }
  async saveAiSettings(value: AiOverrides): Promise<void> {
    this.assertSettings();
    const ai = aiOverridesSchema.parse(value), config = await this.integrationConfig();
    if (!Object.keys(ai).length) delete config.ai;
    else config.ai = ai;
    await writeAppConfig(this.dependencies.userData, config);
  }
  async savePort(port: number): Promise<LocalSettings> {
    this.assertSettings();
    const config = await this.integrationConfig();
    this.pendingPort = portSchema.parse(port) === config.port ? null : port;
    this.portPlans.clear();
    return this.getLocalSettings();
  }
  async restoreDefaults(): Promise<LocalSettings> {
    this.assertSettings();
    const config = await this.integrationConfig();
    delete config.ai;
    await writeAppConfig(this.dependencies.userData, config);
    this.pendingPort = config.port === 18888 ? null : 18888;
    this.portPlans.clear();
    return this.getLocalSettings();
  }
  async diagnosticExport(target: string, version: string): Promise<void> {
    this.assertSettings();
    const config = await this.integrationConfig();
    await exportDiagnostics(target, { version, build: await readBuildInfo(this.dependencies.runtime), config, userData: this.dependencies.userData,
      statuses: await this.getIntegrationStatus({}), backend: await this.dependencies.backendStatus(config).catch(() => ({ serviceReady: false, mcpReady: false })) });
  }
  async planPortChange(repairMcp: boolean): Promise<PortChangePlan> {
    this.assertSettings();
    if (this.pendingPort === null) throw new Error("没有待生效的端口修改。");
    const base = await this.integrationEngine();
    const target = join(this.dependencies.userData, "app-config.json"), before = await readFile(target, "utf8");
    const config = appConfigSchema.parse(JSON.parse(before)), next = { ...config, port: this.pendingPort };
    const ledger = await readLedger(this.dependencies.userData);
    const selections = (["codex", "claude"] as const).filter(agent => config.integrationChoices?.[agent]?.mcp === "enabled" ||
      Object.values(ledger.artifacts).some(record => record.owners.includes(`${agent}:mcp`))).map(agent => ({ agent, items: ["mcp" as const], conflicts: { mcp: "replace" as const } }));
    // Only the trusted main process supplies the exact before/after transition.
    const engine = repairMcp && selections.length ? new IntegrationEngine(base.env, async () => next, { before, after: serializeAppConfig(next) }) : null;
    const integration = engine ? await engine.plan({ selections }) : null;
    if (await readFile(target, "utf8") !== before) throw new Error("外部配置已变化，请重新预览");
    const planId = randomUUID();
    this.portPlans.clear();
    this.portPlans.set(planId, { before, next, engine, integrationId: integration?.planId ?? null, agents: selections.map(value => value.agent) });
    return { planId, from: config.port, to: next.port, target, diff: `--- ${target}\n+++ ${target}\n-  "port": ${config.port}\n+  "port": ${next.port}`, integration };
  }
  async applyPortChange(planId: string): Promise<PortChangeResult> {
    this.assertSettings();
    const plan = this.portPlans.get(planId); this.portPlans.delete(planId);
    if (!plan) throw new Error("重启计划已失效，请重新预览。");
    const path = join(this.dependencies.userData, "app-config.json");
    if (await readFile(path, "utf8") !== plan.before) throw new Error("外部配置已变化，请重新预览");
    if (plan.engine && plan.integrationId) await plan.engine.validatePendingConfiguration(plan.integrationId);
    const previous = appConfigSchema.parse(JSON.parse(plan.before));
    if (!await (this.dependencies.portAvailable ?? portAvailable)(plan.next.port)) throw new Error(`端口 ${plan.next.port} 已被占用；原配置与服务已保留。`);
    if (await readFile(path, "utf8") !== plan.before) throw new Error("外部配置已变化，请重新预览");
    this.restarting = true;
    try {
      await writeAppConfig(this.dependencies.userData, plan.next);
      try {
        await this.dependencies.stopBackend();
        await this.dependencies.startBackend(plan.next);
        const status = await this.dependencies.backendStatus(plan.next);
        if (!status.serviceReady || !status.mcpReady) throw new Error("新端口后端未就绪");
      } catch (error) {
        // Do not overwrite a user's concurrent edit while recovering a failed start.
        if (await readFile(path, "utf8") !== serializeAppConfig(plan.next)) throw new Error(`新端口启动失败且配置被外部修改；请打开日志并手动恢复：${message(error)}`);
        await writeAppConfig(this.dependencies.userData, previous);
        try {
          await this.dependencies.stopBackend(); await this.dependencies.startBackend(previous);
          const status = await this.dependencies.backendStatus(previous);
          if (!status.serviceReady || !status.mcpReady) throw new Error("原端口后端未就绪");
          this.lastRestart = { port: previous.port, status: "rolled-back", reason: `新端口启动失败，已恢复原端口：${message(error)}`, integration: null };
          await this.dependencies.reloadSettings?.(previous.port);
        } catch (rollbackError) {
          this.lastRestart = { port: previous.port, status: "recovery", reason: `已恢复原端口配置，但原服务启动失败：${message(rollbackError)}；新端口失败：${message(error)}`, integration: null };
          this.startup = backendFailureMode(previous.dataDirectory, this.lastRestart.reason, dataPaths(previous.dataDirectory).desktopLogPath);
          await this.dependencies.changeMode(this.startup);
        }
        return this.lastRestart;
      }
      this.pendingPort = null;
      this.lastRestart = { port: plan.next.port, status: "success", reason: null, integration: null, mcpPending: !!plan.integrationId };
      try { await this.dependencies.reloadSettings?.(plan.next.port); }
      catch (error) {
        this.lastRestart.mcpPending = false;
        this.lastRestart.reason = `端口已生效，但窗口加载失败；未执行 MCP 修复，请重新打开设置：${message(error)}`;
        throw error;
      }
      if (plan.engine && plan.integrationId) {
        try { this.lastRestart.integration = await plan.engine.apply(plan.integrationId, this.dependencies.integrationProgress); }
        catch (error) { this.lastRestart.integration = { planId: plan.integrationId, items: plan.agents.map(agent => ({ agent, item: "mcp", status: "failed", reason: message(error), backups: [] })) }; }
        this.lastRestart.mcpPending = false;
        if (this.lastRestart.integration.items.some(item => item.status !== "success")) this.lastRestart.reason = "端口已生效；部分 Agent MCP 地址修复失败，请在 Agent 页重新预览并修复。";
      }
      return this.lastRestart;
    } finally { this.restarting = false; }
  }
  /** `selected` always comes from the main-process directory dialog, never from the renderer. */
  async planDataMove(mode: DataMoveMode, selected: string): Promise<DataMovePlan> {
    this.assertSettings();
    const from = (await this.integrationConfig()).dataDirectory;
    let inspection = await inspectDataDirectory(selected, this.dependencies.home), to = selected;
    // Like Setup, a non-empty unrelated folder receives a PrecedentLoop subfolder.
    if (mode === "migrate" && inner(inspection).kind === "OTHER_NON_EMPTY") {
      to = join(selected, "PrecedentLoop");
      inspection = await inspectDataDirectory(to, this.dependencies.home);
    }
    const kind = inner(inspection).kind;
    let reason: string | null = null;
    if (await pathsOverlap(from, to)) reason = "新位置不能是当前数据目录、其子目录或上级目录。";
    else if (mode === "migrate" && !["MISSING", "EMPTY"].includes(kind)) reason = kind === "NOT_WRITABLE" ? `无法写入所选位置：${(inner(inspection) as { reason: string }).reason}` : "迁移目标必须是不存在或空的目录；已有知识库请使用“关联其他数据目录”。";
    else if (mode === "associate" && kind !== "PRODUCT") {
      const checked = inner(inspection);
      reason = `${"reason" in checked ? `${checked.reason}。` : ""}请选择已初始化的本产品数据目录；关联不会创建或覆盖文件。`;
    }
    const plan: DataMovePlan = { planId: reason ? null : randomUUID(), mode, from, to, syncRisk: inspection.kind === "SYNC_RISK",
      statistics: reason ? {} : await statistics(mode === "migrate" ? from : to), reason };
    this.dataMovePlans.clear();
    if (plan.planId) this.dataMovePlans.set(plan.planId, plan);
    return plan;
  }
  /** Offline: nothing else writes during a move (user decision 2026-09-24), so there is no
   * writer lock; a failure before switching restarts the original service, and a failure
   * after switching enters recovery. The old directory is always kept. */
  async applyDataMove(planId: string, syncRiskConfirmed: boolean): Promise<DataMoveResult> {
    this.assertSettings();
    const plan = this.dataMovePlans.get(planId); this.dataMovePlans.delete(planId);
    if (!plan) throw new Error("迁移计划已失效，请重新选择位置。");
    if (plan.syncRisk && !syncRiskConfirmed) throw new Error("请先确认同步盘风险。");
    const config = await this.integrationConfig();
    if (config.dataDirectory !== plan.from) throw new Error("数据目录已变化，请重新选择位置。");
    const recheck = inner(await inspectDataDirectory(plan.to, this.dependencies.home)).kind;
    if (plan.mode === "migrate" ? !["MISSING", "EMPTY"].includes(recheck) : recheck !== "PRODUCT") throw new Error("所选位置已变化，请重新选择。");
    const next: AppConfig = { ...config, dataDirectory: plan.to };
    const result: DataMoveResult = { mode: plan.mode, from: plan.from, to: plan.to, status: "failed", reason: null };
    this.restarting = true;
    try {
      await this.dependencies.stopBackend();
      this.backendDirectory = undefined;
      try {
        if (plan.mode === "migrate") {
          Object.assign(result, await copyDataDirectory(plan.from, plan.to));
        }
        await writeAppConfig(this.dependencies.userData, next);
      } catch (error) {
        result.reason = `${message(error)}；数据目录未切换，已保留原目录${plan.mode === "migrate" ? "，新位置中已复制的文件可自行删除" : ""}。`;
        try { await this.dependencies.startBackend(config); this.backendDirectory = config.dataDirectory; }
        catch (restartError) { result.status = "recovery"; result.reason += `原服务重新启动失败：${message(restartError)}`; await this.enterRecovery(config.dataDirectory, result.reason); }
        this.lastDataMove = result;
        if (result.status === "failed") await this.dependencies.reloadSettings?.(config.port, "storage");
        return result;
      }
      try {
        await this.dependencies.startBackend(next);
        const status = await this.dependencies.backendStatus(next);
        if (!status.serviceReady || !status.mcpReady) throw new Error("本地服务未就绪");
        this.backendDirectory = next.dataDirectory;
      } catch (error) {
        result.status = "recovery";
        result.reason = `已切换到新目录，但服务启动失败：${message(error)}。原目录已保留，可在恢复页关联其他数据目录。`;
        this.lastDataMove = result;
        await this.enterRecovery(next.dataDirectory, result.reason);
        return result;
      }
      result.status = "success";
      result.reason = plan.mode === "migrate" ? "迁移完成。旧目录已保留，确认数据无误后可自行删除。" : "已关联新的数据目录。原知识库文件保留在原位置。";
      this.lastDataMove = result;
      this.startup = { mode: "NORMAL", dataDirectory: next.dataDirectory };
      await this.dependencies.changeMode(this.startup);
      await this.dependencies.reloadSettings?.(next.port, "storage");
      return result;
    } finally { this.restarting = false; }
  }
  private async enterRecovery(dataDirectory: string, reason: string): Promise<void> {
    this.startup = backendFailureMode(dataDirectory, reason, dataPaths(dataDirectory).desktopLogPath);
    await this.dependencies.changeMode(this.startup);
  }
  async listCodexProjects() {
    const importer = this.workspaces;
    if (!importer) throw new Error("当前环境没有提供工作区导入。");
    return importer.list();
  }
  async planWorkspaceImport(input: { listId: string; candidateIds: string[] }) {
    const importer = this.workspaces;
    if (!importer) throw new Error("当前环境没有提供工作区导入。");
    return importer.plan(input);
  }
  async importWorkspaces(planId: string) {
    const importer = this.workspaces;
    if (!importer) throw new Error("当前环境没有提供工作区导入。");
    return importer.apply(planId);
  }
  async initialize(): Promise<void> {
    const result = await readSetupState(this.dependencies.userData, this.defaultDataDirectory);
    this.draft = result.state; this.resumed = result.resumed; this.draftWarning = result.warning;
    await this.recheck();
  }
  private emit(step: PreparationStep, status: PreparationProgress["status"], reason?: string): void {
    const value: PreparationProgress = { step, status, ...(reason ? { reason } : {}) };
    this.progress.set(step, value); this.dependencies.progress(value);
  }
  private async save(): Promise<void> {
    this.draft.updatedAt = new Date().toISOString();
    await writeSetupState(this.dependencies.userData, this.draft);
  }
  async getState(): Promise<SetupSnapshot> {
    const config = await readAppConfig(this.dependencies.userData);
    const committed = config.kind === "VALID" && inner(await inspectDataDirectory(config.config.dataDirectory, this.dependencies.home)).kind === "PRODUCT";
    return { startup: this.startup, draft: this.draft, resumed: this.resumed,
      ...(this.draftWarning ? { draftWarning: this.draftWarning } : {}), defaultDataDirectory: this.defaultDataDirectory,
      config: config.kind === "VALID" ? config.config : null, dataCommitted: committed, progress: [...this.progress.values()] };
  }
  private assertSetup(): void { if (this.startup.mode !== "SETUP") throw new Error("当前模式不允许修改初始化设置。"); }
  async saveDraft(input: SetupDraft): Promise<SetupStateFile> {
    this.assertSetup();
    const value = setupDraftSchema.parse(input);
    for (const agent of ["codex", "claude"] as const) if (value.manualPaths[agent] !== this.draft.manualPaths[agent]) this.assertSelectedExecutable(agent, value.manualPaths[agent]);
    const snapshot = await this.getState();
    if (snapshot.dataCommitted && snapshot.config && value.dataDirectory !== snapshot.config.dataDirectory) throw new Error("数据目录已提交，无法在向导中修改。");
    if (!snapshot.dataCommitted && value.step !== 1) throw new Error("请先准备本地数据目录。");
    const detections = this.draft.detections.filter(item => value.manualPaths[item.agent] === this.draft.manualPaths[item.agent]);
    this.draft = { ...this.draft, ...value, detections };
    await this.save();
    for (const agent of ["codex", "claude"] as const) this.selectedExecutables.delete(agent);
    return this.draft;
  }
  async checkDirectory(path: string): Promise<DirectoryCheck> {
    const inspection = await inspectDataDirectory(path, this.dependencies.home);
    const target = inner(inspection).kind === "OTHER_NON_EMPTY" ? join(path, "PrecedentLoop") : path;
    const config = await readAppConfig(this.dependencies.userData);
    let port: number | null = null;
    let portReason: string | undefined;
    try {
      port = config.kind === "VALID" && config.config.dataDirectory === target ? config.config.port : await chooseSetupPort(this.dependencies.portAvailable);
    } catch (error) { portReason = message(error); }
    return { selectedPath: path, dataDirectory: target, inspection, paths: dataPaths(target), port,
      ...(portReason ? { portReason } : {}),
      ...(inner(inspection).kind === "PRODUCT" ? { statistics: await statistics(target) } : {}) };
  }
  private async ensureBackend(config: AppConfig): Promise<void> {
    if (this.backendStarting) { await this.backendStarting; return; }
    if (this.backendDirectory === config.dataDirectory && (await this.dependencies.backendStatus(config).catch(() => ({ serviceReady: false }))).serviceReady) return;
    this.emit("service", "running");
    this.backendStarting = (async () => {
      try {
        await this.dependencies.startBackend(config);
        this.backendDirectory = config.dataDirectory;
        this.emit("service", "done");
      } catch (error) { this.emit("service", "failed", message(error)); throw error; }
    })();
    try { await this.backendStarting; } finally { this.backendStarting = undefined; }
  }
  async prepareDirectory(request: PrepareRequest): Promise<SetupSnapshot> {
    this.assertSetup();
    const snapshot = await this.getState();
    const checked = await this.checkDirectory(request.path);
    const path = checked.dataDirectory;
    if (snapshot.dataCommitted && snapshot.config?.dataDirectory !== path) throw new Error("数据目录已提交，无法在向导中修改。");
    let step: PreparationStep = "folders";
    const options = { syncRiskConfirmed: request.syncRiskConfirmed, ...(this.dependencies.home ? { home: this.dependencies.home } : {}) };
    try {
      // Inspection and consent are checked again in the write methods, never accepted from the renderer.
      const target = await inspectDataDirectory(path, this.dependencies.home);
      if ((target.kind === "SYNC_RISK" || checked.inspection.kind === "SYNC_RISK") && !request.syncRiskConfirmed) throw new Error("请先确认同步盘风险。");
      let kind = inner(target).kind;
      if (!["MISSING", "EMPTY", "PRODUCT_INCOMPLETE", "PRODUCT"].includes(kind)) throw new Error("目标不是可初始化或可用的本产品目录，请选择其他位置。");
      if (this.draft.dataDirectory !== path) this.progress.clear();
      this.draft.dataDirectory = path;
      this.draft.step = 1;
      await this.save();
      if (["MISSING", "EMPTY", "PRODUCT_INCOMPLETE"].includes(kind)) {
        if (this.progress.get("folders")?.status !== "done") this.emit("folders", "running");
        // Idempotent filesystem recheck: only missing entries are created, even on retry.
        await prepareDirectoryLayout(path, options);
      }
      this.emit("folders", "done");
      step = "storage";
      if (kind !== "PRODUCT") {
        this.emit("storage", "running");
        await this.dependencies.stopBackend();
        this.backendDirectory = undefined;
        await initializeStorage(path, this.dependencies.runtime, options);
      }
      await ensureMarker(path, options);
      this.emit("storage", "done");
      step = "service";
      await this.backendStarting?.catch(() => { /* Retry a failed owned startup below. */ });
      const previous = await readAppConfig(this.dependencies.userData);
      const sameConfig = previous.kind === "VALID" && previous.config.dataDirectory === path ? previous.config : null;
      const alreadyRunning = sameConfig && this.backendDirectory === path &&
        (await this.dependencies.backendStatus(sameConfig).catch(() => ({ serviceReady: false }))).serviceReady;
      if (!alreadyRunning) { await this.dependencies.stopBackend(); this.backendDirectory = undefined; }
      const port = alreadyRunning && sameConfig ? sameConfig.port : await chooseSetupPort(this.dependencies.portAvailable);
      const config = sameConfig ? { ...sameConfig, port, setupCompleted: false } : appConfigSchema.parse({
        configVersion: 1, setupVersion: 1, setupCompleted: false, dataDirectory: path, port,
      });
      if (!sameConfig || sameConfig.port !== config.port || sameConfig.setupCompleted) await writeAppConfig(this.dependencies.userData, config);
      await this.ensureBackend(config);
      this.draft.step = 2;
      await this.save();
      return this.getState();
    } catch (error) { this.emit(step, "failed", message(error)); throw error; }
  }
  async detectAgents(input: { agent?: AgentName | undefined } = {}): Promise<AgentDetection[]> {
    if (this.startup.mode === "NORMAL") {
      const config = await this.integrationConfig();
      const agents = input.agent ? [input.agent] : ["codex", "claude"] as const;
      const results = await Promise.all(agents.map(agent => (this.dependencies.detect ?? detectAgent)(agent, config.manualPaths?.[agent] ?? null,
        { ...(this.dependencies.home ? { home: this.dependencies.home } : {}) })));
      this.settingsDetections = [...this.settingsDetections.filter(value => !agents.includes(value.agent)), ...results];
      const detectedPaths = { ...config.detectedPaths };
      for (const result of results) {
        delete detectedPaths[result.agent];
        if (result.source === "auto" && result.path) detectedPaths[result.agent] = result.path;
      }
      if (JSON.stringify(detectedPaths) !== JSON.stringify(config.detectedPaths ?? {})) await writeAppConfig(this.dependencies.userData, { ...config, detectedPaths });
      return this.settingsDetections;
    }
    this.assertSetup();
    const results = await Promise.all((["codex", "claude"] as const).map(agent =>
      (this.dependencies.detect ?? detectAgent)(agent, this.draft.manualPaths[agent], { ...(this.dependencies.home ? { home: this.dependencies.home } : {}) })));
    for (const result of results) {
      if (!this.draft.detections.some(item => item.agent === result.agent)) this.draft.agents[result.agent] = result.found;
    }
    this.draft.detections = results;
    if (!this.draft.aiProvider) this.draft.aiProvider = results.find(item => item.runnable)?.agent ?? null;
    await this.save();
    return results;
  }
  async checkCore(): Promise<CoreCheck[]> {
    await this.backendStarting?.catch(() => { /* Failed startup is represented by the checks below. */ });
    const result = await readAppConfig(this.dependencies.userData);
    const config = result.kind === "VALID" ? result.config : null;
    const directory = config ? inner(await inspectDataDirectory(config.dataDirectory, this.dependencies.home)) : null;
    const usable = directory?.kind === "PRODUCT";
    let runtime: CoreCheck;
    try { runtime = { id: "runtime", ok: true, detail: await this.dependencies.verifyRuntime() }; }
    catch (error) { runtime = { id: "runtime", ok: false, detail: message(error) }; }
    const status = config ? await this.dependencies.backendStatus(config).catch(() => ({ serviceReady: false, mcpReady: false })) : { serviceReady: false, mcpReady: false };
    return [
      { id: "directory", ok: usable, detail: usable ? config!.dataDirectory : "数据目录不可用，请返回本地数据步骤查看原因。" },
      { id: "storage", ok: usable, detail: usable ? "存储已就绪" : "存储未就绪，请选择已初始化的本产品数据目录；新目录需先初始化。" },
      runtime,
      { id: "service", ok: status.serviceReady, detail: status.serviceReady ? "服务已启动 · 索引已就绪" : "本地服务与索引尚未就绪，请重试或打开日志。" },
      { id: "mcp", ok: status.serviceReady && status.mcpReady, detail: config ? `http://127.0.0.1:${config.port}/mcp` : "等待服务" },
    ];
  }
  async complete(): Promise<void> {
    this.assertSetup();
    const before = await readAppConfig(this.dependencies.userData);
    const checks = await this.checkCore();
    if (checks.some(check => !check.ok)) throw new Error("本地核心检查未通过，无法完成设置。");
    const result = await readAppConfig(this.dependencies.userData);
    if (result.kind !== "VALID") throw new Error("配置无效，无法完成设置。");
    if (before.kind !== "VALID" || JSON.stringify(before.config) !== JSON.stringify(result.config)) throw new Error("检查期间配置已变化，请重新检查。");
    const manualPaths = Object.fromEntries(Object.entries(this.draft.manualPaths).filter((entry): entry is [string, string] => entry[1] !== null));
    const detectedPaths = Object.fromEntries(this.draft.detections.filter(item => item.source === "auto" && item.path && !manualPaths[item.agent]).map(item => [item.agent, item.path!]));
    await writeAppConfig(this.dependencies.userData, { ...result.config, setupCompleted: true, setupVersion: 1,
      agents: { ...this.draft.agents }, manualPaths, detectedPaths, integrationChoices: this.draft.integrationChoices ?? {} });
    this.startup = { mode: "NORMAL", dataDirectory: result.config.dataDirectory };
    await this.dependencies.changeMode(this.startup);
  }
  async recheck(): Promise<SetupSnapshot> {
    const result = await readAppConfig(this.dependencies.userData);
    const inspection = result.kind === "VALID" ? await inspectDataDirectory(result.config.dataDirectory, this.dependencies.home) : undefined;
    this.startup = determineStartupMode(result, inspection);
    // No CLI detection on the startup path (design §6.1): AI calls use the persisted
    // detectedPaths, and Settings/status refresh detections after the backend is up.
    if (result.kind === "VALID" && inspection && inner(inspection).kind === "PRODUCT") {
      this.draft.dataDirectory = result.config.dataDirectory;
      if (this.draft.step === 1) this.draft.step = 2;
      this.emit("folders", "done"); this.emit("storage", "done");
      const starting = this.ensureBackend(result.config);
      if (this.startup.mode === "NORMAL") {
        try { await starting; }
        catch (error) { this.startup = backendFailureMode(result.config.dataDirectory, error, dataPaths(result.config.dataDirectory).desktopLogPath); }
      } else void starting.catch(() => { /* Setup keeps its retryable service progress. */ });
    } else if (this.startup.mode === "SETUP") this.draft.step = 1;
    await this.dependencies.changeMode(this.startup);
    return this.getState();
  }
  async selectRecoveryDirectory(path: string): Promise<SetupSnapshot> {
    if (this.startup.mode !== "RECOVERY") throw new Error("仅恢复模式允许关联新的位置。");
    if (inner(await inspectDataDirectory(path, this.dependencies.home)).kind !== "PRODUCT") throw new Error("请选择已初始化的本产品数据目录，不会创建或覆盖文件。");
    await this.dependencies.stopBackend();
    this.backendDirectory = undefined;
    const previous = await readAppConfig(this.dependencies.userData);
    if (previous.kind !== "VALID") throw new Error("app-config.json 无法读取，请先修复配置文件；原文件已保留。");
    // Preserve the old app configuration before changing the association.
    const backup = join(this.dependencies.userData, "backups", new Date().toISOString().replace(/[:.]/gu, "-"));
    await mkdir(backup, { recursive: true });
    await copyFile(join(this.dependencies.userData, "app-config.json"), join(backup, "app-config.json"), constants.COPYFILE_EXCL);
    await writeAppConfig(this.dependencies.userData, { ...previous.config, dataDirectory: path });
    return this.recheck();
  }
  async resetInvalidConfig(): Promise<SetupSnapshot> {
    if (this.startup.mode !== "RECOVERY" || this.startup.code !== "CONFIG_INVALID") throw new Error("仅配置文件无效时允许备份并重新设置。");
    const source = join(this.dependencies.userData, "app-config.json");
    // Read failures are not evidence of damaged JSON. Do not move unreadable files or symlinks.
    if (!(await lstat(source)).isFile()) throw new Error("配置不是普通文件，无法安全备份。");
    const content = await readFile(source);
    let invalid = false;
    try { invalid = !appConfigSchema.safeParse(JSON.parse(content.toString("utf8"))).success; }
    catch { invalid = true; }
    if (!invalid) throw new Error("配置文件已恢复正常，请重新检查；不会移动有效配置。");
    await this.dependencies.stopBackend();
    const timestamp = (this.dependencies.now?.() ?? new Date()).toISOString().replace(/[:.]/gu, "-");
    const backup = join(this.dependencies.userData, "backups", timestamp);
    await mkdir(join(this.dependencies.userData, "backups"), { recursive: true, mode: 0o700 });
    // Reserve a new private directory exclusively. A timestamp/target collision must fail,
    // since rename itself would otherwise overwrite an existing destination file.
    await mkdir(backup, { mode: 0o700 });
    if (!(await readFile(source)).equals(content)) throw new Error("配置文件已变化，请重新检查后再操作。");
    await rename(source, join(backup, "app-config.json"));
    this.draft = { ...this.draft, step: 1, updatedAt: new Date().toISOString() };
    this.resumed = false;
    this.draftWarning = undefined;
    this.progress.clear();
    this.backendDirectory = undefined;
    this.startup = determineStartupMode({ kind: "MISSING" });
    try { await writeSetupState(this.dependencies.userData, this.draft); }
    catch (error) {
      await this.dependencies.changeMode(this.startup);
      throw new Error(`损坏配置已保留在 ${backup}/app-config.json，但草稿保存失败：${message(error)}`);
    }
    await this.dependencies.changeMode(this.startup);
    return this.getState();
  }
}
