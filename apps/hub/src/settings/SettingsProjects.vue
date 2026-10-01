<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { SettingsBridge } from "./bridge.js";
import type { WorkspaceImportPreview } from "../setup/bridge.js";
import { settingsData, type SettingsWorkspace } from "./data.js";
import SettingsDialog from "./SettingsDialog.vue";
const props = defineProps<{ bridge: SettingsBridge | null }>();
const projects = ref<SettingsWorkspace[]>([]), configPath = ref(""), list = ref<WorkspaceImportPreview>(), selected = ref<string[]>([]);
const dialog = ref(false), busy = ref(false), error = ref(""), feedback = ref("");
const sourceNames = { codex: "Codex", claude: "Claude" } as const;
const candidates = computed(() => (list.value?.projects ?? []).flatMap(project => project.paths
  .filter(path => path.exists && !path.reason).map(path => ({ ...path, name: project.name, sources: project.sources }))));
const excluded = computed(() => (list.value?.projects ?? []).flatMap(project => project.paths
  .filter(path => path.reason && path.reason !== "已登记").map(path => ({ ...path, name: project.name }))));
async function load() { projects.value = await (await settingsData()).workspaces(); if (props.bridge) configPath.value = (await props.bridge.getLocalSettings()).paths.workspaceConfigPath; }
async function perform(action: () => Promise<void>) { busy.value = true; error.value = ""; try { await action(); } catch (reason) { error.value = String(reason); } finally { busy.value = false; } }
async function open() {
  dialog.value = true; feedback.value = "";
  await perform(async () => { list.value = await props.bridge!.listCodexProjects(); selected.value = candidates.value.map(path => path.candidateId); });
}
// No preview (2026-09-24): plan and apply in one step; the plan still re-checks the config and project list.
async function add() {
  await perform(async () => {
    const plan = await props.bridge!.planWorkspaceImport({ listId: list.value!.planId!, candidateIds: selected.value });
    const result = await props.bridge!.importWorkspaces({ planId: plan.planId });
    feedback.value = `已登记 ${result.imported} 个新项目。无需重启服务，Agent 下一次提问即可使用。`;
    dialog.value = false; await load();
  });
}
onMounted(async () => { await perform(load); if (import.meta.env.DEV && !window.precedentSetup && ["T7-e", "T7-f"].includes(new URLSearchParams(location.search).get("scenario") ?? "")) await open(); });
</script>
<template>
  <p v-if="error && !dialog" class="setup-notice error" role="alert">{{ error }}</p><p v-if="feedback" class="setup-notice" role="status">{{ feedback }}</p>
  <div class="settings-section-heading"><h2>工作区 {{ projects.length }}</h2><button class="setup-button" :disabled="!bridge || busy" @click="open">从最近项目添加…</button></div>
  <div v-if="projects.length" class="setup-table-card">
    <table class="setup-workspace-table settings-projects-table"><tbody>
      <tr v-for="project in projects" :key="project.name">
        <td class="name" :title="project.name">{{ project.name }}<small v-if="project.aliases.length">别名：{{ project.aliases.join('、') }}</small></td>
        <td class="path"><code :title="project.paths.join(' · ')">{{ project.paths.join(' · ') }}</code><small v-if="project.description">{{ project.description }}</small></td>
      </tr>
    </tbody></table>
  </div>
  <p v-else class="setup-help">尚未登记工作区。</p>
  <p class="setup-help">全局知识不属于任何工作区。别名与说明请在配置文件中维护。</p>
  <div class="settings-cli"><code>{{ configPath || '请在桌面应用中查看配置文件路径' }}</code><div class="setup-actions"><button class="setup-link" :disabled="!bridge || busy" @click="perform(async () => { await bridge!.revealSettingsPath({ target: 'workspaces' }); })">在 Finder 中显示</button></div></div>
  <SettingsDialog :open="dialog" title="从最近项目添加" :busy="busy" @close="dialog = false">
    <p class="setup-help">来自 Codex 与 Claude Code，名称相同的已合并。已登记的工作区保持原样。</p>
    <p v-if="error" class="setup-notice error" role="alert">{{ error }}</p>
    <p v-if="list?.reason" class="setup-notice">{{ list.reason }}</p>
    <div v-if="candidates.length" class="setup-table-card"><table class="setup-workspace-table"><tbody>
      <tr v-for="candidate in candidates" :key="candidate.candidateId">
        <td class="check"><input v-model="selected" class="setup-box" type="checkbox" :value="candidate.candidateId" :aria-label="`添加 ${candidate.name}`" :disabled="busy" /></td>
        <td class="name" :title="candidate.name">{{ candidate.name }}</td>
        <td class="path"><code :title="candidate.path">{{ candidate.path }}</code></td>
        <td class="tags"><span v-for="source in candidate.sources" :key="source" class="setup-chip accent">{{ sourceNames[source] }}</span></td>
      </tr>
    </tbody></table></div>
    <p v-else-if="list && !list.reason" class="setup-help">没有可添加的新项目。</p>
    <details v-if="excluded.length" class="setup-excluded"><summary>已自动排除 {{ excluded.length }} 项</summary><ul><li v-for="item in excluded" :key="item.candidateId"><code>{{ item.path }}</code>：{{ item.reason }}</li></ul></details>
    <template #actions><button class="setup-button" autofocus :disabled="busy" @click="dialog = false">取消</button><button class="setup-button primary" :disabled="busy || !list?.planId || !selected.length" @click="add">{{ busy ? '正在添加…' : `添加 ${selected.length} 个项目` }}</button></template>
  </SettingsDialog>
</template>
