import { computed, reactive, ref, type Ref, type UnwrapNestedRefs } from "vue";
import type { AgentDetection, AgentName, IntegrationItem, IntegrationProgress, IntegrationResult, IntegrationStatus,
  SetupBridge, SetupDraft, StatusRequest, WorkspaceImportPreview, WorkspaceImportResult } from "./bridge.js";
import { agents, items } from "./integration-presentation.js";
import type { SettingsBridge } from "../../../desktop/src/setup-contract.js";

/**
 * Integration state shared by Setup Step 3/4 and the Settings Agent page.
 * Since 2026-09-24 all four items are mandatory and there is no preview: Setup configures
 * every connected Agent in one step, Settings repairs items or removes an Agent as a whole.
 */
export function useIntegrations(getBridge: () => SetupBridge | SettingsBridge, draft: Ref<SetupDraft | undefined>, detections: Ref<AgentDetection[]>, mode: "setup" | "settings" = "setup") {
  const statuses = ref<IntegrationStatus[]>([]);
  // Only an external same-name entry needs a choice: keep it (default) or replace it.
  const conflicts = reactive<Record<AgentName, Partial<Record<IntegrationItem, "preserve" | "replace">>>>({ codex: {}, claude: {} });
  const activeAgents = computed(() => agents.filter(agent => draft.value?.agents[agent] && detections.value.some(value => value.agent === agent && value.found)));
  const busy = ref(false), error = ref("");
  const phase = ref<"selection" | "applying" | "results">("selection");
  const applied = ref(false);
  const projects = ref<WorkspaceImportPreview | null>(null), selectedProjects = ref<string[]>([]);
  const workspaceResult = ref<WorkspaceImportResult | null>(null), workspaceError = ref("");
  const progress = ref<Array<Omit<IntegrationProgress, "status"> & { status: IntegrationProgress["status"] | "waiting" }>>([]);
  const results = ref<IntegrationResult["items"]>([]);
  let activePlanId: string | null = null;

  function choices(): StatusRequest {
    return { choices: Object.fromEntries(agents.map(agent => [agent, Object.fromEntries(items.map(item => [item,
      activeAgents.value.includes(agent) ? "enabled" : "skipped"]))])) };
  }
  async function refreshStatus() { statuses.value = await getBridge().getIntegrationStatus(mode === "settings" ? {} : choices()); }
  async function loadProjects() {
    const bridge = getBridge();
    if (mode === "settings" || !("listCodexProjects" in bridge)) return;
    const previous = projects.value;
    const paths = new Set(previous?.projects.flatMap(project => project.paths).filter(path => selectedProjects.value.includes(path.candidateId)).map(path => path.path));
    projects.value = await bridge.listCodexProjects();
    // New, usable projects are selected by default; excluded ones carry a reason and cannot be chosen.
    selectedProjects.value = projects.value.projects.flatMap(project => project.paths).filter(path => path.exists && !path.reason && (!previous || paths.has(path.path))).map(path => path.candidateId);
  }
  async function run(action: () => Promise<void>) {
    if (busy.value) return;
    busy.value = true; error.value = "";
    try { await action(); }
    catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
    finally { busy.value = false; }
  }
  async function initialize(withProjects: boolean) {
    await run(async () => { await refreshStatus(); if (withProjects) await loadProjects(); });
  }
  function receiveProgress(value: IntegrationProgress) {
    if (value.planId !== activePlanId) return;
    applied.value = true;
    progress.value = progress.value.map(row => row.agent === value.agent && row.item === value.item ? value : row);
  }
  async function persistChoices() {
    const bridge = getBridge(), value = draft.value;
    if (mode !== "setup" || !value || !("saveDraft" in bridge)) return;
    const saved = await bridge.saveDraft({ step: value.step, dataDirectory: value.dataDirectory, agents: { ...value.agents },
      manualPaths: { ...value.manualPaths }, aiProvider: value.aiProvider, integrationChoices: choices().choices });
    value.integrationChoices = saved.integrationChoices;
  }
  /** Setup: plan and apply every item for each connected Agent, then register the chosen workspaces. */
  async function configure() {
    await run(async () => {
      const bridge = getBridge();
      workspaceError.value = ""; workspaceResult.value = null; results.value = [];
      await persistChoices();
      const selections = activeAgents.value.map(agent => ({ agent, items: [...items], conflicts: { ...conflicts[agent] } }));
      const chosen = [...selectedProjects.value];
      phase.value = "applying"; progress.value = [];
      try {
        if (selections.length) {
          const plan = await bridge.planIntegrations({ selections });
          progress.value = plan.items.map(item => ({ planId: plan.planId, agent: item.agent, item: item.item, status: "waiting", reason: null }));
          activePlanId = plan.planId;
          const result = await bridge.applyIntegrations({ planId: plan.planId });
          applied.value = true;
          for (const item of result.items) receiveProgress({ planId: plan.planId, ...item });
          results.value = result.items;
        }
        if (chosen.length && projects.value?.planId && "planWorkspaceImport" in bridge) {
          try {
            const planned = await bridge.planWorkspaceImport({ listId: projects.value.planId, candidateIds: chosen });
            workspaceResult.value = await bridge.importWorkspaces({ planId: planned.planId });
            applied.value = true;
          } catch (reason) { workspaceError.value = reason instanceof Error ? reason.message : String(reason); }
        }
        phase.value = "results";
      } catch (reason) {
        // Nothing was written if planning failed; a failed apply leaves completed items in place.
        phase.value = applied.value ? "results" : "selection";
        error.value = reason instanceof Error ? reason.message : String(reason);
      } finally {
        activePlanId = null;
        try { await refreshStatus(); await loadProjects(); } catch { /* Keep the actionable error above. */ }
      }
    });
  }
  /** Settings: configure or repair one Agent's items, or remove the Agent as a whole. */
  async function execute(kind: "install" | "remove", agent: AgentName, list: IntegrationItem[] = [...items]) {
    await run(async () => {
      const bridge = getBridge();
      results.value = []; phase.value = "applying"; progress.value = [];
      try {
        const plan = kind === "install"
          ? await bridge.planIntegrations({ agent, items: list, conflicts: { ...conflicts[agent] } })
          : await bridge.planIntegrationRemoval({ agent, items: [...items] });
        progress.value = plan.items.map(item => ({ planId: plan.planId, agent: item.agent, item: item.item, status: "waiting", reason: null }));
        activePlanId = plan.planId;
        const result = await bridge.applyIntegrations({ planId: plan.planId });
        applied.value = true;
        for (const item of result.items) receiveProgress({ planId: plan.planId, ...item });
        results.value = result.items;
      } catch (reason) {
        error.value = reason instanceof Error ? reason.message : String(reason);
      } finally {
        phase.value = "results"; activePlanId = null;
        try { await refreshStatus(); } catch { /* Keep the actionable error above. */ }
      }
    });
  }
  return { statuses, conflicts, activeAgents, busy, error, phase, applied, projects, selectedProjects, workspaceResult, workspaceError,
    progress, results, initialize, refreshStatus, receiveProgress, choices, configure, execute };
}
export type SetupIntegrations = UnwrapNestedRefs<ReturnType<typeof useIntegrations>>;
