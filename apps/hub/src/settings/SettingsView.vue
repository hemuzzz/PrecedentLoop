<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, ref, watch } from "vue";
import { guardNavigation, navigate, navigateHash, useRoute } from "../navigation.js";
import UiIcon from "../components/UiIcon.vue";
import { settingsBridge, type SettingsBridge } from "./bridge.js";
import { changeTheme, theme } from "./appearance.js";
import SettingsAgents from "./SettingsAgents.vue";
import SettingsStorage from "./SettingsStorage.vue";
import SettingsAi from "./SettingsAi.vue";
import SettingsProjects from "./SettingsProjects.vue";
import SettingsAdvanced from "./SettingsAdvanced.vue";
import SettingsDialog from "./SettingsDialog.vue";

const route = useRoute();
const pages = [
  { id: "general", label: "通用", lede: "外观与应用更新。" },
  { id: "agents", label: "Agent 接入", lede: "让 Codex 与 Claude Code 使用你的知识库。每个 Agent 整体接入或移除，不会卸载 Agent，也不改动你的其他配置。" },
  { id: "storage", label: "数据与存储", lede: "知识原件、索引与工作区配置都保存在这个目录。" },
  { id: "ai", label: "AI 整理", lede: "导入 Markdown 和 AI 改稿时，调用本机的 Codex 或 Claude Code。" },
  { id: "projects", label: "项目与授权", lede: "Agent 在任何项目中都能按需使用这些工作区的知识。" },
  { id: "advanced", label: "高级", lede: "一般无需修改。" },
] as const;
// Earlier builds linked to per-Agent pages; they now live on one Agent page.
const page = computed(() => ["codex", "claude"].includes(route.value.id ?? "") ? "agents" : pages.some(value => value.id === route.value.id) ? route.value.id! : "general");
const current = computed(() => pages.find(value => value.id === page.value)!);
const bridge = ref<SettingsBridge | null>(null), version = ref("—"), loaded = ref(false);
const busy = ref(false), error = ref(""), feedback = ref("");
const dirty = ref(false), leaving = ref<string | null>(null);
if (import.meta.env.DEV && !window.precedentSetup && new URLSearchParams(location.search).get("scenario") === "T9-a") {
  watch(dirty, value => { if (value) leaving.value = "#/settings/general"; }, { once: true });
}
const stopGuard = guardNavigation(hash => { if (dirty.value) { leaving.value = hash; return false; } return true; });
function discard() { const hash = leaving.value; dirty.value = false; leaving.value = null; if (hash !== null) navigateHash(hash, true); }
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = ""; } }
window.addEventListener("beforeunload", beforeUnload);
const disabled = computed(() => !bridge.value || busy.value);

async function perform(action: () => Promise<void>) {
  if (disabled.value) return;
  busy.value = true; error.value = ""; feedback.value = "";
  try { await action(); } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { busy.value = false; }
}
async function checkUpdates() {
  await perform(async () => {
    await bridge.value!.checkForUpdates();
    if (import.meta.env.DEV && !window.precedentSetup) feedback.value = "开发演示：检查更新入口已触发，不执行真实下载或安装。";
  });
}
onActivated(async () => {
  try {
    bridge.value = await settingsBridge();
    if (bridge.value) version.value = (await bridge.value.getAppInfo()).version;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { loaded.value = true; }
});
onBeforeUnmount(() => { stopGuard(); window.removeEventListener("beforeunload", beforeUnload); });
</script>

<template>
  <main class="settings-view">
    <header class="settings-breadcrumb"><span>设置 <span class="settings-slash">/</span> {{ current.label }}</span><button class="setup-link" @click="navigate('status')"><UiIcon name="activity" />系统状态</button></header>
    <p v-if="loaded && !bridge" class="integration-notice"><UiIcon name="info" />请在桌面应用中修改本机配置</p>
    <div class="settings-layout">
      <nav class="settings-navigation" aria-label="设置分类"><h2>设置</h2><button v-for="entry in pages" :key="entry.id" :class="{ active: page === entry.id }" :aria-current="page === entry.id ? 'page' : undefined" @click="navigate('settings', entry.id)">{{ entry.label }}</button></nav>
      <div class="settings-mobile"><select aria-label="设置分类" :value="page" @change="navigate('settings', ($event.target as HTMLSelectElement).value)"><option v-for="entry in pages" :key="entry.id" :value="entry.id">{{ entry.label }}</option></select></div>
      <div class="settings-scroll"><div class="settings-content">
        <header class="settings-heading"><h1>{{ current.label }}</h1><p>{{ current.lede }}</p></header>
        <p v-if="error" class="setup-notice error" role="alert">{{ error }}</p>
        <p v-if="feedback" class="setup-notice" role="status">{{ feedback }}</p>
        <template v-if="loaded">
          <SettingsAgents v-if="page === 'agents'" :key="String(!!bridge)" :bridge="bridge" />
          <SettingsStorage v-else-if="page === 'storage'" :bridge="bridge" />
          <SettingsAi v-else-if="page === 'ai'" :bridge="bridge" @dirty="dirty = $event" />
          <SettingsProjects v-else-if="page === 'projects'" :bridge="bridge" />
          <SettingsAdvanced v-else-if="page === 'advanced'" :bridge="bridge" @dirty="dirty = $event" />
          <template v-else>
            <section class="settings-section"><div class="settings-field"><div><h2>外观</h2><p class="setup-help">更改后立即生效</p></div><fieldset class="settings-themes" aria-label="外观"><label v-for="option in [{ value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }, { value: 'system', label: '跟随系统' }]" :key="option.value" :class="{ selected: theme === option.value }"><input v-model="theme" type="radio" name="theme" :value="option.value" @change="changeTheme" />{{ option.label }}</label></fieldset></div>
              <div class="settings-field"><div><h2>关闭窗口</h2><p class="setup-help">关闭窗口后知识库服务继续运行，Agent 仍可使用；按 ⌘Q 退出后停止。</p></div></div>
              <div class="settings-field"><div><h2>应用更新</h2><p class="setup-help">当前版本 {{ version }} · 由你决定何时下载与安装</p></div><button class="setup-button" :disabled="disabled" @click="checkUpdates">检查更新</button></div>
              <div class="settings-field"><div><h2>打开设置</h2><p class="setup-help">快捷键</p></div><kbd>⌘,</kbd></div></section>
          </template>
        </template>
        <footer class="settings-diagnostics"><span class="setup-help">运行诊断请前往</span><button class="setup-link" @click="navigate('status')">系统状态</button><button class="setup-link" :disabled="disabled" @click="perform(async () => { await bridge!.openLogs(); })">打开日志</button></footer>
      </div></div>
    </div>
    <SettingsDialog :open="leaving !== null" title="放弃未保存的修改？" @close="leaving = null"><p>{{ page === 'ai' ? 'AI 整理设置尚未保存。离开后，本次对模型与超时的修改将丢失。' : '端口设置尚未保存。离开后，本次修改将丢失。' }}</p><template #actions><button class="setup-button" autofocus @click="leaving = null">继续编辑</button><button class="setup-button primary" @click="discard">放弃修改</button></template></SettingsDialog>
  </main>
</template>
