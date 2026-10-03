<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import AgentLogo from "../components/AgentLogo.vue";
import SettingsDialog from "./SettingsDialog.vue";
import { useIntegrations } from "../setup/use-integrations.js";
import type { AgentDetection, AgentName, IntegrationItem, IntegrationItemStatus, SetupDraft } from "../setup/bridge.js";
import { agents, agentNames, effectNames, items, trustSteps } from "../setup/integration-presentation.js";
import type { SettingsBridge, SettingsSnapshot } from "./bridge.js";
import { displayTime } from "./presentation.js";

const props = defineProps<{ bridge: SettingsBridge | null }>();
const detections = ref<AgentDetection[]>([]), settings = ref<SettingsSnapshot>(), version = ref("");
const integrations = reactive(useIntegrations(() => props.bridge!, ref<SetupDraft>(), detections, "settings"));
const busy = ref(false), error = ref(""), loaded = ref(false);
const confirm = ref<{ kind: "remove" | "replace"; agent: AgentName; item?: IntegrationItem } | null>(null);
const disabled = computed(() => !props.bridge || busy.value || integrations.busy);
let unsubscribe: (() => void) | undefined;

function detection(agent: AgentName) { return detections.value.find(value => value.agent === agent); }
function status(agent: AgentName) { return integrations.statuses.find(value => value.agent === agent); }
function connected(agent: AgentName): boolean {
  return !!settings.value?.agents[agent] || !!status(agent)?.items.some(item => item.configuration !== "unconfigured");
}
interface Row { label: string; tone: "ok" | "warn" | "neutral" | "error"; action: "repair" | "replace" | null; evidence: string }
function row(agent: AgentName, item: IntegrationItemStatus): Row {
  const result = integrations.results.find(value => value.agent === agent && value.item === item.item);
  const evidence = item.item === "mcp" ? item.evidence.lastConnected ? `最近连接 ${displayTime(item.evidence.lastConnected)}` : "尚无连接记录"
      : item.evidence.lastTriggered ? `最近触发 ${displayTime(item.evidence.lastTriggered)}` : item.configuration === "pending-trust" ? "尚未在 Codex 中信任" : "尚无触发记录";
  if (result && ["failed", "partial"].includes(result.status)) return { label: "未完成", tone: "error", action: "repair", evidence: result.reason ?? evidence };
  if (item.configuration === "pending-trust") return { label: "待确认", tone: "warn", action: null, evidence };
  if (item.configuration === "external") return { label: "外部配置", tone: "neutral", action: "replace", evidence: `已有同名配置，不属于 Precedent Loop` };
  if (item.configuration === "policy-disabled") return { label: "被策略禁用", tone: "neutral", action: null, evidence: item.reasons[0] ?? evidence };
  if (["repair", "partial", "unconfigured"].includes(item.configuration) || item.verification === "failed") return { label: "需要修复", tone: "warn", action: "repair", evidence: item.reasons[0] ?? evidence };
  return { label: "正常", tone: "ok", action: null, evidence };
}
function summary(agent: AgentName): { text: string; tag: string; tone: string } {
  if (!loaded.value) return { text: "读取中", tag: "读取中", tone: "neutral" };
  if (!settings.value || !status(agent)) return { text: "接入状态读取失败", tag: "未知", tone: "neutral" };
  const found = detection(agent)?.found;
  if (!connected(agent)) return found === false ? { text: "未在本机找到", tag: "未接入", tone: "neutral" } : { text: "尚未接入", tag: "未接入", tone: "neutral" };
  const rows = (status(agent)?.items ?? []).map(item => row(agent, item));
  const pending = rows.filter(value => value.tone === "warn" || value.tone === "error").length;
  if (rows.some(value => value.label === "待确认")) return { text: `已接入 · ${pending} 项待你确认`, tag: "待确认", tone: "warn" };
  if (pending) return { text: `已接入 · ${pending} 项需要处理`, tag: "需要处理", tone: "warn" };
  return { text: "已接入 · 全部正常", tag: "正常", tone: "ok" };
}
async function perform(action: () => Promise<void>) {
  if (!props.bridge) return;
  busy.value = true; error.value = "";
  try { await action(); } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { busy.value = false; }
}
async function refresh(detect = true) {
  const bridge = props.bridge;
  if (!bridge) return;
  if (detect) detections.value = await bridge.detectAgents({});
  settings.value = await bridge.getSettings();
  version.value = (await bridge.getAppInfo()).version;
  await integrations.refreshStatus();
  window.dispatchEvent(new CustomEvent("hub:settings-changed", { detail: { settings: settings.value, statuses: integrations.statuses, version: version.value } }));
}
async function run(kind: "install" | "remove", agent: AgentName, list?: IntegrationItem[]) {
  await integrations.execute(kind, agent, list);
  await perform(() => refresh(false));
}
async function confirmed() {
  const value = confirm.value; confirm.value = null;
  if (!value) return;
  if (value.kind === "remove") await run("remove", value.agent);
  else { integrations.conflicts[value.agent][value.item!] = "replace"; await run("install", value.agent, [value.item!]); }
}
async function changePath(agent: AgentName, automatic = false) {
  await perform(async () => {
    const path = automatic ? null : await props.bridge!.selectExecutable({ agent });
    if (!automatic && !path) return;
    detections.value = await props.bridge!.saveAgentPath({ agent, path });
    await refresh(false);
  });
}
function cliText(agent: AgentName): string {
  const value = detection(agent);
  if (!value) return "正在检测…";
  if (!value.found) return "未在本机找到";
  const login = value.login === "logged-in" ? "已登录" : value.login === "logged-out" ? "未登录" : "登录未验证";
  return `${value.version ?? "版本未知"} · ${value.runnable ? login : "无法运行"}`;
}
onMounted(async () => {
  if (props.bridge) unsubscribe = props.bridge.onIntegrationProgress(integrations.receiveProgress);
  await perform(() => refresh());
  loaded.value = true;
});
onBeforeUnmount(() => unsubscribe?.());
</script>

<template>
  <p v-if="error || integrations.error" class="setup-notice error" role="alert">{{ error || integrations.error }}</p>
  <p v-if="!loaded" class="setup-help" role="status">正在读取本机接入状态…</p>
  <section v-for="agent in agents" :key="agent" class="settings-agent-card">
    <div class="settings-agent-head">
      <AgentLogo :agent="agent" />
      <div><h2>{{ agentNames[agent] }}</h2><p class="setup-help">{{ summary(agent).text }}</p></div>
      <span class="setup-status settings-agent-tag" :class="summary(agent).tone">{{ summary(agent).tag }}</span>
    </div>
    <ul v-if="connected(agent) && status(agent)" class="settings-effects">
      <li v-for="item in status(agent)!.items" :key="item.item">
        <div><span>{{ effectNames[item.item] }}</span><small>{{ row(agent, item).evidence }}</small></div>
        <button v-if="row(agent, item).action === 'repair'" class="setup-link" :disabled="disabled" @click="run('install', agent, [item.item])">修复</button>
        <button v-else-if="row(agent, item).action === 'replace'" class="setup-link" :disabled="disabled" @click="confirm = { kind: 'replace', agent, item: item.item }">替换…</button>
        <span class="setup-status" :class="row(agent, item).tone">{{ row(agent, item).label }}</span>
      </li>
    </ul>
    <div v-if="agent === 'codex' && status(agent)?.items.some(item => item.configuration === 'pending-trust')" class="settings-todo">
      <b>在 Codex 中信任 Precedent Loop 的自动流程</b>
      <ol><li v-for="step in trustSteps" :key="step">{{ step }}</li></ol>
      <button class="setup-button" :disabled="disabled" @click="perform(() => refresh())">重新检测</button>
    </div>
    <div class="settings-agent-cli">
      <span><b>{{ agent === 'codex' ? 'Codex CLI' : 'Claude Code' }}</b> {{ cliText(agent) }}</span>
      <code v-if="detection(agent)?.path" :title="detection(agent)?.path">{{ detection(agent)?.path }}</code>
      <span v-if="detection(agent)?.path" class="setup-chip">{{ detection(agent)?.source === 'manual' ? '手动指定' : '自动检测' }}</span>
      <span class="settings-agent-links"><button class="setup-link" :disabled="disabled" @click="perform(() => refresh())">重新检测</button><button class="setup-link" :disabled="disabled" @click="changePath(agent)">手动指定…</button><button v-if="settings?.manualPaths[agent]" class="setup-link" :disabled="disabled" @click="changePath(agent, true)">恢复自动检测</button></span>
    </div>
    <p v-if="detection(agent)?.reason" class="setup-help">{{ detection(agent)?.reason }}</p>
    <div class="settings-agent-foot">
      <button v-if="connected(agent)" class="setup-button danger" :disabled="disabled" @click="confirm = { kind: 'remove', agent }">移除 {{ agentNames[agent] }} 接入…</button>
      <button v-else-if="detection(agent)?.found" class="setup-button primary" :disabled="disabled" @click="run('install', agent)">接入 {{ agentNames[agent] }}</button>
    </div>
  </section>
  <p v-if="integrations.phase === 'applying'" class="setup-help" role="status">正在写入配置…</p>
  <p class="setup-help">某项异常时点“修复”直接修复，改动前会备份原文件。</p>

  <SettingsDialog :open="confirm?.kind === 'remove'" :title="confirm ? `移除 ${agentNames[confirm.agent]} 接入？` : ''" :busy="disabled" @close="confirm = null">
    <p>{{ confirm ? agentNames[confirm.agent] : '' }} 将不再使用你的知识库：</p>
    <ul class="settings-dialog-list"><li>断开知识库连接</li><li>停止项目识别与沉淀提醒</li></ul>
    <p class="setup-help">知识库、工作区和 {{ confirm ? agentNames[confirm.agent] : '' }} 本身都不受影响，你修改过的文件会保留。之后可随时重新接入。</p>
    <template #actions><button class="setup-button" autofocus @click="confirm = null">取消</button><button class="setup-button danger-fill" @click="confirmed">移除</button></template>
  </SettingsDialog>
  <SettingsDialog :open="confirm?.kind === 'replace'" title="替换为本机知识库的配置？" :busy="disabled" @close="confirm = null">
    <p>{{ confirm ? `${agentNames[confirm.agent]} 中已有同名的${confirm.item ? effectNames[confirm.item] : ''}配置，不属于 Precedent Loop。` : '' }}</p>
    <p class="setup-help">替换前会备份原配置。</p>
    <template #actions><button class="setup-button" autofocus @click="confirm = null">取消</button><button class="setup-button primary" @click="confirmed">替换</button></template>
  </SettingsDialog>
</template>
