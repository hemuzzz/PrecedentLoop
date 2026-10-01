<script setup lang="ts">
import { computed } from "vue";
import AgentLogo from "../components/AgentLogo.vue";
import type { AgentName, IntegrationItem, IntegrationItemStatus } from "./bridge.js";
import type { SetupIntegrations } from "./use-integrations.js";
import { agentNames, effectNames, effectText, items, itemLabel, statusTone, trustSteps } from "./integration-presentation.js";

const props = defineProps<{ model: SetupIntegrations }>();
const groups = computed(() => props.model.statuses.filter(status => props.model.activeAgents.includes(status.agent)));
const sourceNames = { codex: "Codex", claude: "Claude" } as const;
const candidates = computed(() => (props.model.projects?.projects ?? []).flatMap(project => project.paths
  .filter(path => path.exists && !path.reason).map(path => ({ ...path, name: project.name, sources: project.sources }))));
const excluded = computed(() => (props.model.projects?.projects ?? []).flatMap(project => project.paths
  .filter(path => path.reason && path.reason !== "已登记").map(path => ({ ...path, name: project.name }))));
const title = computed(() => props.model.phase === "applying" ? "正在配置" : props.model.phase === "results"
  ? pendingTrust.value ? "配置完成，还差一步" : failures.value ? "部分配置未完成" : "配置完成"
  : groups.value.length ? `接入 ${groups.value.map(group => agentNames[group.agent]).join(" 与 ")}` : "工作区");
const pendingTrust = computed(() => groups.value.some(group => group.items.some(item => item.configuration === "pending-trust")));
const failures = computed(() => props.model.results.some(item => item.status === "failed" || item.status === "partial") || !!props.model.workspaceError);

function conflictItems(agent: AgentName): IntegrationItemStatus[] {
  return groups.value.find(group => group.agent === agent)?.items.filter(item => item.configuration === "external") ?? [];
}
function rowState(agent: AgentName, item: IntegrationItem): { label: string; tone: string; reason?: string | null } {
  if (props.model.phase === "applying") {
    const row = props.model.progress.find(value => value.agent === agent && value.item === item);
    const labels = { waiting: "等待中", running: "正在配置", success: "已完成", partial: "部分完成", failed: "未完成", preserved: "保留现有" } as const;
    return { label: labels[row?.status ?? "waiting"], tone: row?.status === "success" ? "ok" : row?.status === "failed" ? "error" : "neutral" };
  }
  const result = props.model.results.find(value => value.agent === agent && value.item === item);
  if (result && (result.status === "failed" || result.status === "partial")) return { label: "未完成", tone: "error", reason: result.reason };
  const status = groups.value.find(group => group.agent === agent)?.items.find(value => value.item === item);
  if (!status) return { label: "正在检测", tone: "neutral" };
  if (status.configuration === "pending-trust") return { label: "待确认", tone: "warn" };
  const label = itemLabel(status);
  return { label: label === "已配置，未验证" ? "已完成" : label, tone: statusTone(label) };
}
function agentSummary(agent: AgentName): { text: string; tone: string } {
  const states = items.map(item => rowState(agent, item));
  const pending = states.filter(state => state.tone === "warn").length, failed = states.filter(state => state.tone === "error").length;
  if (failed) return { text: `${failed} 项未完成`, tone: "error" };
  if (pending) return { text: `${items.length - pending} 项已完成 · ${pending} 项待你确认`, tone: "warn" };
  return { text: `${items.length} 项已完成`, tone: "ok" };
}
function paths(list: string[]): string { return list.join(" · "); }
</script>

<template>
  <h1>{{ title }}</h1>
  <p class="setup-subtitle">{{ model.phase === 'applying' ? '正在写入配置，改动前会备份原文件。'
    : model.phase === 'results' ? pendingTrust ? '其余配置已完成。Codex 需要你确认一次新增的自动流程。' : '之后可随时在设置中查看或移除。'
      : groups.length ? '确认后自动完成以下配置，改动前会备份原文件；之后可随时在设置中移除。' : '未选择要接入的 Agent。可以先登记工作区，稍后在设置中接入。' }}</p>
  <p v-if="model.error" class="setup-notice warn" role="alert">{{ model.error }}</p>
  <p v-if="model.busy && !groups.length && model.phase === 'selection'" class="setup-help" role="status">正在读取接入状态…</p>

  <section v-for="group in groups" :key="group.agent" class="setup-agent-card">
    <div class="setup-agent-card-head">
      <AgentLogo :agent="group.agent" />
      <div><h2>{{ agentNames[group.agent] }}</h2><p class="setup-help">{{ model.phase === 'selection' ? '将为你配置' : agentSummary(group.agent).text }}</p></div>
      <span v-if="model.phase !== 'selection'" class="setup-status setup-card-status" :class="agentSummary(group.agent).tone">{{ agentSummary(group.agent).tone === 'ok' ? '已完成' : agentSummary(group.agent).tone === 'warn' ? '待确认' : '未完成' }}</span>
    </div>
    <ul class="setup-effects">
      <li v-for="item in items" :key="item">
        <span v-if="model.phase === 'selection'" class="setup-effect-mark ok">✓</span>
        <span v-else class="setup-effect-mark" :class="rowState(group.agent, item).tone">{{ rowState(group.agent, item).tone === 'ok' ? '✓' : rowState(group.agent, item).tone === 'warn' ? '!' : rowState(group.agent, item).tone === 'error' ? '✕' : '·' }}</span>
        <div>
          <b>{{ effectNames[item] }}</b>
          <p class="setup-help">{{ effectText(group.agent, item) }}</p>
          <p v-if="rowState(group.agent, item).reason" class="setup-help setup-error-text">{{ rowState(group.agent, item).reason }}</p>
        </div>
        <span v-if="model.phase !== 'selection'" class="setup-status" :class="rowState(group.agent, item).tone">{{ rowState(group.agent, item).label }}</span>
      </li>
    </ul>
    <div v-for="status in model.phase === 'selection' ? conflictItems(group.agent) : []" :key="status.item" class="setup-conflict-box">
      <b>{{ agentNames[group.agent] }} 中已有同名的{{ effectNames[status.item] }}配置，不属于 Precedent Loop。</b>
      <div class="setup-conflict-options">
        <label class="setup-check"><input type="radio" :name="`${group.agent}-${status.item}`" :checked="model.conflicts[group.agent][status.item] !== 'replace'" :disabled="model.busy" @change="model.conflicts[group.agent][status.item] = 'preserve'" />保留现有配置</label>
        <label class="setup-check"><input type="radio" :name="`${group.agent}-${status.item}`" :checked="model.conflicts[group.agent][status.item] === 'replace'" :disabled="model.busy" @change="model.conflicts[group.agent][status.item] = 'replace'" />替换为本机知识库（先备份原配置）</label>
      </div>
    </div>
    <div v-if="model.phase === 'results' && group.agent === 'codex' && group.items.some(item => item.configuration === 'pending-trust')" class="setup-todo">
      <b>在 Codex 中信任 Precedent Loop 的自动流程</b>
      <ol><li v-for="step in trustSteps" :key="step">{{ step }}</li></ol>
      <button class="setup-button" :disabled="model.busy" @click="model.initialize(false)">重新检测</button>
    </div>
  </section>

  <section class="setup-workspace-section">
    <div class="setup-section-heading"><h2>工作区</h2><span class="setup-chip">来自 Codex 与 Claude Code 的最近项目</span></div>
    <p class="setup-help">勾选要登记的项目。登记后，Agent 在任何项目中都能按需使用这些项目的知识；已登记的工作区保持原样。</p>
    <p v-if="model.projects?.reason" class="setup-notice warn">{{ model.projects.reason }}</p>
    <div v-if="model.projects && (model.projects.registered.length || candidates.length)" class="setup-table-card">
      <table class="setup-workspace-table">
        <tbody>
          <tr v-for="workspace in model.projects.registered" :key="`r-${workspace.name}`">
            <td class="check"><input class="setup-box locked" type="checkbox" checked disabled :aria-label="`${workspace.name} 已登记`" /></td>
            <td class="name" :title="workspace.name">{{ workspace.name }}</td>
            <td class="path"><code :title="paths(workspace.paths)">{{ paths(workspace.paths) }}</code></td>
            <td class="tags"><span class="setup-chip">已登记</span><span v-for="source in workspace.sources" :key="source" class="setup-chip accent">{{ sourceNames[source] }}</span></td>
          </tr>
          <tr v-for="candidate in candidates" :key="candidate.candidateId">
            <td class="check"><input v-model="model.selectedProjects" class="setup-box" type="checkbox" :value="candidate.candidateId" :aria-label="`登记 ${candidate.name}`" :disabled="model.busy || model.phase !== 'selection'" /></td>
            <td class="name" :title="candidate.name">{{ candidate.name }}</td>
            <td class="path"><code :title="candidate.path">{{ candidate.path }}</code></td>
            <td class="tags"><span class="setup-chip ok">新增</span><span v-for="source in candidate.sources" :key="source" class="setup-chip accent">{{ sourceNames[source] }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="model.projects && !model.projects.reason" class="setup-help">没有可登记的项目。在 Codex 或 Claude Code 中打开项目后可重新读取。</p>
    <details v-if="excluded.length" class="setup-excluded"><summary>已自动排除 {{ excluded.length }} 项</summary>
      <ul><li v-for="item in excluded" :key="item.candidateId"><code>{{ item.path }}</code>：{{ item.reason }}</li></ul>
    </details>
    <p v-if="model.workspaceResult" class="setup-notice">已登记 {{ model.workspaceResult.imported }} 个新项目。</p>
    <p v-if="model.workspaceError" class="setup-notice warn">{{ model.workspaceError }}</p>
    <button v-if="model.phase === 'selection'" class="setup-link" :disabled="model.busy" @click="model.initialize(true)">重新读取项目</button>
  </section>
</template>
