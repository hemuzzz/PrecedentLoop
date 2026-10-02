<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, ref, watch } from "vue";
import { HubApiClient, isAbortError } from "../api/client.js";
import type { WorkspaceProjection, RecallProjection, RecallDetail, UsageProjection } from "../api/types.js";
import PageHeader from "../components/PageHeader.vue";
import FilterMenu from "../components/FilterMenu.vue";
import UiIcon from "../components/UiIcon.vue";
import { navigate, useRoute } from "../navigation.js";
const route = useRoute(); const api = new HubApiClient();
const workspaces = ref<WorkspaceProjection>();
const workspaceRows = computed(() => workspaces.value ? [
  { name: 'GLOBAL(全局)', icon: 'globe', counts: [workspaces.value.globalAssetCount, null, null, null, workspaces.value.globalRecallCount, null, null] },
  ...workspaces.value.items.map(item => ({
    name: item.name, icon: 'folder',
    counts: [item.assetCount, item.authorizedRecallCount, item.authorizedReadCount, item.authorizedUsedCount,
      item.sourceRecallCount, item.sourceReadCount, item.sourceUsedCount],
  })),
] : []);
const recalls = ref<RecallProjection[]>([]); const usage = ref<UsageProjection[]>([]); const detail = ref<RecallDetail>();
const total = ref(0); const loading = ref(false); const error = ref("");
const offset = computed(() => { const n = Number(new URLSearchParams(route.value.query).get('offset') ?? 0); return Number.isSafeInteger(n) && n >= 0 ? n : 0; });
const recallList = computed(() => route.value.page === 'recalls' && !route.value.id);
const usageList = computed(() => route.value.page === 'usage');
const recordList = computed(() => recallList.value || usageList.value);
const recordCount = computed(() => usageList.value ? usage.value.length : recalls.value.length);
const recallLimit = computed(() => {
  const limit = Number(new URLSearchParams(route.value.query).get('limit') ?? 20);
  return limit === 50 || limit === 100 ? limit : 20;
});
const recallPageCount = computed(() => Math.ceil(total.value / recallLimit.value));
const recallPage = computed(() => total.value === 0 ? 0 : Math.floor(offset.value / recallLimit.value) + 1);
const recordScroll = ref<HTMLElement>();
const recallPages = computed(() => {
  const count = recallPageCount.value;
  if (count <= 7) return Array.from({ length: count }, (_, index) => index + 1);
  const start = Math.max(2, Math.min(recallPage.value - 1, count - 3));
  const pages: (number | string)[] = [1];
  if (start > 2) pages.push('before');
  for (let page = start; page <= start + 2; page++) pages.push(page);
  if (start + 2 < count - 1) pages.push('after');
  pages.push(count);
  return pages;
});
const title = computed(() => ({ workspaces: '工作区', recalls: '召回记录', usage: '使用记录' })[route.value.page as 'workspaces' | 'recalls' | 'usage'] ?? '知识');
let controller: AbortController | undefined;
async function refresh() {
  if (!['workspaces','recalls','usage'].includes(route.value.page)) return;
  controller?.abort(); const current = new AbortController(); controller = current;
  loading.value = true; error.value = ''; detail.value = undefined;
  try {
    const page = route.value.page;
    if (page === 'workspaces') { const result = await api.getWorkspaces(current.signal); if (controller === current) workspaces.value = result; }
    else if (page === 'recalls' && route.value.id) { const result = await api.getRecall(route.value.id, current.signal); if (controller === current) detail.value = result; }
    else {
      const response = page === 'recalls'
        ? { kind: 'recalls' as const, result: await api.getRecalls(offset.value, current.signal, recallLimit.value) }
        : { kind: 'usage' as const, result: await api.getUsage(offset.value, current.signal, recallLimit.value) };
      if (controller === current) {
        if (response.kind === 'recalls') recalls.value = response.result.items;
        else usage.value = response.result.items;
        const { result } = response;
        total.value = result.total;
        if (offset.value > 0 && offset.value >= result.total) {
          const lastOffset = Math.max(0, Math.ceil(result.total / recallLimit.value) - 1) * recallLimit.value;
          navigate(page, undefined, false, { offset: String(lastOffset), limit: String(recallLimit.value) });
        }
        if (recordScroll.value) recordScroll.value.scrollTop = 0;
      }
    }
  } catch (caught) {
    if (controller === current && !isAbortError(caught)) {
      error.value = caught instanceof Error ? caught.message : '读取失败';
      if (recordList.value) { recalls.value = []; usage.value = []; total.value = 0; }
    }
  }
  finally { if (controller === current) loading.value = false; }
}
function openRecall(id?: string) {
  navigate('recalls', id, false, { offset: String(offset.value), limit: String(recallLimit.value) });
}
function openAsset(assetId: string) {
  navigate('library', assetId, false, { from: location.hash });
}
const recallEffects: Record<string, string> = {
  DIRECT: '已提供知识摘要，可继续读取全文',
  ON_DEMAND: '已提供知识入口，需要时读取全文',
  ASSET_LIMIT: '达到知识条数上限，部分结果未提供',
  CHARACTER_LIMIT: '达到返回字数上限，部分结果未提供',
  BUDGET_DOWNGRADED: '为控制返回长度，仅提供入口，未附摘要',
  CANDIDATE_UNAVAILABLE: '部分知识已变化或不可用，未提供这些结果',
  USAGE_WRITE_FAILED: '操作记录保存失败，本次未生成可追溯引用',
};
const recallEffect = (value: string) => recallEffects[value] ?? value;
function moveRecallPage(page: number) {
  if (loading.value || page < 1 || page > recallPageCount.value || page === recallPage.value) return;
  navigate(route.value.page, undefined, false, { offset: String((page - 1) * recallLimit.value), limit: String(recallLimit.value) });
}
function changeRecallLimit(event: Event) {
  if (!(event.target instanceof HTMLSelectElement)) return;
  const limit = Number(event.target.value);
  if (limit !== 20 && limit !== 50 && limit !== 100) return;
  navigate(route.value.page, undefined, false, { offset: '0', limit: String(limit) });
}
function formatRecallDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}
watch(route, refresh); onActivated(refresh); onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <main class="list-page" :class="{ 'workspace-page': route.page === 'workspaces', 'recall-list-page': recordList }">
    <PageHeader :title="title" :subtitle="route.page === 'workspaces' ? '浏览知识归属与使用情况' : recallList ? '查看每次检索的内容与结果' : usageList ? '查看知识的读取与使用情况' : '查看本次检索的结果与知识使用情况'">
      <button class="quiet-button" :disabled="loading" @click="refresh"><UiIcon v-if="route.page === 'workspaces' || recordList" name="refresh" />刷新</button>
    </PageHeader>
    <div v-if="recallList" class="recall-toolbar">
      <span>最近召回优先</span>
      <FilterMenu class="workspace-help" label="记录说明" icon="info">
        <div class="workspace-help-copy">
          <h2>这些记录表示什么？</h2>
          <p><strong>检索内容</strong>：本次召回提交的完整表达，一次召回可包含多条。列表最多展示两行，悬停或点击记录可查看完整内容。</p>
          <p><strong>工作区</strong>：全局知识默认纳入检索范围，这里仅显示额外选择的工作区；未选择时显示「—」。检索范围不代表返回知识的实际来源。</p>
          <p><strong>召回条数</strong>：返回的知识数量。<strong>返回长度</strong>：模型可见内容的字符数，包含元数据，因此没有召回知识时也可能不为零。</p>
          <p>仅显示已记录事实；记录写入失败的召回不会出现在此处。点击记录可查看详情。</p>
        </div>
      </FilterMenu>
    </div>
    <div v-if="usageList" class="recall-toolbar">
      <span>最近操作优先</span>
      <FilterMenu class="workspace-help" label="记录说明" icon="info">
        <div class="workspace-help-copy">
          <h2>这些记录表示什么？</h2>
          <p><strong>读取</strong>表示查看知识内容；<strong>使用</strong>表示记录了对知识的实际采用。</p>
          <p>全局知识默认包含在可访问范围中，<strong>工作区范围</strong>仅显示额外选择的工作区；未选择时显示「—」。</p>
          <p>标题展示知识的当前名称，下方的<strong>来源</strong>表示本次记录中的知识归属，与操作可访问的工作区范围不同。</p>
          <p>仅展示已记录的操作；知识已不可用时仍保留记录。同一知识的多次操作分别展示。</p>
        </div>
      </FilterMenu>
    </div>
    <div ref="recordScroll" class="list-scroll overview-content" :class="{ 'workspace-content': route.page === 'workspaces', 'recall-table-scroll': recordList }" :aria-busy="loading">
      <p v-if="loading" role="status">正在读取…</p><p v-else-if="error" role="alert">{{ error }} <button @click="refresh">重试</button></p>
      <template v-else>
        <p v-if="route.page !== 'workspaces' && !recordList">仅显示已成功记录的操作。知识标题为当前名称，来源保留召回时的归属。</p>
        <template v-if="route.page === 'workspaces' && workspaces">
          <div class="workspace-toolbar">
            <p class="workspace-scope-count">{{ workspaces.items.length }} 个工作区 <span>·</span> 1 个全局范围</p>
            <FilterMenu class="workspace-help" label="统计口径" icon="info">
              <div class="workspace-help-copy">
                <h2>这些数字如何统计？</h2>
                <p><strong>知识数量</strong>：当前属于此范围的正式知识。</p>
                <p><strong>授权操作</strong>：操作授权范围中包含该工作区的召回、读取和使用次数。</p>
                <p><strong>来源事实</strong>：来自该范围的召回条目、读取和使用记录。一次召回可能交付多个条目。</p>
                <p>仅统计已记录事实；多工作区操作可能重复计数，不可跨行相加。</p>
                <p>数量为 0 或暂未提供时，统一显示 <strong>-</strong>。</p>
              </div>
            </FilterMenu>
          </div>
          <div class="table-scroll workspace-table-frame">
            <table class="workspace-table" aria-label="工作区统计">
              <colgroup><col class="workspace-name-column" /><col class="workspace-count-column" /><col span="6" /></colgroup>
              <thead>
                <tr>
                  <th rowspan="2" scope="col" class="workspace-name-heading">工作区</th>
                  <th rowspan="2" scope="col">知识数量</th>
                  <th colspan="3" scope="colgroup" class="workspace-group workspace-divider">授权操作</th>
                  <th colspan="3" scope="colgroup" class="workspace-group workspace-divider">来源事实</th>
                </tr>
                <tr class="workspace-subhead">
                  <th scope="col" class="workspace-divider">召回</th><th scope="col">读取</th><th scope="col">使用</th>
                  <th scope="col" class="workspace-divider">召回条目</th><th scope="col">读取</th><th scope="col">使用</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in workspaceRows" :key="row.name">
                  <td><span class="workspace-name" :title="row.name"><UiIcon :name="row.icon" /><span>{{ row.name }}</span></span></td>
                  <td v-for="(count, index) in row.counts" :key="index"
                    :class="{ 'workspace-divider': index === 1 || index === 4, 'workspace-zero': !count }"
                    :title="count === null ? '暂未提供统计' : count === 0 ? '0 条' : undefined">{{ count || '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <footer class="workspace-footer"><span>共 {{ workspaceRows.length }} 项 · 包含全局范围</span><span>- 数量为 0 或暂未提供</span></footer>
          <details v-if="workspaces.diagnostics.length" class="workspace-diagnostics">
            <summary>扫描提示（{{ workspaces.diagnostics.length }}）</summary>
            <p v-for="(code, index) in workspaces.diagnostics" :key="index">{{ code }}</p>
          </details>
        </template>
        <template v-else-if="route.page === 'recalls' && detail">
          <button class="quiet-button" @click="openRecall()">返回召回列表</button><h2>检索表达</h2>
          <ul class="recall-expressions"><li v-for="(query, index) in detail.operation.queries" :key="index">{{ query }}</li></ul>
          <p>找到 {{ detail.operation.budget.deliveredAssets + detail.operation.budget.omittedCount }} 条知识线索，提供 {{ detail.operation.budget.deliveredAssets }} 条，省略 {{ detail.operation.budget.omittedCount }} 条。</p>
          <p v-for="code in detail.operation.diagnostics" :key="code">{{ recallEffect(code) }}</p>
          <section v-for="item in detail.items" :key="item.recallItemId" class="overview-section"><button class="quiet-button" :disabled="item.assetTitle === null" @click="openAsset(item.assetId)">{{ item.assetTitle ?? '知识已不可用' }}</button><p>来源：{{ item.assetWorkspace ?? '全局' }} · {{ recallEffect(item.deliveredMode) }}</p><p v-for="reason in item.deliveryReasons" :key="reason">{{ recallEffect(reason) }}</p><p>{{ item.readCount ? `已读取 ${item.readCount} 次` : '尚未读取' }} · {{ item.totalUsedCount ? `已使用 ${item.totalUsedCount} 次` : '尚未使用' }}</p></section>
          <p v-if="!detail.items.length">本次召回没有交付条目。</p>
          <details class="detail-disclosure">
            <summary>诊断详情</summary>
            <p>授权：GLOBAL + {{ detail.operation.authorizedWorkspaces.join('、') || '无项目' }}</p>
            <p>字符 {{ detail.operation.budget.modelVisibleCharacters }} / {{ detail.operation.budget.maxModelVisibleCharacters }}（知识 {{ detail.operation.budget.knowledgeContentCharacters }}，元数据 {{ detail.operation.budget.metadataCharacters }}）</p>
            <p>知识条数上限 {{ detail.operation.budget.maxAssets }} · 未附摘要 {{ detail.operation.budget.downgradedCount }} 条</p>
            <p>召回 ID：<code>{{ detail.operation.recallId }}</code></p>
            <div v-for="item in detail.items" :key="item.recallItemId" class="recall-evidence"><p>资产 ID：<code>{{ item.assetId }}</code></p><p>条目 ID：<code>{{ item.recallItemId }}</code></p><p>内容版本：<code>{{ item.version }}</code></p></div>
          </details>
        </template>
        <template v-else-if="recallList">
          <table v-if="recalls.length" class="recall-table" aria-label="召回记录">
            <colgroup><col /><col class="recall-scope-column" /><col class="recall-count-column" /><col class="recall-length-column" /><col class="recall-time-column" /></colgroup>
            <thead><tr><th scope="col">检索内容</th><th scope="col">工作区</th><th scope="col" class="recall-number">召回条数</th><th scope="col" class="recall-number">返回长度</th><th scope="col">召回时间</th></tr></thead>
            <tbody>
              <tr v-for="item in recalls" :key="item.recallId" @click="openRecall(item.recallId)">
                <td class="recall-query-cell">
                  <button type="button" class="recall-query-button" :title="item.queries.join('\n')" @click.stop="openRecall(item.recallId)">
                    <UiIcon name="search" />
                    <span class="recall-query-tags"><span v-for="(query, index) in item.queries" :key="index" class="recall-query-tag">{{ query }}</span></span>
                  </button>
                </td>
                <td><div v-if="item.authorizedWorkspaces.length" class="recall-scopes"><span v-for="workspace in item.authorizedWorkspaces" :key="workspace" :title="workspace">{{ workspace }}</span></div><span v-else class="recall-empty-scope" title="仅全局知识范围">—</span></td>
                <td class="recall-number">{{ item.budget.deliveredAssets.toLocaleString('en-US') }} <span class="recall-unit">条</span></td>
                <td class="recall-number">{{ item.budget.modelVisibleCharacters.toLocaleString('en-US') }} <span class="recall-unit">字符</span></td>
                <td><time class="recall-time" :datetime="item.occurredAt">{{ formatRecallDate(item.occurredAt) }}</time></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="state-panel"><strong>暂无召回记录</strong><p>已记录的知识召回会显示在这里。</p></div>
        </template>
        <template v-else-if="usageList">
          <table v-if="usage.length" class="recall-table usage-record-table" aria-label="使用记录">
            <colgroup><col /><col class="usage-operation-column" /><col class="usage-workspace-column" /><col class="recall-time-column" /></colgroup>
            <thead><tr><th scope="col">知识标题</th><th scope="col">操作</th><th scope="col">工作区范围</th><th scope="col">时间</th></tr></thead>
            <tbody>
              <tr v-for="item in usage" :key="item.id">
                <td>
                  <button class="usage-asset-button" :disabled="!item.assetTitle" :title="item.assetTitle ?? undefined" @click="openAsset(item.assetId)">
                    <UiIcon name="document" />
                    <span class="usage-asset-copy"><span class="usage-asset-title">{{ item.assetTitle ?? '知识暂不可用' }}</span><span class="usage-asset-source">来源：{{ item.assetWorkspace ?? '全局' }}</span></span>
                  </button>
                </td>
                <td><span class="usage-operation" :class="item.kind === 'READ' ? 'usage-read' : 'usage-used'">{{ item.kind === 'READ' ? '读取' : '使用' }}</span></td>
                <td><div v-if="item.authorizedWorkspaces.length" class="recall-scopes"><span v-for="workspace in item.authorizedWorkspaces" :key="workspace" :title="workspace">{{ workspace }}</span></div><span v-else class="recall-empty-scope" title="仅全局知识范围">—</span></td>
                <td><time class="recall-time" :datetime="item.occurredAt">{{ formatRecallDate(item.occurredAt) }}</time></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="state-panel"><strong>暂无使用记录</strong><p>已记录的知识读取与使用会显示在这里。</p></div>
        </template>
      </template>
    </div>
    <nav v-if="recordList && total > 0 && !error" class="recall-pagination" :aria-label="`${title}分页`">
      <p class="recall-page-summary" aria-live="polite">
        <template v-if="loading">正在读取…</template>
        <template v-else-if="error">{{ title }}读取失败</template>
        <template v-else>共 {{ total }} 条 · 当前显示 {{ recordCount ? offset + 1 : 0 }}–{{ recordCount ? offset + recordCount : 0 }} 条</template>
      </p>
      <div class="recall-page-controls">
        <select class="recall-page-size" :value="recallLimit" :disabled="loading" aria-label="每页条数" @change="changeRecallLimit">
          <option :value="20">每页 20 条</option><option :value="50">每页 50 条</option><option :value="100">每页 100 条</option>
        </select>
        <button type="button" class="recall-page-arrow previous" :disabled="loading || !!error || recallPage <= 1" aria-label="上一页" @click="moveRecallPage(recallPage - 1)"><UiIcon name="chevron" /></button>
        <template v-if="!loading && !error">
          <template v-for="page in recallPages" :key="page">
            <button v-if="typeof page === 'number'" type="button" class="recall-page-number" :aria-label="`第 ${page} 页`" :aria-current="page === recallPage ? 'page' : undefined" @click="moveRecallPage(page)">{{ page }}</button>
            <span v-else class="recall-page-gap" aria-hidden="true">…</span>
          </template>
        </template>
        <button type="button" class="recall-page-arrow" :disabled="loading || !!error || recallPage >= recallPageCount" aria-label="下一页" @click="moveRecallPage(recallPage + 1)"><UiIcon name="chevron" /></button>
        <span v-if="!loading && !error" class="recall-page-position">第 {{ recallPage }} / {{ recallPageCount }} 页</span>
      </div>
    </nav>
  </main>
</template>
<style scoped>
.recall-evidence { overflow-wrap: anywhere; margin-top: 16px; }
.workspace-page,
.recall-list-page {
  padding: 0 24px 20px;
  min-height: 0;
  gap: 20px;
}
.workspace-page :deep(.page-header),
.recall-list-page :deep(.page-header) {
  padding: 8px 4px 0;
  min-height: 60px;
  border-bottom: 0;
}
.workspace-page :deep(.page-heading h1),
.recall-list-page :deep(.page-heading h1) {
  font-size: 24px;
  line-height: 32px;
  font-weight: 600;
}
.workspace-page :deep(.page-heading p),
.recall-list-page :deep(.page-heading p) {
  margin-top: 2px;
  font-size: 13px;
  line-height: 18px;
}
.workspace-page :deep(.page-actions .quiet-button),
.recall-list-page :deep(.page-actions .quiet-button) {
  height: 34px;
  padding-inline: 12px;
  gap: 8px;
  border-color: var(--line);
  font-size: 13px;
}
.workspace-content {
  padding: 0 0 4px;
  scrollbar-width: thin;
}
.workspace-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding-inline: 4px;
}
.workspace-scope-count {
  color: var(--muted);
  font-size: 12px;
}
.workspace-scope-count span { padding-inline: 6px; }
.workspace-help { flex-shrink: 0; }
.workspace-help :deep(summary) { color: var(--muted); font-size: 12px; }
.workspace-help :deep(summary:hover) { color: var(--ink); }
.workspace-help :deep(.dropdown-panel) {
  width: min(340px, calc(100vw - 120px));
  padding: 16px;
}
.workspace-help-copy { font-size: 12px; line-height: 1.7; color: var(--muted); }
.workspace-help-copy h2 { margin-bottom: 12px; font-size: 13px; font-weight: 500; color: var(--ink); }
.workspace-help-copy p + p { margin-top: 10px; }
.workspace-help-copy strong { font-weight: 500; color: var(--ink); }
.workspace-table-frame {
  border: 1px solid var(--control-line);
  border-radius: 8px;
  scrollbar-width: thin;
}
.workspace-table {
  min-width: 740px;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
}
.workspace-name-column { width: 220px; }
.workspace-count-column { width: 90px; }
.workspace-table th {
  padding: 10px 14px;
  background: var(--surface);
  text-align: right;
  vertical-align: middle;
  font-size: 12px;
  font-weight: 500;
  border-bottom: 1px solid var(--control-line);
}
.workspace-table .workspace-name-heading { text-align: left; }
.workspace-table .workspace-group { text-align: center; }
.workspace-subhead th { padding-block: 7px; }
.workspace-table td {
  height: 48px;
  padding: 10px 14px;
  text-align: right;
  vertical-align: middle;
  font-variant-numeric: tabular-nums;
}
.workspace-table td:first-child { text-align: left; }
.workspace-table tbody tr:last-child td { border-bottom: 0; }
.workspace-table tbody tr:hover { background: var(--row-hover); }
.workspace-table .workspace-divider { border-left: 1px solid var(--line); }
.workspace-name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.workspace-name > .ui-icon { width: 18px; height: 18px; color: var(--muted); }
.workspace-name > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-zero { color: var(--muted); }
.workspace-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 12px;
  padding-inline: 4px;
  font-size: 12px;
  color: var(--muted);
}
.workspace-diagnostics {
  margin-top: 20px;
  padding: 12px 4px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--muted);
}
.workspace-diagnostics summary { margin-bottom: 8px; }
.recall-list-page { gap: 16px; }
.recall-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-inline: 4px;
  flex-shrink: 0;
  color: var(--muted);
  font-size: 12px;
}
.recall-table-scroll {
  padding: 0;
  border: 1px solid var(--control-line);
  border-radius: 8px;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--control-line) transparent;
}
.recall-table-scroll > p { padding: 20px; color: var(--muted); }
.recall-table {
  min-width: 960px;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
}
.recall-scope-column { width: 16%; }
.recall-count-column { width: 96px; }
.recall-length-column { width: 126px; }
.recall-time-column { width: 176px; }
.recall-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  height: 44px;
  padding: 8px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--control-line);
  font-weight: 500;
  white-space: nowrap;
  vertical-align: middle;
}
.recall-table th + th::before {
  content: '';
  position: absolute;
  left: 0;
  top: 11px;
  bottom: 11px;
  border-left: 1px solid var(--line);
}
.recall-table td {
  height: 64px;
  padding: 10px 16px;
  vertical-align: middle;
}
.recall-table td.recall-query-cell { padding: 0; }
.recall-table tbody tr { cursor: pointer; }
.recall-table tbody tr:hover,
.recall-table tbody tr:focus-within { background: var(--row-hover); }
.recall-table tbody tr:last-child td { border-bottom: 0; }
.recall-query-button {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 63px;
  padding: 10px 16px;
  text-align: left;
  line-height: 21px;
}
.recall-query-button:focus-visible { outline-offset: -3px; box-shadow: none; }
.recall-query-button > .ui-icon { flex-shrink: 0; color: var(--muted); }
.recall-query-tags {
  min-width: 0;
  flex: 1;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  max-height: 60px;
  line-height: 30px;
}
.recall-query-tag {
  display: inline-block;
  max-width: 100%;
  margin-right: 6px;
  padding: 0 9px;
  border-radius: 5px;
  background: var(--hover);
  color: var(--ink);
  font-size: 12px;
  line-height: 24px;
  vertical-align: middle;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre;
}
.recall-scopes { display: flex; flex-wrap: wrap; gap: 4px; }
.recall-scopes > span {
  max-width: 100%;
  padding: 3px 8px;
  border-radius: 5px;
  background: var(--hover);
  color: var(--muted);
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recall-empty-scope { color: var(--muted); }
.recall-table .recall-number {
  text-align: right;
  padding-inline: 16px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.recall-unit { color: var(--muted); }
.recall-time { font-size: 12px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.usage-operation-column { width: 100px; }
.usage-workspace-column { width: 26%; }
.usage-record-table tbody tr { cursor: default; }
.usage-asset-button {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  min-width: 0;
  text-align: left;
}
.usage-asset-button > .ui-icon { flex-shrink: 0; width: 20px; height: 20px; color: var(--muted); }
.usage-asset-button:disabled { opacity: 1; color: var(--muted); }
.usage-asset-copy { display: flex; flex-direction: column; min-width: 0; gap: 3px; }
.usage-asset-title, .usage-asset-source { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.usage-asset-title { font-size: 13px; line-height: 20px; }
.usage-asset-source { font-size: 11px; line-height: 17px; color: var(--muted); }
.usage-operation { display: inline-flex; justify-content: center; min-width: 52px; padding: 4px 10px; border-radius: 6px; font-size: 12px; line-height: 20px; }
.usage-read { color: var(--asset-memory); background: color-mix(in srgb, var(--asset-memory) 14%, transparent); }
.usage-used { color: var(--asset-skill); background: color-mix(in srgb, var(--asset-skill) 14%, transparent); }
.recall-pagination {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px 20px;
  padding: 12px 16px;
  min-height: 62px;
  border: 1px solid var(--control-line);
  border-radius: 8px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.recall-page-summary { color: var(--muted); white-space: nowrap; }
.recall-page-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.recall-page-size {
  height: 34px;
  padding: 0 32px 0 12px;
  margin-right: 8px;
  border: 1px solid var(--control-line);
  border-radius: 6px;
  background-color: var(--surface);
  color: var(--ink);
  font-size: 13px;
  appearance: none;
  background-image: url("../assets/chevron-down.svg?no-inline");
  background-repeat: no-repeat;
  background-position: right 11px center;
}
.recall-page-size option { background: var(--surface); color: var(--ink); }
.recall-page-size:disabled { opacity: .5; cursor: default; }
.recall-page-arrow, .recall-page-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 34px;
  padding: 0 8px;
  border-radius: 6px;
}
.recall-page-arrow { border: 1px solid var(--control-line); background: var(--surface); }
.recall-page-arrow.previous .ui-icon { transform: rotate(180deg); }
.recall-page-number:hover:not(:disabled), .recall-page-arrow:hover:not(:disabled) { background: var(--hover); }
.recall-page-number[aria-current="page"] { background: var(--accent); color: #fff; }
.recall-page-gap { color: var(--muted); padding-inline: 4px; }
.recall-page-position { color: var(--muted); margin-left: 12px; white-space: nowrap; }
@media (max-width: 1100px) {
  .workspace-page, .recall-list-page { padding-inline: 16px; }
  .workspace-name-column { width: 190px; }
  .recall-pagination { padding: 10px 12px; }
  .recall-page-controls { margin-left: auto; }
}
@media (max-width: 700px) {
  .workspace-page, .recall-list-page { padding: 0 12px 12px; gap: 16px; }
  .workspace-page :deep(.page-header), .recall-list-page :deep(.page-header) { padding-inline: 0; }
  .workspace-toolbar { padding-inline: 0; }
  .workspace-table { min-width: 700px; }
  .workspace-count-column { width: 80px; }
  .recall-page-controls { margin-left: 0; gap: 4px; }
  .recall-page-position { margin-left: 4px; }
}
.recall-expressions { text-align: left; white-space: normal; overflow-wrap: anywhere; }
button.recall-expressions {
  display: block; width: 100%; min-width: 10rem; max-width: 32rem;
  height: auto; min-height: 28px; padding: 0; line-height: inherit;
}
.recall-expressions span { display: block; }
</style>
