<script setup lang="ts">
import AgentLogo from "../components/AgentLogo.vue";
import type { AgentDetection, AgentName, IntegrationStatus } from "./bridge.js";
import type { SetupIntegrations } from "./use-integrations.js";
import { agents, agentNames, statusTone, trustSteps } from "./integration-presentation.js";
const props = defineProps<{ model: SetupIntegrations; detections: AgentDetection[]; selected: Record<AgentName, boolean>; serviceReady: boolean }>();
function status(agent: AgentName) { return props.model.statuses.find(value => value.agent === agent); }
function joined(agent: AgentName) { return props.selected[agent] && props.detections.some(value => value.agent === agent && value.found); }
function summary(value: IntegrationStatus | undefined): { label: string; detail: string } {
  if (!value) return { label: "正在检测", detail: "正在读取接入状态" };
  if (value.items.some(item => item.configuration === "pending-trust")) return { label: "待确认", detail: "需要在 Codex 中信任自动流程" };
  if (value.items.some(item => ["repair", "policy-disabled"].includes(item.configuration) || item.verification === "failed")) return { label: "待处理", detail: "可在设置的 Agent 接入中修复" };
  if (!props.serviceReady) return { label: "等待服务", detail: "本地服务就绪后检测" };
  if (value.items.some(item => item.configuration === "unconfigured")) return { label: "未完成", detail: "可在设置的 Agent 接入中继续" };
  return { label: "正常", detail: "已接入，下次对话起生效" };
}
</script>

<template>
  <h2 class="setup-section-title">Agent 接入</h2>
  <p v-if="model.error" class="setup-notice warn">{{ model.error }}</p>
  <div class="setup-table-card">
    <div v-for="agent in agents" :key="agent" class="setup-check-row setup-agent-check-row">
      <AgentLogo :agent="agent" size="sm" />
      <div><h2>{{ agentNames[agent] }}</h2><p class="setup-help">{{ joined(agent) ? summary(status(agent)).detail : detections.find(value => value.agent === agent)?.found ? '未选择接入' : '未在本机找到' }}</p></div>
      <span class="setup-status" :class="joined(agent) ? statusTone(summary(status(agent)).label) : 'neutral'">{{ joined(agent) ? summary(status(agent)).label : '未接入' }}</span>
    </div>
  </div>
  <div v-if="agents.some(agent => joined(agent) && summary(status(agent)).label === '待确认')" class="setup-todo">
    <b>在 Codex 中信任 Precedent Loop 的自动流程</b>
    <ol><li v-for="step in trustSteps" :key="step">{{ step }}</li></ol>
    <button class="setup-button" :disabled="model.busy" @click="model.initialize(false)">重新检测</button>
  </div>
</template>
