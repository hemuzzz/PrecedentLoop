<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { SettingsBridge } from "./bridge.js";
import type { DataMoveMode, DataMovePlan, LocalSettings } from "../../../desktop/src/settings-contract.js";
import { settingsData } from "./data.js";
import SettingsDialog from "./SettingsDialog.vue";
const props = defineProps<{ bridge: SettingsBridge | null }>();
const local = ref<LocalSettings>(), storage = ref<{ managed: boolean; pending: number }>(), error = ref("");
const moving = ref<DataMoveMode | null>(null), plan = ref<DataMovePlan | null>(null), syncConfirmed = ref(false), busy = ref(false), moveError = ref("");
const titles: Record<DataMoveMode, string> = { migrate: "迁移到新位置", associate: "关联其他数据目录" };
const canApply = computed(() => !!plan.value?.planId && (!plan.value.syncRisk || syncConfirmed.value) && !busy.value);
const result = computed(() => local.value?.lastDataMove ?? null);
async function reveal() { try { await props.bridge?.revealSettingsPath({ target: "data" }); } catch (reason) { error.value = String(reason); } }
function open(mode: DataMoveMode) { moving.value = mode; plan.value = null; syncConfirmed.value = false; moveError.value = ""; }
function close() { if (!busy.value) moving.value = null; }
async function choose() {
  if (!props.bridge || !moving.value) return;
  busy.value = true; moveError.value = "";
  try { const chosen = await props.bridge.planDataMove({ mode: moving.value }); if (chosen) { plan.value = chosen; syncConfirmed.value = false; } }
  catch (reason) { moveError.value = String(reason); } finally { busy.value = false; }
}
async function apply() {
  if (!props.bridge || !plan.value?.planId) return;
  busy.value = true; moveError.value = "";
  // The desktop app restarts the service and reloads this page; the result is read back from the main process.
  try { await props.bridge.applyDataMove({ planId: plan.value.planId, syncRiskConfirmed: syncConfirmed.value }); moving.value = null; await load(); }
  catch (reason) { moveError.value = String(reason); } finally { busy.value = false; }
}
async function load() { if (props.bridge) local.value = await props.bridge.getLocalSettings(); storage.value = await (await settingsData()).storage(); }
onMounted(async () => {
  try { await load(); } catch (reason) { error.value = String(reason); }
  if (import.meta.env.DEV && !window.precedentSetup) {
    const scenario = new URLSearchParams(location.search).get("scenario");
    if (scenario === "T2-b" || scenario === "T2-c") { open(scenario === "T2-b" ? "migrate" : "associate"); await choose(); }
  }
});
</script>
<template>
  <p v-if="error" class="setup-notice error" role="alert">{{ error }}</p>
  <p v-if="result" class="setup-notice" :class="{ error: result.status !== 'success' }" role="status">{{ result.reason }}<template v-if="result.status === 'success' && result.files !== undefined">（已复制并校验 {{ result.files }} 个文件）</template></p>
  <section class="settings-section"><div class="settings-section-heading"><h2>数据目录</h2><button class="setup-link" :disabled="!bridge" @click="reveal">在 Finder 中显示</button></div><div class="settings-cli"><code>{{ local?.dataDirectory ?? '请在桌面应用中查看本机路径' }}</code></div><p class="setup-help">知识原件、索引与工作区配置保存在此目录。</p>
    <div class="setup-actions"><button class="setup-button" :disabled="!bridge || busy" @click="open('migrate')">迁移到新位置…</button><button class="setup-button" :disabled="!bridge || busy" @click="open('associate')">关联其他数据目录…</button></div>
    <p class="setup-help">迁移会保留旧目录；关联只切换正在使用的知识库。</p></section>
  <section class="settings-section"><div class="settings-field"><h2>候选存储</h2><span class="setup-status" :class="storage?.managed ? 'ok' : 'neutral'">{{ storage ? storage.managed ? '已就绪' : '尚未就绪' : '正在读取…' }}</span></div><div class="settings-field"><h2>待处理候选</h2><span>{{ storage?.pending ?? '—' }} 项</span></div></section>
  <details class="settings-details"><summary>高级详情</summary><dl v-if="local"><template v-for="row in [{ label: 'Runtime 数据库', path: local.paths.databasePath }, { label: '工作区配置 workspaces.json', path: local.paths.workspaceConfigPath }, { label: '日志', path: local.paths.logPath.replace(/\/[^/]+$/, '') }]" :key="row.label"><dt>{{ row.label }}</dt><dd><code>{{ row.path }}</code></dd></template></dl></details>

  <SettingsDialog :open="moving !== null" :title="moving ? titles[moving] : ''" :busy="busy" @close="close">
    <template v-if="moving === 'migrate'">
      <p class="setup-help">完整复制知识、候选、操作记录与工作区配置。</p>
      <div class="settings-field"><span>当前位置</span><code>{{ local?.dataDirectory }}</code></div>
      <div class="settings-field"><span>新位置</span><code v-if="plan">{{ plan.to }}</code><span v-else class="setup-help">尚未选择</span><button class="setup-button" :disabled="busy" @click="choose">选择…</button></div>
      <ol class="settings-steps"><li>停止本地服务（迁移期间请勿使用 Codex／Claude Code 的知识功能）</li><li>复制所有数据，并逐文件校验</li><li>切换到新目录，启动服务并检查</li></ol>
      <p class="setup-help">旧目录将保留。迁移完成并确认数据无误后，可由你自行删除。</p>
    </template>
    <template v-else-if="moving === 'associate'">
      <p class="setup-help">切换到已有知识库，不合并两个知识库。</p>
      <div class="settings-field"><span>已有数据目录</span><code v-if="plan">{{ plan.to }}</code><span v-else class="setup-help">尚未选择</span><button class="setup-button" :disabled="busy" @click="choose">选择已有数据目录…</button></div>
      <p v-if="plan?.planId" class="setup-help">找到已有知识库：已登记工作区 {{ plan.statistics.workspaces ?? '—' }} 个。</p>
      <p class="setup-help">将停止当前服务，切换数据目录并重新启动。当前知识库文件会保留在原位置。</p>
    </template>
    <p v-if="plan?.reason" class="setup-notice error" role="alert">{{ plan.reason }}</p>
    <template v-if="plan?.planId && plan.syncRisk"><p class="setup-notice error">此位置位于 iCloud Drive 或其他同步盘。同步冲突可能影响正在使用的数据库，请优先选择本地文件夹。</p><label class="setup-check"><input v-model="syncConfirmed" type="checkbox" :disabled="busy" />我了解风险，仍然使用</label></template>
    <p v-if="moveError" class="setup-notice error" role="alert">{{ moveError }}</p>
    <template #actions><button class="setup-button" autofocus :disabled="busy" @click="close">取消</button><button class="setup-button primary" :disabled="!canApply" @click="apply">{{ busy && plan?.planId ? (moving === 'migrate' ? '正在迁移…' : '正在切换…') : moving === 'migrate' ? '确认并迁移' : '确认关联' }}</button></template>
  </SettingsDialog>
</template>
