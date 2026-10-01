<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SettingsBridge } from "./bridge.js";
import type { LocalSettings, PortChangePlan } from "../../../desktop/src/settings-contract.js";
import { changeTheme, theme } from "./appearance.js";
import { agentNames } from "../setup/integration-presentation.js";
import SettingsDialog from "./SettingsDialog.vue";
const props = defineProps<{ bridge: SettingsBridge | null }>();
const emit = defineEmits<{ dirty: [value: boolean] }>();
const local = ref<LocalSettings>(), port = ref("18888"), editing = ref(false), confirmRestart = ref(false), reset = ref(false), busy = ref(false), error = ref(""), feedback = ref("");
const baseline = computed(() => String(local.value?.pendingPort ?? local.value?.port ?? 18888));
const dirty = computed(() => editing.value && port.value !== baseline.value);
const valid = computed(() => /^\d+$/u.test(port.value) && Number(port.value) >= 1 && Number(port.value) <= 65535);
watch(dirty, value => emit("dirty", value));
async function perform(action: () => Promise<void>) { busy.value = true; error.value = ""; try { await action(); } catch (reason) { error.value = String(reason); } finally { busy.value = false; } }
async function load() { if (props.bridge) { local.value = await props.bridge.getLocalSettings(); port.value = baseline.value; } }
async function save() { await perform(async () => { local.value = await props.bridge!.savePort({ port: Number(port.value) }); editing.value = false; feedback.value = local.value.pendingPort ? '端口已暂存于本次应用会话，重启服务以生效。' : '已取消待生效的端口修改。'; }); }
// No preview (2026-09-24): one confirmation, then plan and apply; Agent connection addresses are always updated.
async function restart() {
  await perform(async () => {
    const plan: PortChangePlan = await props.bridge!.planPortChange({ repairMcp: true });
    confirmRestart.value = false;
    const result = await props.bridge!.applyPortChange({ planId: plan.planId });
    feedback.value = result.reason ?? '端口已生效。'; await load();
  });
}
async function defaults() {
  await perform(async () => {
    local.value = await props.bridge!.restoreDefaults(); port.value = baseline.value; editing.value = false; reset.value = false;
    theme.value = 'dark'; changeTheme();
    // Preserve operation IDs/context: they are recovery facts, not appearance.
    for (const key of Object.keys(localStorage)) if (key.startsWith('hub-integration-dismissed:')) localStorage.removeItem(key);
    feedback.value = local.value.pendingPort ? 'AI 整理与界面偏好已恢复默认。端口 18888 待确认重启后生效。' : '默认设置已恢复。';
  });
}
let poll: ReturnType<typeof setTimeout> | undefined, disposed = false;
async function readRestartResult() {
  if (!props.bridge) return;
  if (poll) clearTimeout(poll);
  try { local.value = await props.bridge.getLocalSettings(); } catch { /* The in-flight restart owns its outcome. */ }
  // Main process remains the source of a result across the port navigation.
  if (!disposed && local.value?.lastRestart?.mcpPending) poll = setTimeout(readRestartResult, 1000);
}
onMounted(async () => {
  await perform(load);
  poll = setTimeout(readRestartResult, 2000);
  if (import.meta.env.DEV && !window.precedentSetup) {
    const scenario = new URLSearchParams(location.search).get("scenario");
    if (scenario === "T8-c") reset.value = true;
    if (scenario === "T8-d") confirmRestart.value = true;
  }
});
onBeforeUnmount(() => { disposed = true; if (poll) clearTimeout(poll); });
</script>
<template>
  <p v-if="error" class="setup-notice error" role="alert">{{ error }}</p><p v-if="feedback" class="setup-notice" role="status">{{ feedback }}</p>
  <section class="settings-section"><div class="settings-section-heading"><h2>服务端口</h2><button v-if="!editing" class="setup-button" :disabled="!bridge || busy" @click="editing = true">编辑</button></div><p class="setup-help">修改后需要重启本地服务。</p><label class="settings-field"><span>端口<small>当前服务：{{ local?.port ?? '未读取' }}</small></span><input v-model="port" type="number" min="1" max="65535" :disabled="!editing || busy || !bridge" /></label><p v-if="editing && !valid" class="setup-notice error">请输入 1–65535 的整数端口。</p><div class="setup-actions settings-form-actions"><span class="setup-spacer"></span><button class="setup-button" :disabled="!editing || busy" @click="port = baseline; editing = false">取消</button><button class="setup-button primary" :disabled="!dirty || !valid || busy" @click="save">保存</button></div>
    <div v-if="local?.pendingPort" class="settings-cli settings-port-pending"><h3>重启服务以生效 · {{ local.pendingPort }}</h3><p class="setup-help">重启时 Agent 中的知识库连接会一并更新。</p><button class="setup-button" :disabled="busy || !bridge" @click="confirmRestart = true">重启服务…</button></div>
    <div v-if="local?.lastRestart" class="settings-restart-result" aria-live="polite"><p>{{ local.lastRestart.reason ?? '端口已生效。' }}</p><p v-for="item in local.lastRestart.integration?.items" :key="item.agent" class="setup-help">{{ agentNames[item.agent] }} MCP · {{ item.status === 'success' ? '已修复' : '需要修复' }}<span v-if="item.reason">：{{ item.reason }}</span></p><button class="setup-link" :disabled="busy" @click="readRestartResult">刷新执行结果</button></div>
  </section>
  <section class="settings-section"><h2>运行环境</h2><div class="settings-field"><span>内置 Node<small>随应用维护，无需手动配置</small></span><code>{{ local?.runtime.nodeVersion ?? '—' }}</code></div><div class="settings-field"><span>架构 / ABI</span><code>{{ local?.runtime.arch ?? '—' }} / {{ local?.runtime.modules ?? '—' }}</code></div></section>
  <section class="settings-section"><h2>日志与诊断</h2><p class="setup-help">日志位置</p><code class="settings-target">{{ local?.paths.logPath.replace(/\/[^/]+$/, '') ?? '请在桌面应用中查看' }}</code><div class="setup-actions"><button class="setup-link" :disabled="!bridge || busy" @click="perform(async () => { await bridge!.openLogs(); })">打开日志</button><button class="setup-button" :disabled="!bridge || busy" @click="perform(async () => { const result = await bridge!.exportDiagnostics(); if (result) feedback = `诊断包已导出：${result.path}`; })">导出诊断包（不含知识正文）</button></div></section>
  <section class="settings-danger"><h2>恢复设置</h2><div class="settings-field"><div><h3>恢复默认设置</h3><p class="setup-help">只重置 AI 整理设置、端口和界面偏好</p></div><button class="setup-button" :disabled="!bridge || busy" @click="reset = true">恢复默认设置…</button></div></section>
  <SettingsDialog :open="reset" title="恢复默认设置？" :busy="busy" @close="reset = false"><p>此操作不影响你的知识库。</p><p>将重置以下设置：AI 整理的自定义提供方、模型、配置档和超时；服务端口（恢复为 18888，重启后生效）；界面偏好。</p><p>不影响知识数据、Agent 接入、Agent 页的 CLI 路径和工作区。如当前 Agent MCP 地址使用其他端口，恢复后可在 Agent 接入页预览并修复。</p><template #actions><button class="setup-button" autofocus :disabled="busy" @click="reset = false">取消</button><button class="setup-button primary" :disabled="busy" @click="defaults">恢复默认设置</button></template></SettingsDialog>
  <SettingsDialog :open="confirmRestart" title="重启服务并更新 Agent 连接？" :busy="busy" @close="confirmRestart = false"><p>端口将从 {{ local?.port }} 改为 {{ local?.pendingPort }}，服务会短暂停止，Codex 与 Claude Code 中的知识库连接会一并更新。</p><p class="setup-help">新端口启动失败时会恢复原端口；某个 Agent 的连接更新失败时，可在 Agent 接入页修复。</p><p v-if="error" class="setup-notice error">{{ error }}</p><template #actions><button class="setup-button" autofocus :disabled="busy" @click="confirmRestart = false">取消</button><button class="setup-button primary" :disabled="busy" @click="restart">{{ busy ? '正在重启…' : '重启' }}</button></template></SettingsDialog>
</template>
