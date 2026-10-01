<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { settingsBridge } from "./bridge.js";
import type { SettingsSnapshot } from "./bridge.js";
import type { IntegrationStatus } from "../setup/bridge.js";
import { agentNames, itemNames } from "../setup/integration-presentation.js";
import { pendingIntegrations } from "./presentation.js";
import { navigate, useRoute } from "../navigation.js";
import UiIcon from "../components/UiIcon.vue";
import AgentLogo from "../components/AgentLogo.vue";

const route = useRoute(), statuses = ref<IntegrationStatus[]>([]), settings = ref<SettingsSnapshot>();
const version = ref(""), dismissed = ref(false);
const pending = computed(() => pendingIntegrations(statuses.value));
const optional = computed(() => statuses.value.flatMap(agent => settings.value?.agents[agent.agent]
  ? agent.items.filter(item => item.choice === "undecided").map(item => ({ agent: agent.agent, item: item.item })) : []));
/** One specific, actionable message instead of a bare count (2026-09-25 mockup). */
const notice = computed(() => {
  const trust = pending.value.find(row => row.status.configuration === "pending-trust");
  if (trust) return { agent: trust.agent, title: `${agentNames[trust.agent]} 还差一步`, text: `在 ${agentNames[trust.agent]} 中信任 Precedent Loop 的自动流程后，项目识别与沉淀提醒才会生效。`, action: "查看做法" };
  if (!pending.value.length) return null;
  const agentsWithIssues = [...new Set(pending.value.map(row => row.agent))];
  return { agent: agentsWithIssues.length === 1 ? agentsWithIssues[0]! : null, title: "接入需要处理", text: `${agentsWithIssues.map(agent => agentNames[agent]).join("、")} 有 ${pending.value.length} 项接入需要修复。`, action: "前往修复" };
});
const optionalText = computed(() => optional.value.map(value => `${agentNames[value.agent]} ${itemNames[value.item]}`).join("、"));
async function refresh() {
  const bridge = await settingsBridge();
  if (!bridge) return;
  try {
    settings.value = await bridge.getSettings();
    version.value = (await bridge.getAppInfo()).version;
    try { dismissed.value = localStorage.getItem(`hub-integration-dismissed:${version.value}`) === "1"; } catch { /* Session-only dismissal. */ }
    statuses.value = await bridge.getIntegrationStatus({});
  } catch { /* Settings and system status provide explicit diagnostics; this notice is optional. */ }
}
function dismiss() {
  dismissed.value = true;
  try { localStorage.setItem(`hub-integration-dismissed:${version.value}`, "1"); } catch { /* Keep current-session state. */ }
}
function changed(event: Event) {
  if (!(event instanceof CustomEvent)) return;
  const value = (event as CustomEvent<{ settings: SettingsSnapshot; statuses: IntegrationStatus[]; version: string }>).detail;
  settings.value = value.settings; statuses.value = value.statuses; version.value = value.version;
  try { dismissed.value = localStorage.getItem(`hub-integration-dismissed:${version.value}`) === "1"; } catch { /* Keep current-session state. */ }
}
onMounted(() => { if (route.value.page !== "settings") void refresh(); window.addEventListener("hub:settings-changed", changed); });
onBeforeUnmount(() => window.removeEventListener("hub:settings-changed", changed));
watch(() => route.value.page, page => { if (page === "overview") void refresh(); });
</script>

<template>
  <div v-if="optional.length" class="integration-notice" role="status"><UiIcon name="info" /><span>有新的接入项：{{ optionalText }}</span><button class="setup-link" @click="navigate('settings', 'agents')">查看</button></div>
  <div v-if="route.page === 'overview' && settings?.setupCompleted && notice && !dismissed" class="integration-notice warn" role="status">
    <AgentLogo v-if="notice.agent" :agent="notice.agent" size="sm" />
    <span><b>{{ notice.title }}</b>：{{ notice.text }}</span>
    <button class="setup-link" @click="navigate('settings', 'agents')">{{ notice.action }}</button>
    <button class="icon-button dismiss" aria-label="关闭接入提示" @click="dismiss"><UiIcon name="close" /></button>
  </div>
</template>
