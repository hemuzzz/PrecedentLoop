<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import AgentLogo from "../components/AgentLogo.vue";
import { settingsBridge, type SettingsSnapshot } from "./bridge.js";
import type { IntegrationStatus } from "../setup/bridge.js";
import { agents, agentNames } from "../setup/integration-presentation.js";
import { pendingIntegrations } from "./presentation.js";
import { navigate } from "../navigation.js";

const props = defineProps<{ collapsed: boolean }>();
const emit = defineEmits<{ pending: [count: number] }>();
const statuses = ref<IntegrationStatus[]>([]), settings = ref<SettingsSnapshot>(), available = ref(false);
const pending = computed(() => pendingIntegrations(statuses.value));
const connected = computed(() => agents.filter(agent => settings.value?.agents[agent]));
const title = computed(() => pending.value.length
  ? `${[...new Set(pending.value.map(row => agentNames[row.agent]))].join("、")} 有待处理的接入`
  : connected.value.length ? "Agent 接入正常" : "尚未接入 Agent");
async function refresh() {
  const bridge = await settingsBridge();
  available.value = !!bridge;
  if (!bridge) return;
  try { settings.value = await bridge.getSettings(); statuses.value = await bridge.getIntegrationStatus({}); emit("pending", pending.value.length); }
  catch { /* The Agent page shows detailed errors; the sidebar indicator is optional. */ }
}
function changed(event: Event) {
  if (!(event instanceof CustomEvent)) return;
  const value = (event as CustomEvent<{ settings: SettingsSnapshot; statuses: IntegrationStatus[] }>).detail;
  settings.value = value.settings; statuses.value = value.statuses; emit("pending", pending.value.length);
}
onMounted(() => { void refresh(); window.addEventListener("hub:settings-changed", changed); });
onBeforeUnmount(() => window.removeEventListener("hub:settings-changed", changed));
</script>

<template>
  <button v-if="available" type="button" class="nav-row agent-status-mini" :title="title" :aria-label="`Agent 接入：${title}`" @click="navigate('settings', 'agents')">
    <span class="agent-status-logos"><AgentLogo v-for="agent in (connected.length ? connected : agents)" :key="agent" :agent="agent" size="sm" /></span>
    <span v-if="!props.collapsed">Agent 接入</span>
    <span class="agent-status-dot" :class="pending.length ? 'warn' : connected.length ? 'ok' : 'off'" aria-hidden="true"></span>
  </button>
</template>
