<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, ref } from "vue";
import { HubApiClient, isAbortError } from "../api/client.js";
import type { OverviewDto } from "../api/types.js";
import PageHeader from "../components/PageHeader.vue";
import KnowledgeGraph from "../components/KnowledgeGraph.vue";
import UiIcon from "../components/UiIcon.vue";
import { navigate } from "../navigation.js";
const api = new HubApiClient();
const data = ref<OverviewDto>();
const loading = ref(false);
const error = ref("");
let controller: AbortController | undefined;
async function refresh() {
  controller?.abort(); const current = new AbortController(); controller = current;
  loading.value = true; error.value = "";
  try { const result = await api.getOverview(current.signal); if (controller === current) data.value = result; }
  catch (caught) { if (controller === current && !isAbortError(caught)) { data.value = undefined; error.value = caught instanceof Error ? caught.message : "读取失败"; } }
  finally { if (controller === current) loading.value = false; }
}
onActivated(refresh);
onDeactivated(() => controller?.abort());
onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <main class="list-page overview-page">
    <PageHeader title="总览" subtitle="知识积累与已记录使用"><button class="quiet-button" :disabled="loading" @click="refresh">刷新</button></PageHeader>
    <div class="overview-dashboard" :aria-busy="loading">
      <p v-if="loading && !data" role="status">正在读取知识图谱…</p>
      <p v-if="error" class="overview-error" role="alert">{{ error }} <button @click="refresh">重试</button></p>
      <template v-if="data">
        <section class="overview-metrics" aria-label="知识与使用数量">
          <button class="overview-stat" @click="navigate('library')"><UiIcon class="stat-symbol" name="library" /><span>正式知识</span><strong>{{ data.scopes.reduce((n,s) => n + Object.values(s.assets).reduce((a,b) => a+b,0),0) }}</strong></button>
          <button class="overview-stat" @click="navigate('inbox')"><UiIcon class="stat-symbol" name="inbox" /><span>待确认</span><strong>{{ data.scopes.reduce((n,s) => n+s.inboxCount,0) }}</strong></button>
          <button class="overview-stat" @click="navigate('recalls')"><UiIcon class="stat-symbol" name="refresh" /><span>召回操作 / 条目</span><strong>{{ data.facts.recallOperations }} / {{ data.facts.recallItems }}</strong></button>
          <button class="overview-stat" @click="navigate('usage')"><UiIcon class="stat-symbol" name="activity" /><span>读取 / 累计使用</span><strong>{{ data.facts.reads }} / {{ data.facts.used }}</strong></button>
        </section>
        <KnowledgeGraph :scopes="data.scopes" />
        <div class="overview-caption"><span>统计来自成功持久的事实。</span><button v-if="data.diagnosticCount" class="quiet-button" @click="navigate('status')">{{ data.diagnosticCount }} 项诊断 · 查看系统状态</button></div>
      </template>
    </div>
  </main>
</template>
<style scoped>
.overview-dashboard { flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 16px 24px 10px; gap: 16px; overflow: auto; }
.overview-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0; flex-shrink: 0; }
.overview-stat { display: grid; grid-template-columns: 36px 1fr; grid-template-rows: auto auto; column-gap: 12px; row-gap: 5px; padding: 13px 16px; border-radius: 9px; align-items: center; }
.overview-stat .stat-symbol { grid-row: 1 / 3; width: 34px; height: 34px; padding: 6px; border-radius: 8px; color: #4d98ff; background: rgb(77 152 255 / 8%); }
.overview-stat:nth-child(2) .stat-symbol { color: var(--warning); background: color-mix(in srgb, var(--warning) 8%, transparent); }
.overview-stat:nth-child(3) .stat-symbol { color: #9a83ed; background: rgb(154 131 237 / 8%); }
.overview-stat:nth-child(4) .stat-symbol { color: var(--success); background: color-mix(in srgb, var(--success) 8%, transparent); }
.overview-stat > strong { font-size: clamp(20px, 2vw, 28px); line-height: 1.15; letter-spacing: -.6px; }
.overview-stat > span { font-size: 11px; }
.overview-caption { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 10px; color: var(--muted); flex-shrink: 0; }
.overview-error { color: var(--warning); }
@media (max-width: 1000px) { .overview-stat { grid-template-columns: 1fr; padding: 12px; } .overview-stat .stat-symbol { display: none; } }
@media (max-width: 600px) { .overview-dashboard { padding: 12px; } .overview-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
