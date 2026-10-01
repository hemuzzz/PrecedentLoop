<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { navigate } from "../navigation.js";
import type { AiConfiguration, AiOverrides, AiTestResult } from "../api/types.js";
import type { AgentDetection } from "../setup/bridge.js";
import type { AiModelCatalogs } from "../../../desktop/src/ai-models.js";
import type { SettingsBridge } from "./bridge.js";
import { agentNames, agents } from "../setup/integration-presentation.js";
import { settingsData } from "./data.js";
import SettingsDialog from "./SettingsDialog.vue";
const props = defineProps<{ bridge: SettingsBridge | null }>();
// CLI paths are managed on the Agent page; this page only shows the detected result.
const detections = ref<AgentDetection[]>([]);
const loading = ref(true), detectionFailed = ref(false);
function cliPath(agent: "codex" | "claude"): string {
  if (loading.value) return "读取中…";
  if (detectionFailed.value) return "CLI 信息读取失败";
  const detection = detections.value.find(value => value.agent === agent);
  const executable = configuration.value?.providers.find(value => value.id === agent)?.executable;
  if (detection?.path || executable) return detection?.path || executable!;
  if (!configuration.value) return "CLI 信息读取失败";
  return "未检测到 CLI";
}
const emit = defineEmits<{ dirty: [value: boolean] }>();
const configuration = ref<AiConfiguration>(), editing = ref(false), busy = ref(false), error = ref(""), feedback = ref("");
const provider = ref<"" | "codex" | "claude">(""), testProvider = ref<"codex" | "claude">("codex"), confirmTest = ref(false), result = ref<AiTestResult>();
const fields = reactive({ codex: { model: "", effort: "", timeout: "" }, claude: { model: "", effort: "", timeout: "" } });
// Codex profiles are no longer edited here (2026-09-25); a hand-written profile is kept on save until "恢复默认".
const profile = ref("");
// What each CLI offers locally; empty lists fall back to free text.
const catalogs = ref<AiModelCatalogs>();
const effortNames: Record<string, string> = { minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高", ultra: "极限" };
const effortName = (value: string) => effortNames[value] ?? value;
function catalog(agent: "codex" | "claude") { return catalogs.value?.[agent]; }
function modelLabel(agent: "codex" | "claude", id: string | null | undefined) { return id ? catalog(agent)?.models.find(model => model.id === id)?.label ?? id : null; }
function modelOptions(agent: "codex" | "claude") {
  const models = catalog(agent)?.models ?? [], saved = fields[agent].model.trim();
  return saved && !models.some(model => model.id === saved) ? [...models, { id: saved, label: saved, efforts: [], defaultEffort: null }] : models;
}
function effectiveModel(agent: "codex" | "claude") { return catalog(agent)?.models.find(model => model.id === (fields[agent].model.trim() || catalog(agent)?.current.model)); }
function effortOptions(agent: "codex" | "claude") {
  const model = effectiveModel(agent), list = model?.efforts.length ? model.efforts : catalog(agent)?.efforts ?? [], saved = fields[agent].effort;
  return saved && !list.includes(saved) ? [...list, saved] : list;
}
function defaultModelText(agent: "codex" | "claude") { return modelLabel(agent, configuration.value?.defaults.find(value => value.id === agent)?.model ?? catalog(agent)?.current.model) ?? "CLI 默认模型"; }
function defaultEffortText(agent: "codex" | "claude") {
  const value = catalog(agent)?.current.effort ?? effectiveModel(agent)?.defaultEffort;
  return value ? effortName(value) : "CLI 默认档位";
}
// Switching model drops a level the new model does not support.
for (const agent of agents) watch(() => fields[agent].model, () => {
  const model = effectiveModel(agent);
  if (fields[agent].effort && model?.efforts.length && !model.efforts.includes(fields[agent].effort)) fields[agent].effort = "";
});
const baseline = ref("");
const state = computed(() => JSON.stringify({ provider: provider.value, fields, profile: profile.value }));
const dirty = computed(() => editing.value && state.value !== baseline.value);
watch(dirty, value => emit("dirty", value));
function resetForm() {
  provider.value = configuration.value?.overrides.defaultProvider ?? "";
  for (const agent of agents) {
    const value = configuration.value?.overrides.providers?.[agent];
    fields[agent] = { model: value?.model ?? "", effort: value?.effort ?? "", timeout: value?.timeoutMs === undefined ? "" : String(value.timeoutMs / 1000) };
  }
  profile.value = configuration.value?.overrides.providers?.codex?.profile ?? "";
  baseline.value = state.value;
}
async function load() { configuration.value = await (await settingsData()).aiSettings(); testProvider.value = configuration.value.defaultProvider; resetForm(); }
const valid = computed(() => agents.every(agent => (!fields[agent].timeout || (Number.isInteger(Number(fields[agent].timeout) * 1000) && Number(fields[agent].timeout) >= 1 && Number(fields[agent].timeout) <= 3600)) && fields[agent].model.length <= 256 && /^[a-z]{0,16}$/u.test(fields[agent].effort)));
async function save() {
  if (!props.bridge || !valid.value) return;
  busy.value = true; error.value = "";
  try {
    const ai: AiOverrides = {};
    if (provider.value) ai.defaultProvider = provider.value;
    for (const agent of agents) {
      const input = fields[agent], value = { ...(input.model.trim() ? { model: input.model.trim() } : {}), ...(input.effort ? { effort: input.effort } : {}),
        ...(input.timeout ? { timeoutMs: Number(input.timeout) * 1000 } : {}), ...(agent === "codex" && profile.value ? { profile: profile.value } : {}) };
      if (Object.keys(value).length) (ai.providers ??= {})[agent] = value;
    }
    await props.bridge.saveAiSettings({ ai }); await load(); editing.value = false; feedback.value = "已保存，下次调用生效。";
  } catch (reason) { error.value = String(reason); } finally { busy.value = false; }
}
function defaults() { provider.value = ""; profile.value = ""; for (const agent of agents) fields[agent] = { model: "", effort: "", timeout: "" }; editing.value = true; }
async function test() {
  confirmTest.value = false; busy.value = true; error.value = ""; result.value = undefined;
  try { result.value = await (await settingsData()).testAi(testProvider.value); } catch (reason) { error.value = String(reason); } finally { busy.value = false; }
}
onMounted(async () => {
  if (props.bridge) {
    try { detections.value = await props.bridge.detectAgents({}); } catch { detectionFailed.value = true; }
    try { catalogs.value = await props.bridge.listAiModels(); } catch { /* Model lists stay unknown; free text still works. */ }
  }
  try {
    await load();
    if (import.meta.env.DEV && !window.precedentSetup) {
      const scenario = new URLSearchParams(location.search).get("scenario");
      if (scenario === "T6-b" || scenario === "T9-a") { editing.value = true; fields.codex.model = "custom-model"; fields.codex.timeout = "180"; }
      if (scenario === "T6-c") confirmTest.value = true;
      if (scenario === "T6-d") result.value = { success: true, durationMs: 1200 };
      if (scenario === "T6-e") result.value = { success: false, durationMs: 600000, error: { code: "AI_TIMEOUT", message: "请求在 600 秒内未完成。请检查 CLI 状态或调整超时后重试。" } };
    }
  } catch (reason) { error.value = String(reason); }
  finally { loading.value = false; }
});
</script>
<template>
  <p class="setup-help">知识库调用 Agent 的命令行工具，用于导入 Markdown 和 AI 改稿。不会改变 Agent 使用知识库的接入状态。</p>
  <p v-if="error" class="setup-notice error" role="alert">{{ error }}</p><p v-if="feedback" class="setup-notice" role="status">{{ feedback }}</p>
  <div class="settings-section-heading"><span class="setup-help">{{ dirty ? '有未保存的修改' : '保存后下次调用生效' }}</span><button v-if="!editing" class="setup-button" :disabled="!bridge || busy || !configuration" @click="editing = true">编辑</button></div>
  <fieldset class="settings-form" :disabled="!editing || !bridge || busy"><label class="settings-field"><span>默认提供方</span><select v-model="provider"><option value="">默认 · {{ agentNames[configuration?.defaults[0]?.id ?? 'codex'] }}</option><option value="codex">Codex CLI</option><option value="claude">Claude Code</option></select></label></fieldset>
  <section v-for="agent in agents" :key="agent" class="settings-section"><h2>{{ agentNames[agent] }}</h2><div class="settings-field"><div class="settings-cli-path"><code>{{ cliPath(agent) }}</code><span v-if="!loading && !detectionFailed && detections.some(value => value.agent === agent)" class="setup-chip">{{ detections.find(value => value.agent === agent)?.source === 'manual' ? '手动指定' : '自动检测' }}</span></div><button class="setup-link" @click="navigate('settings', 'agents')">在 Agent 接入页修改</button></div>
    <fieldset class="settings-form" :disabled="!editing || !bridge || busy">
      <label class="settings-field"><span>模型<small>不选时使用 {{ agentNames[agent] }} 自身的设置</small></span>
        <select v-if="catalog(agent)?.models.length" v-model="fields[agent].model"><option value="">默认 · {{ defaultModelText(agent) }}</option><option v-for="model in modelOptions(agent)" :key="model.id" :value="model.id">{{ model.label }}</option></select>
        <input v-else v-model="fields[agent].model" maxlength="256" :placeholder="`默认 · ${defaultModelText(agent)}`" /></label>
      <label class="settings-field"><span>推理档位<small>档位越高越慢，整理质量通常更好</small></span>
        <select v-if="effortOptions(agent).length" v-model="fields[agent].effort"><option value="">默认 · {{ defaultEffortText(agent) }}</option><option v-for="level in effortOptions(agent)" :key="level" :value="level">{{ effortName(level) }}</option></select>
        <input v-else v-model="fields[agent].effort" maxlength="16" :placeholder="`默认 · ${defaultEffortText(agent)}`" /></label>
      <label class="settings-field"><span>超时（秒）<small v-if="loading">读取中…</small><small v-else-if="configuration?.defaults.find(value => value.id === agent)">默认：{{ configuration.defaults.find(value => value.id === agent)!.timeoutMs / 1000 }} 秒</small><small v-else>默认超时读取失败</small></span><input v-model="fields[agent].timeout" type="number" min="1" max="3600" step="1" placeholder="默认" /></label>
    </fieldset>
  </section>
  <p v-if="!valid" class="setup-notice error">超时需在 1–3600 秒范围内；模型最多 256 字，档位只能是小写英文。</p>
  <div class="setup-actions settings-form-actions"><button class="setup-link" :disabled="!bridge || busy || !configuration" @click="defaults">恢复默认</button><span class="setup-spacer"></span><button class="setup-button" :disabled="!editing || busy" @click="resetForm(); editing = false">取消</button><button class="setup-button primary" :disabled="!dirty || !valid || busy || !bridge" @click="save">保存</button></div>
  <section class="settings-section settings-test"><h2>测试 AI 整理</h2><p class="setup-help">发送不含知识内容的请求，检查实际调用。使用已保存的设置。</p><div class="setup-actions"><select v-model="testProvider" aria-label="测试提供方" :disabled="busy"><option value="codex">Codex CLI</option><option value="claude">Claude Code</option></select><button class="setup-button" :disabled="busy || !bridge" @click="confirmTest = true">{{ busy ? '正在处理…' : result?.success === false ? '重试' : '发送测试请求' }}</button></div><p v-if="result" class="setup-notice" :class="result.success ? '' : 'error'" role="status">{{ result.success ? `测试成功 · ${agentNames[testProvider]} 已返回响应 · 用时 ${(result.durationMs / 1000).toFixed(1)} 秒` : `测试失败：${result.error?.message}` }}</p></section>
  <SettingsDialog :open="confirmTest" title="发送测试请求" @close="confirmTest = false"><p>提供方：{{ agentNames[testProvider] }}</p><p>将向 {{ agentNames[testProvider] }} 发送一条不含知识内容的测试请求，可能计入用量。</p><p>测试内容：<code>请仅回复 OK</code></p><template #actions><button class="setup-button" autofocus @click="confirmTest = false">取消</button><button class="setup-button primary" @click="test">发送测试请求</button></template></SettingsDialog>
</template>
