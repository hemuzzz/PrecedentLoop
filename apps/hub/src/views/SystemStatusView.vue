<script setup lang="ts">
import { displayValue } from "./view-helpers.js";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { HubApiClient, HubApiError, isAbortError } from "../api/client.js";
import type { SystemReadiness, SystemStatus } from "../api/types.js";
import { asHubApiError, formatDate, presentReadError } from "./view-helpers.js";
import PageHeader from "../components/PageHeader.vue";
import UiIcon from "../components/UiIcon.vue";
import { settingsBridge } from "../settings/bridge.js";
import { displayTime } from "../settings/presentation.js";
import { agentNames, agents } from "../setup/integration-presentation.js";
import type { AgentName } from "../setup/bridge.js";

const api = new HubApiClient();
const status = ref<SystemStatus>();
const loading = ref(false);
const error = ref<HubApiError>();

let request = 0;
let controller: AbortController | undefined;

const errorCopy = computed(() =>
  presentReadError(error.value, "SYSTEM_STATUS"),
);

// Agent connections come from the desktop bridge; a plain browser has no access and hides the card.
const connections = ref<Partial<Record<AgentName, string | null>>>();
async function loadConnections(): Promise<void> {
  try {
    const bridge = await settingsBridge();
    if (!bridge) return;
    const statuses = await bridge.getIntegrationStatus({});
    connections.value = Object.fromEntries(statuses.map(value => [value.agent, value.items.find(item => item.item === "mcp")?.evidence.lastConnected ?? null]));
  } catch { /* Optional evidence; the Agent page shows detailed errors. */ }
}
function refresh(): void { void loadStatus(); void loadConnections(); }
const tone = (ok: boolean) => ok ? "ok" : "warn";
const host = location.host;

onMounted(refresh);
onBeforeUnmount(() => controller?.abort());

async function loadStatus(): Promise<void> {
  const requestId = ++request;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  error.value = undefined;
  try {
    const result = await api.getSystemStatus(controller.signal);
    if (requestId === request) {
      status.value = result;
    }
  } catch (caught) {
    if (requestId !== request || isAbortError(caught)) {
      return;
    }
    status.value = undefined;
    error.value = asHubApiError(caught);
  } finally {
    if (requestId === request) {
      loading.value = false;
    }
  }
}

function ready(readiness: SystemReadiness): boolean { return readiness === "READY"; }

function formatCount(value: number | null): string {
  return value === null ? "未知 / 不可用" : value.toLocaleString('en-US');
}

function formatOptionalDate(value: string | null): string {
  if (value === null) return "未知 / 不可用";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

function formatUptime(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(wholeSeconds / 86_400);
  const hours = Math.floor((wholeSeconds % 86_400) / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  const remainder = wholeSeconds % 60;
  return [
    days > 0 ? `${days}天` : "",
    hours > 0 ? `${hours}时` : "",
    minutes > 0 ? `${minutes}分` : "",
    `${remainder}秒`,
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}
</script>

<template>
  <main class="list-page system-page">
    <PageHeader title="系统状态" subtitle="本地服务与知识库的运行情况">
      <button type="button" class="quiet-button" :disabled="loading" @click="refresh"><UiIcon name="refresh" />刷新</button>
    </PageHeader>
    <section class="list-scroll system-content" aria-label="系统状态" :aria-busy="loading">
      <div v-if="loading && !status" class="state-panel status-state" role="status" aria-live="polite">
        <span class="loading-line" aria-hidden="true"></span><strong>正在读取系统状态…</strong>
      </div>
      <div v-else-if="error && errorCopy" class="state-panel status-state error-state" role="alert">
        <p class="error-code mono">{{ error.code }}</p>
        <strong>{{ errorCopy.title }}</strong><p>{{ errorCopy.detail }}</p>
        <button type="button" class="secondary-button" @click="refresh">重试</button>
      </div>
      <article v-else-if="status" class="system-dashboard">
        <div class="system-grid">
          <section class="system-card" aria-labelledby="service-status-section">
            <header class="system-card-heading"><h2 id="service-status-section">本地服务</h2><span class="system-dot" :class="tone(ready(status.service.readiness) && status.mcpEndpoint.ready)">{{ ready(status.service.readiness) ? status.mcpEndpoint.ready ? '运行中' : '知识连接未就绪' : displayValue(status.service.readiness) }}</span></header>
            <dl class="system-fields">
              <div><dt>版本</dt><dd>{{ status.service.version }}</dd></div>
              <div><dt>已运行</dt><dd>{{ formatUptime(status.service.uptimeSeconds) }}</dd></div>
              <div><dt>地址</dt><dd><code>{{ host }}{{ status.mcpEndpoint.path }}</code></dd></div>
            </dl>
          </section>
          <section class="system-card" aria-labelledby="repository-status-section">
            <header class="system-card-heading"><h2 id="repository-status-section">知识库</h2><span class="system-dot" :class="tone(ready(status.index.indexState) && !status.index.rebuildRequired)">{{ ready(status.index.indexState) && !status.index.rebuildRequired ? '正常' : displayValue(status.index.indexState) }}</span></header>
            <dl class="system-fields">
              <div><dt>正式 / 候选</dt><dd>{{ formatCount(status.repository.formalAssetCount) }} / {{ formatCount(status.repository.inboxAssetCount) }}</dd></div>
              <div><dt>索引</dt><dd>{{ formatCount(status.index.catalogCount) }} 条 · {{ formatOptionalDate(status.index.lastSuccessfulScanAt) }} 扫描</dd></div>
              <div><dt>需要重建</dt><dd :class="{ 'system-warning': status.index.rebuildRequired }">{{ status.index.rebuildRequired ? '是' : '否' }}</dd></div>
              <div><dt>位置</dt><dd><code :title="status.repository.assetRepositoryPath" class="system-ellipsis">{{ status.repository.assetRepositoryPath }}</code></dd></div>
            </dl>
          </section>
          <section class="system-card" aria-labelledby="agent-status-section">
            <header class="system-card-heading"><h2 id="agent-status-section">Agent 连接</h2></header>
            <dl v-if="connections" class="system-fields">
              <div v-for="agent in agents" :key="agent"><dt>{{ agentNames[agent] }}</dt><dd>{{ connections[agent] ? `最近连接 ${displayTime(connections[agent])}` : '尚无连接记录' }}</dd></div>
            </dl>
            <p v-else class="system-note">请在桌面应用中查看 Agent 的连接情况。</p>
          </section>
          <section class="system-card" aria-labelledby="watcher-status-section">
            <header class="system-card-heading"><h2 id="watcher-status-section">文件监听</h2><span class="system-dot" :class="tone(status.index.watcherState === 'RUNNING')">{{ displayValue(status.index.watcherState) }}</span></header>
            <dl class="system-fields">
              <div><dt>说明</dt><dd>知识文件变化后自动更新索引</dd></div>
              <div><dt>全文索引</dt><dd>{{ formatCount(status.index.ftsCount) }} 条</dd></div>
            </dl>
          </section>
        </div>
        <details class="system-diagnostics">
          <summary><UiIcon :name="status.diagnostics.length ? 'warning' : 'check'" />诊断信息（{{ status.diagnostics.length }}）</summary>
          <p v-if="!status.diagnostics.length" class="system-note">本次检查未返回诊断信息。</p>
          <ol v-else class="system-diagnostic-list">
            <li v-for="(diagnostic, index) in status.diagnostics" :key="`${diagnostic.source}:${diagnostic.relativePath ?? ''}:${diagnostic.code}:${index}`">
              <details>
                <summary><UiIcon name="warning" /><span>{{ diagnostic.message }}</span><span class="tag warning">{{ diagnostic.source }}</span></summary>
                <dl class="system-diagnostic-fields">
                  <div><dt>诊断代码</dt><dd><code>{{ diagnostic.code }}</code></dd></div>
                  <div v-if="diagnostic.relativePath"><dt>相对路径</dt><dd><code>{{ diagnostic.relativePath }}</code></dd></div>
                  <div v-if="diagnostic.occurredAt"><dt>发生时间</dt><dd><time :datetime="diagnostic.occurredAt">{{ formatDate(diagnostic.occurredAt) }}</time></dd></div>
                </dl>
              </details>
            </li>
          </ol>
        </details>
      </article>
    </section>
  </main>
</template>

<style scoped>
.system-page { padding: 0 24px 20px; min-height: 0; gap: 16px; }
.system-page :deep(.page-header) { padding: 8px 4px 0; min-height: 60px; border-bottom: 0; }
.system-page :deep(.page-heading h1) { font-size: 24px; line-height: 32px; font-weight: 600; }
.system-page :deep(.page-heading p) { margin-top: 2px; font-size: 13px; line-height: 18px; }
.system-page :deep(.page-actions .quiet-button) { height: 34px; padding-inline: 12px; gap: 8px; border-color: var(--line); font-size: 13px; }
.system-content { padding: 0; scrollbar-width: thin; scrollbar-color: var(--control-line) transparent; }
.system-dashboard { display: grid; gap: 16px; max-width: 1080px; }
.system-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.system-card { min-width: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.system-card-heading { display: flex; align-items: center; gap: 10px; padding: 16px 20px 8px; }
.system-card-heading h2 { font-size: 14px; font-weight: 600; line-height: 22px; }
.system-dot { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font-size: 12.5px; }
.system-dot::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.system-dot.ok { color: var(--success); }
.system-dot.warn { color: var(--warning); }
.system-fields { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 18px; padding: 4px 20px 18px; font-size: 13px; line-height: 20px; }
.system-fields > div { display: contents; }
.system-fields dt, .system-diagnostic-fields dt { color: var(--muted); }
.system-fields dd { min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.system-fields code { font-size: 12px; }
.system-ellipsis { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.system-warning { color: var(--warning); }
.system-note { margin: 0; padding: 4px 20px 18px; font-size: 13px; color: var(--muted); }
.system-diagnostics { color: var(--muted); font-size: 13px; }
.system-diagnostics > summary { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.system-diagnostics > summary .ui-icon { width: 16px; height: 16px; }
.system-diagnostics .system-note { padding: 10px 0 0; }
.system-diagnostic-list { list-style: none; margin: 10px 0 0; padding: 0 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); color: var(--ink); }
.system-diagnostic-list li + li { border-top: 1px solid var(--line); }
.system-diagnostic-list summary { display: flex; align-items: center; gap: 10px; padding: 14px 0; cursor: pointer; font-size: 13px; }
.system-diagnostic-list summary > span:first-of-type { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.system-diagnostic-list summary .ui-icon { color: var(--warning); flex-shrink: 0; }
.system-diagnostic-fields { display: grid; gap: 8px; padding: 0 0 16px 28px; font-size: 12px; line-height: 20px; }
.system-diagnostic-fields > div { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 12px; }
.system-diagnostic-fields dd { overflow-wrap: anywhere; }
@media (max-width: 820px) { .system-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 600px) { .system-page { padding: 0 12px 12px; gap: 12px; } }
</style>
