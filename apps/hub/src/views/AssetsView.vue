<script setup lang="ts">
import MarkdownIt from "markdown-it";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";
import { markdownPresentation } from "../markdown-presentation.js";
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";

import { HubApiClient, HubApiError, isAbortError } from "../api/client.js";
import type {
  AssetDetail,
  AssetLibraryItem,
  AssetListFilters,
  AssetType,
  InboxItem,
  IssueCard,
} from "../api/types.js";
import UiIcon from "../components/UiIcon.vue";
import type { PresentedError } from "./view-helpers.js";
import {
  asHubApiError,
  displayValue,
  formatDate,
  handleTabKeydown,
} from "./view-helpers.js";
import { navigate, navigateHash, useRoute } from "../navigation.js";
import PageHeader from "../components/PageHeader.vue";
import PreviewDialog from "../components/PreviewDialog.vue";
import FilterMenu from "../components/FilterMenu.vue";
import CandidateManager from "../components/CandidateManager.vue";
import CandidateSummary from "../components/CandidateSummary.vue";
import IssueList from "../components/IssueList.vue";

const emit = defineEmits<{ inboxChanged: [] }>();

type DetailTab = "RENDERED" | "RAW" | "INFO";
type ViewContext = "ASSET_LIST" | "ASSET_DETAIL" | "INBOX";

const api = new HubApiClient();
const renderer = new MarkdownIt({ html: false, linkify: false, typographer: false }).use(markdownItCjkFriendly);
const deleting = ref(false);
const deleteError = ref("");
async function deleteAsset() {
  const asset = assetDetail.value;
  if (!asset || deleting.value || !window.confirm(`删除《${asset.title}》？删除后将不再召回或显示此知识。`)) return;
  deleting.value = true; deleteError.value = "";
  try { await api.deleteAsset(asset.assetId, crypto.randomUUID()); closePreview(); refreshAssets(); }
  catch (error) {
    deleteError.value = error instanceof HubApiError && error.code === "ASSET_HAS_OPEN_CANDIDATE"
      ? "请先在候选页接受或拒绝该知识的待审／暂存候选，再删除知识。"
      : error instanceof Error ? error.message : "删除失败";
  }
  finally { deleting.value = false; }
}
const route = useRoute();
const activeView = computed(() =>
  route.value.page === "inbox" ? "INBOX" : "LIBRARY",
);
const searchMode = computed(() => route.value.page === "search");
const recordSource = computed(() => {
  const hash = new URLSearchParams(route.value.query).get("from");
  if (!hash || !/^#\/(recalls|usage)(?:\/[^/?]+)?(?:\?.*)?$/u.test(hash)) return null;
  return { hash, label: hash.startsWith("#/recalls") ? "返回召回记录" : "返回使用记录" };
});
const previewOpen = computed(
  () =>
    ["library", "search", "inbox"].includes(route.value.page) &&
    !!route.value.id,
);
const appliedFilters = ref<AssetListFilters>({ limit: 20 });
const hasFilters = computed(() => !!filters.type || libraryWorkspace.value !== "");
function closePreview() {
  navigate(route.value.page, undefined, false, Object.fromEntries(new URLSearchParams(route.value.query)));
}
function expandPreview() {
  navigate(route.value.page, route.value.id, !route.value.expanded, Object.fromEntries(new URLSearchParams(route.value.query)));
}
function openAsset(assetId: string) {
  navigate(route.value.page, assetId, false, Object.fromEntries(new URLSearchParams(route.value.query)));
}
function openInbox(item: InboxItem) {
  navigate("inbox", item.assetId);
}
// Candidates are cards (2026-09-25 redesign); the full candidate opens in a dialog instead of a side panel.
const inboxDetailOpen = ref(false);
const inboxDetailExpanded = ref(false);
function openInboxDetail(item: InboxItem) {
  openInbox(item);
  inboxDetailOpen.value = true;
}
function candidateLocked(item: InboxItem): boolean {
  return !inboxManaged.value || !!candidateManager.value?.writing || !!candidateManager.value?.isRewriting(item.candidateId);
}
// Card actions select the card first so progress and results show on it.
function cardAct(action: "accept" | "defer" | "reject", item: InboxItem) {
  openInbox(item);
  void candidateManager.value?.act(action, item);
}
function cardRewrite(item: InboxItem) {
  openInbox(item);
  void candidateManager.value?.open("rewrite", item);
}
function setLibraryType(type: "" | AssetType) {
  if (filters.type === type) return;
  filters.type = type;
  applyFilters();
}
const bucketCounts = computed(() => ({
  PENDING: inboxItems.value.filter(item => (item.status ?? "PENDING") === "PENDING").length + issueCards.value.length,
  DEFERRED: inboxItems.value.filter(item => item.status === "DEFERRED").length,
  ALL: inboxItems.value.length + issueCards.value.length,
}));

const filters = reactive({
  limit: 20 as 20 | 50 | 100,
  query: "",
  type: "" as "" | AssetType,
});
const libraryWorkspace = ref<string | null>("");
const appliedQuery = ref("");
const filterError = ref("");

const assets = ref<AssetLibraryItem[]>([]);
const assetTotal = ref(0);
const assetOffset = ref(0);
const listScroll = ref<HTMLElement>();
const pageSize = computed(() => appliedFilters.value.limit ?? 20);
const pageCount = computed(() => Math.ceil(assetTotal.value / pageSize.value));
const currentPage = computed(() => pageCount.value === 0 ? 0 : Math.floor(assetOffset.value / pageSize.value) + 1);
const pageNumbers = computed(() => {
  const count = pageCount.value;
  if (count <= 7) return Array.from({ length: count }, (_, index) => index + 1);
  const start = Math.max(2, Math.min(currentPage.value - 1, count - 3));
  const pages: (number | string)[] = [1];
  if (start > 2) pages.push("before");
  for (let page = start; page <= Math.min(start + 2, count - 1); page++) pages.push(page);
  if (start + 2 < count - 1) pages.push("after");
  pages.push(count);
  return pages;
});
const assetsLoading = ref(false);
const assetsError = ref<HubApiError>();
const selectedAssetId = ref<string>();
const assetDetail = ref<AssetDetail>();
const detailLoading = ref(false);
const detailError = ref<HubApiError>();
const detailTab = ref<DetailTab>("RENDERED");

const inboxItems = ref<InboxItem[]>([]);
const issueCards = ref<IssueCard[]>([]);
let preservingInboxDetails = false;
const candidateManager = ref<InstanceType<typeof CandidateManager>>();
const inboxManaged = ref(false);
const inboxBucket = ref<"PENDING" | "DEFERRED" | "ALL">("PENDING");
const inboxType = ref<"" | AssetType>("");
const inboxWorkspace = ref<string | null>("");
const inboxQuery = ref("");
const inboxPageSize = ref(20);
const inboxPage = ref(1);
const filteredIssueCards = computed(() => inboxBucket.value === "DEFERRED" ? [] : issueCards.value
  .filter(item => !inboxType.value || item.type === inboxType.value)
  .filter(item => inboxWorkspace.value === "" || (inboxWorkspace.value === null ? item.scope === "GLOBAL" : item.workspace === inboxWorkspace.value))
  .filter(item => !inboxQuery.value.trim() || [item.title, ...item.issues.map(issue => `${issue.detail}\n${issue.evidence ?? ''}\n${issue.queries?.join(' ') ?? ''}`)]
    .some(value => value.toLocaleLowerCase().includes(inboxQuery.value.trim().toLocaleLowerCase()))));
const filteredInbox = computed(() => inboxItems.value
  .filter(item => inboxBucket.value === "ALL" || (item.status ?? "PENDING") === inboxBucket.value)
  .filter(item => !inboxType.value || item.type === inboxType.value)
  .filter(item => inboxWorkspace.value === "" || (inboxWorkspace.value === null
    ? item.scope === "GLOBAL" : item.workspace === inboxWorkspace.value))
  .filter(item => !inboxQuery.value.trim() || [item.title, item.summary, item.retrievalTerms.join('\n'), item.bodyMarkdown]
    .some(value => value.toLocaleLowerCase().includes(inboxQuery.value.trim().toLocaleLowerCase())))
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.assetId.localeCompare(b.assetId)));
const inboxPageCount = computed(() => Math.ceil(filteredInbox.value.length / inboxPageSize.value));
const inboxPageItems = computed(() => filteredInbox.value.slice((inboxPage.value - 1) * inboxPageSize.value, inboxPage.value * inboxPageSize.value));
watch([inboxType, inboxWorkspace, inboxPageSize, inboxBucket, inboxQuery], () => {
  inboxPage.value = 1;
  if (listScroll.value) listScroll.value.scrollTop = 0;
});
watch(inboxPageCount, count => { inboxPage.value = Math.max(1, Math.min(inboxPage.value, count)); });
watch(inboxPage, () => { if (listScroll.value) listScroll.value.scrollTop = 0; });
const inboxLoading = ref(false);
const inboxError = ref<HubApiError>();
const selectedInboxItem = ref<InboxItem>();
const inboxOriginalOpen = ref(false);
const inboxOriginalExpanded = ref(false);
const inboxBaselineOpen = ref(false);
const inboxBaseline = ref<HTMLDetailsElement>();
async function toggleInboxBaseline(): Promise<void> {
  inboxBaselineOpen.value = !inboxBaselineOpen.value;
  if (inboxBaselineOpen.value) { await nextTick(); inboxBaseline.value?.scrollIntoView({ block: "nearest" }); }
}
watch(() => selectedInboxItem.value?.assetId, () => { inboxOriginalOpen.value = false; inboxBaselineOpen.value = false; });
watch([inboxBucket, inboxType, inboxWorkspace, inboxPageSize, inboxPage, inboxQuery], () => {
  if (!preservingInboxDetails && route.value.page === "inbox" && selectedInboxItem.value && !inboxPageItems.value.some(item => item.assetId === selectedInboxItem.value?.assetId)) closePreview();
});

let assetListRequest = 0;
let assetDetailRequest = 0;
let inboxRequest = 0;
let assetListController: AbortController | undefined;
let assetDetailController: AbortController | undefined;
let inboxController: AbortController | undefined;
let workspaceController: AbortController | undefined;
const workspaceSuggestions = ref<string[]>([]);
const workspacesLoading = ref(false);
const workspaceError = ref("");
const listErrorCopy = computed(() =>
  presentError(assetsError.value, "ASSET_LIST"),
);
const detailErrorCopy = computed(() =>
  presentError(detailError.value, "ASSET_DETAIL"),
);
const inboxErrorCopy = computed(() => presentError(inboxError.value, "INBOX"));

const searchInput = ref<HTMLInputElement>();
onBeforeUnmount(() => {
  assetListController?.abort();
  assetDetailController?.abort();
  inboxController?.abort();
  workspaceController?.abort();
});
watch(
  () => route.value,
  (current, previous) => {
    if (!["library", "search"].includes(current.page) || !current.id) {
      selectedAssetId.value = undefined;
      assetDetailRequest++;
      assetDetailController?.abort();
      assetDetail.value = undefined;
      detailError.value = undefined;
      detailLoading.value = false;
    }
    if (current.page === "inbox") {
      if (previous?.page !== "inbox") { void loadInbox(); inboxDetailOpen.value = !!current.id; }
      syncInboxSelection();
    } else if (["library", "search"].includes(current.page)) {
      inboxOriginalOpen.value = false;
      if (current.page !== previous?.page) void loadWorkspaces();
      if (current.id) selectAsset(current.id);
      if (current.page === "library" && !current.id && (current.query !== (previous?.query ?? "") || (current.page !== previous?.page && (current.query || previous?.page === "overview")))) {
        const query = new URLSearchParams(current.query);
        const type = query.get("type");
        filters.type = type === "MEMORY" || type === "DOCUMENT" || type === "SKILL" ? type : "";
        const workspace = query.get("workspace");
        libraryWorkspace.value = workspace === null ? "" : workspace === "null" ? null : workspace;
        filters.query = "";
        applyFilters();
        return;
      }


      if (current.page === "search" && previous?.page !== "search")
        void nextTick(() => searchInput.value?.focus());
      if (
        current.page === "library" &&
        (filters.query || appliedFilters.value.query)
      ) {
        resetFilters();
      } else if (!previous || previous.page === "inbox") {
        void loadAssets(appliedFilters.value);
      }
    }
  },
  { immediate: true },
);
function syncInboxSelection() {
  const id = route.value.page === "inbox" ? route.value.id : undefined;
  if (!id) { selectedInboxItem.value = undefined; return; }
  const item = inboxItems.value.find((item) => item.assetId === id);
  if (item) { selectInboxItem(item); return; }
  selectedInboxItem.value = undefined;
}
async function loadWorkspaces(): Promise<void> {
  workspaceController?.abort();
  const controller = new AbortController();
  workspaceController = controller;
  workspacesLoading.value = true;
  workspaceError.value = "";
  try {
    const result = await api.getWorkspaces(controller.signal);
    if (workspaceController === controller) {
      workspaceSuggestions.value = result.items.map(item => item.name).sort((a, b) => a.localeCompare(b));
    }
  } catch (error) {
    if (workspaceController === controller && !isAbortError(error)) workspaceError.value = "工作区列表读取失败";
  } finally {
    if (workspaceController === controller) workspacesLoading.value = false;
  }
}

function movePage(page: number): void {
  if (assetsLoading.value || page < 1 || page > pageCount.value || page === currentPage.value) return;
  void loadAssets({ ...appliedFilters.value, offset: (page - 1) * pageSize.value });
}

function refreshAssets(): void {
  void loadWorkspaces();
  void loadAssets(appliedFilters.value);
}

function shortDate(value: string): string {
  const date = new Date(value), now = new Date();
  if (Number.isNaN(date.getTime())) return value;
  if (date.toDateString() === now.toDateString()) return `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  return date.getFullYear() === now.getFullYear() ? `${date.getMonth() + 1}/${date.getDate()}` : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function formatListDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return parts.map(part => part.type === "literal" && part.value.includes(",") ? " " : part.value).join("");
}

function applyFilters(): void {
  filterError.value = "";
  const nextFilters = currentFilters();
  if (nextFilters === undefined) {
    return;
  }
  appliedQuery.value = nextFilters.query ?? "";
  appliedFilters.value = nextFilters;
  void loadAssets(nextFilters);
}

function resetFilters(): void {
  if (!searchMode.value) filters.query = "";
  filters.type = "";
  libraryWorkspace.value = "";
  applyFilters();
}

function currentFilters(): AssetListFilters | undefined {
  if (filters.query.length > 0 && filters.query.trim().length === 0) {
    filterError.value = "请输入有效的搜索关键词。";
    return undefined;
  }
  return {
    limit: filters.limit,
    offset: 0,
    ...(filters.query.length === 0 ? {} : { query: filters.query }),
    ...(filters.type === "" ? {} : { type: filters.type }),
    ...(libraryWorkspace.value === null
      ? { scope: "GLOBAL" as const, workspace: null }
      : libraryWorkspace.value !== ""
        ? { scope: "WORKSPACE" as const, workspace: libraryWorkspace.value }
        : {}),
  };
}

async function loadAssets(requestFilters: AssetListFilters): Promise<void> {
  const requestId = ++assetListRequest;
  assetListController?.abort();
  assetListController = new AbortController();
  assetsLoading.value = true;
  assetsError.value = undefined;
  appliedFilters.value = requestFilters;
  try {
    const result = await api.listAssets(
      requestFilters,
      assetListController.signal,
    );
    if (requestId !== assetListRequest) {
      return;
    }
    if (result.offset > 0 && result.offset >= result.total) {
      await loadAssets({ ...requestFilters, offset: Math.max(0, Math.ceil(result.total / result.limit) - 1) * result.limit });
      return;
    }
    assets.value = result.items;
    assetTotal.value = result.total;
    assetOffset.value = result.offset;
    await nextTick();
    if (requestId === assetListRequest && listScroll.value) listScroll.value.scrollTop = 0;
  } catch (error) {
    if (requestId !== assetListRequest || isAbortError(error)) {
      return;
    }
    assets.value = [];
    assetTotal.value = 0;
    assetOffset.value = 0;
    assetsError.value = asHubApiError(error);
  } finally {
    if (requestId === assetListRequest) {
      assetsLoading.value = false;
    }
  }
}

function selectAsset(assetId: string): void {
  if (
    selectedAssetId.value === assetId &&
    (assetDetail.value !== undefined || detailLoading.value)
  ) {
    return;
  }
  selectedAssetId.value = assetId;
  detailTab.value = "RENDERED";
  void loadAssetDetail(assetId);
}

async function loadAssetDetail(assetId: string): Promise<void> {
  const requestId = ++assetDetailRequest;
  assetDetailController?.abort();
  assetDetailController = new AbortController();
  detailLoading.value = true;
  detailError.value = undefined;
  assetDetail.value = undefined;
  try {
    const result = await api.getAsset(assetId, assetDetailController.signal);
    if (requestId === assetDetailRequest && selectedAssetId.value === assetId) {
      assetDetail.value = result.asset;
    }
  } catch (error) {
    if (requestId !== assetDetailRequest || isAbortError(error)) {
      return;
    }
    detailError.value = asHubApiError(error);
  } finally {
    if (requestId === assetDetailRequest) {
      detailLoading.value = false;
    }
  }
}

function retryDetail(): void {
  if (selectedAssetId.value === undefined) {
    return;
  }
  if (detailError.value?.status === 404) {
    closePreview();
    applyFilters();
  } else {
    void loadAssetDetail(selectedAssetId.value);
  }
}

defineExpose({ refreshInbox: () => loadInbox({ preserveDetails: true }) });
async function loadInbox({ preserveDetails = false }: { preserveDetails?: boolean } = {}): Promise<void> {
  void loadWorkspaces();
  const requestId = ++inboxRequest;
  inboxController?.abort();
  inboxController = new AbortController();
  inboxLoading.value = true;
  inboxError.value = undefined;
  try {
    const result = await api.getInbox(inboxController.signal);
    if (requestId !== inboxRequest) {
      return;
    }
    preservingInboxDetails = preserveDetails;
    inboxItems.value = result.items;
    issueCards.value = result.issueCards ?? [];
    emit("inboxChanged");
    inboxManaged.value = result.managed === true;
    if (preserveDetails) {
      if (selectedInboxItem.value) selectedInboxItem.value = result.items.find(item => item.assetId === selectedInboxItem.value?.assetId) ?? selectedInboxItem.value;
      await nextTick();
    } else if (route.value.page === "inbox" && selectedInboxItem.value && !filteredInbox.value.some(item => item.assetId === selectedInboxItem.value?.assetId)) closePreview();
    else syncInboxSelection();
  } catch (error) {
    if (requestId !== inboxRequest || isAbortError(error)) {
      return;
    }
    if (!preserveDetails) {
      inboxItems.value = [];
      issueCards.value = [];
      selectedInboxItem.value = undefined;
    }
    inboxError.value = asHubApiError(error);
  } finally {
    if (requestId === inboxRequest) {
      preservingInboxDetails = false;
      inboxLoading.value = false;
    }
  }
}

function selectInboxItem(item: InboxItem): void {
  selectedInboxItem.value = item;
}

function inboxChangeType(item: InboxItem): string {
  return item.intent === "REVISION" ? "修订" : item.intent === "NEW" ? "新增" : "—";
}

function presentError(
  error: HubApiError | undefined,
  context: ViewContext,
): PresentedError | undefined {
  if (error === undefined) {
    return undefined;
  }
  if (error.code === "SERVICE_UNREACHABLE") {
    return {
      title: "本地服务未连接",
      detail: "启动 Precedent Loop 服务后重试。",
    };
  }
  if (error.code === "INVALID_RESPONSE") {
    return {
      title: "无法读取服务响应",
      detail: "服务返回了无法识别的响应，请检查服务后重试。",
    };
  }
  if (context === "ASSET_DETAIL" && error.status === 404) {
    return {
      title: "知识资产已不存在",
      detail: "刷新资产列表以获取当前内容。",
    };
  }
  if (error.status === 503) {
    return {
      title: context === "INBOX" ? "知识候选暂时不可用" : "知识服务暂时不可用",
      detail: "主库或工作区配置尚未就绪，请恢复后重试。",
    };
  }
  if (error.status >= 500) {
    return { title: "本地服务未能完成请求", detail: "请检查服务日志后重试。" };
  }
  return { title: "请求未完成", detail: error.message };
}
</script>

<template>
  <main class="list-page asset-library-page" :class="{ 'inbox-page': activeView === 'INBOX' }">
    <PageHeader
      :title="activeView === 'INBOX' ? '知识候选' : searchMode ? '搜索知识' : '知识资产'"
      :subtitle="activeView === 'INBOX' ? '候选经你确认后才会成为正式知识，被 Agent 使用' : searchMode ? '搜索标题、摘要或正文' : assetsLoading ? '正在读取…' : `${assetTotal} 条正式知识`"
    >
      <template v-if="activeView === 'LIBRARY'">
        <button type="button" class="quiet-button" aria-label="刷新资产" :disabled="assetsLoading" @click="refreshAssets"><UiIcon name="refresh" />刷新</button>
      </template>
      <template v-else>
        <div class="segmented" role="group" aria-label="候选分区">
          <button v-for="bucket in (['PENDING', 'DEFERRED', 'ALL'] as const)" :key="bucket" type="button" :aria-pressed="inboxBucket === bucket" @click="inboxBucket = bucket">{{ bucket === 'PENDING' ? '待处理' : bucket === 'DEFERRED' ? '已暂存' : '全部' }} {{ bucketCounts[bucket] }}</button>
        </div>
        <button type="button" class="quiet-button" :disabled="inboxLoading" @click="loadInbox()"><UiIcon name="refresh" />刷新</button>
        <FilterMenu class="inbox-help" label="知识候选说明" icon="info">
          <div class="inbox-help-copy"><h2>等待确认的知识</h2><p>候选尚未正式入库，不参与知识召回。点击标题可查看摘要、正文与版本信息。</p><p>接受会确认当前审阅版本；暂存仅改变分区；拒绝会将候选标记为已拒绝。AI 改稿保存后仍需你接受。</p></div>
        </FilterMenu>
      </template>
    </PageHeader>

    <!-- 知识资产：左侧表格，右侧详情（2026-09-25 改版） -->
    <div v-if="activeView === 'LIBRARY'" class="library-split" :class="{ 'has-detail': previewOpen, expanded: previewOpen && route.expanded }">
      <div class="library-main">
        <div class="asset-filter-bar" aria-label="知识资产筛选">
          <div class="segmented" role="group" aria-label="类型">
            <button v-for="option in ([['', '全部'], ['MEMORY', '记忆'], ['DOCUMENT', '文档'], ['SKILL', '技能']] as const)" :key="option[0]" type="button" :aria-pressed="filters.type === option[0]" :disabled="assetsLoading" @click="setLibraryType(option[0])">{{ option[1] }}</button>
          </div>
          <label class="asset-filter-field">
            <span>工作区</span>
            <select v-model="libraryWorkspace" @change="applyFilters">
              <option value="">全部</option>
              <option :value="null">全局</option>
              <option v-for="workspace in workspaceSuggestions" :key="workspace" :value="workspace">{{ workspace }}</option>
              <option v-if="workspacesLoading" disabled>正在读取工作区…</option>
            </select>
          </label>
          <span v-if="workspaceError" class="field-error" role="alert">{{ workspaceError }} <button type="button" class="quiet-button" @click="loadWorkspaces">重试</button></span>
          <button v-if="hasFilters" type="button" class="asset-filter-reset" @click="resetFilters">清除筛选</button>
          <p v-if="filterError" class="field-error" role="alert">{{ filterError }}</p>
        </div>
        <form v-if="searchMode" class="search-bar" aria-label="搜索知识资产" @submit.prevent="applyFilters">
          <label class="search-input"><UiIcon name="search" /><input ref="searchInput" v-model="filters.query" type="search" aria-label="搜索" placeholder="搜索标题、摘要或正文…" /><button type="submit" class="quiet-button">搜索</button></label>
        </form>
        <section ref="listScroll" class="list-scroll asset-table-scroll" :aria-busy="assetsLoading" aria-label="知识资产列表">
          <div v-if="assetsLoading" class="state-panel" role="status">正在读取知识资产…</div>
          <div v-else-if="assetsError && listErrorCopy" class="state-panel" role="alert">
            <strong>{{ listErrorCopy.title }}</strong>
            <p>{{ listErrorCopy.detail }}</p>
            <button type="button" class="quiet-button" @click="refreshAssets">重试</button>
          </div>
          <div v-else-if="!assets.length" class="state-panel">
            <strong>没有找到知识资产</strong>
            <p>试试其他关键词，或调整筛选条件。</p>
          </div>
          <table v-else class="asset-table" aria-label="知识资产结果">
            <colgroup><col /><col class="asset-type-column" /><col class="asset-workspace-column" /><col class="asset-date-column" /></colgroup>
            <thead><tr><th scope="col">标题</th><th scope="col">类型</th><th scope="col">工作区</th><th scope="col" class="asset-date-heading">更新</th></tr></thead>
            <tbody>
              <tr v-for="asset in assets" :key="asset.assetId" :class="{ selected: asset.assetId === selectedAssetId }" @click="openAsset(asset.assetId)">
                <td>
                  <button type="button" class="asset-title-button" :title="asset.title" :aria-current="asset.assetId === selectedAssetId ? 'true' : undefined" @click.stop="openAsset(asset.assetId)">
                    <span class="asset-title-copy">
                      <span class="asset-title-text"><span v-if="asset.knowledgeNumber != null">#{{ asset.knowledgeNumber }} · </span>{{ asset.title }}</span>
                      <span v-if="appliedQuery && asset.matchedSnippet && asset.matchedSnippet.replace(/<\/?mark\b[^>]*>/giu, '').trim() !== asset.title.trim()" class="asset-snippet">{{ asset.matchedSnippet }}</span>
                    </span>
                  </button>
                </td>
                <td><span class="asset-type" :class="`asset-tone-${asset.type}`">{{ displayValue(asset.type) }}</span></td>
                <td class="asset-workspace-cell" :title="asset.workspace ?? '全局'">{{ asset.scope === 'GLOBAL' ? '全局' : asset.workspace }}</td>
                <td><time class="asset-updated" :datetime="asset.updatedAt" :title="formatListDate(asset.updatedAt)">{{ shortDate(asset.updatedAt) }}</time></td>
              </tr>
            </tbody>
          </table>
        </section>
        <nav v-if="assetTotal > 0 && !assetsError" class="asset-pagination" aria-label="知识资产分页">
          <p class="asset-page-summary" aria-live="polite">
            <template v-if="assetsLoading">正在读取…</template>
            <template v-else-if="assetsError">知识资产读取失败</template>
            <template v-else>共 {{ assetTotal }} 条 <span aria-hidden="true">·</span> 当前显示 {{ assets.length ? assetOffset + 1 : 0 }}–{{ assetOffset + assets.length }} 条</template>
          </p>
          <div class="asset-page-controls">
            <select v-model="filters.limit" class="asset-page-size" aria-label="每页条数" :disabled="assetsLoading" @change="applyFilters">
              <option :value="20">每页 20 条</option><option :value="50">每页 50 条</option><option :value="100">每页 100 条</option>
            </select>
            <button type="button" class="asset-page-arrow previous" aria-label="上一页" :disabled="assetsLoading || !!assetsError || currentPage <= 1" @click="movePage(currentPage - 1)"><UiIcon name="chevron" /></button>
            <template v-for="page in pageNumbers" :key="page">
              <button v-if="typeof page === 'number'" type="button" class="asset-page-number" :aria-label="`第 ${page} 页`" :aria-current="page === currentPage ? 'page' : undefined" :disabled="assetsLoading || !!assetsError" @click="movePage(page)">{{ page }}</button>
              <span v-else class="asset-page-gap" aria-hidden="true">…</span>
            </template>
            <button type="button" class="asset-page-arrow" aria-label="下一页" :disabled="assetsLoading || !!assetsError || currentPage >= pageCount" @click="movePage(currentPage + 1)"><UiIcon name="chevron" /></button>
            <span class="asset-page-position">第 {{ currentPage }} / {{ pageCount }} 页</span>
          </div>
        </nav>
      </div>

      <aside v-if="previewOpen" class="asset-detail-pane" aria-label="知识资产详情">
        <button v-if="recordSource" type="button" class="quiet-button asset-record-return" @click="navigateHash(recordSource.hash)">{{ recordSource.label }}</button>
        <div class="asset-detail-tools">
          <button type="button" class="icon-button" :aria-label="route.expanded ? '收起阅读视图' : '展开阅读'" @click="expandPreview"><UiIcon :name="route.expanded ? 'minimize' : 'expand'" /></button>
          <button type="button" class="icon-button" aria-label="关闭详情" @click="closePreview"><UiIcon name="close" /></button>
        </div>
        <div v-if="detailLoading" class="state-panel detail-state" role="status" aria-live="polite">
          <span class="loading-line" aria-hidden="true"></span><strong>正在打开知识资产…</strong>
          <p>正在读取正文与使用情况。</p>
        </div>
        <div v-else-if="detailError && detailErrorCopy" class="state-panel detail-state error-state" role="alert">
          <p class="error-code mono">{{ detailError.code }}</p>
          <strong>{{ detailErrorCopy.title }}</strong>
          <p>{{ detailErrorCopy.detail }}</p>
          <button type="button" class="secondary-button" @click="retryDetail">{{ detailError.status === 404 ? "刷新资产列表" : "重新加载" }}</button>
        </div>
        <article v-else-if="assetDetail" class="asset-detail">
          <span class="asset-type" :class="`asset-tone-${assetDetail.type}`">{{ displayValue(assetDetail.type) }}</span>
          <h2><span v-if="assetDetail.knowledgeNumber != null">#{{ assetDetail.knowledgeNumber }} · </span>{{ assetDetail.title }}</h2>
          <div class="asset-detail-tags">
            <span class="pill">{{ assetDetail.scope === "GLOBAL" ? "全局知识" : assetDetail.workspace }}</span>
            <span class="pill">{{ shortDate(assetDetail.updatedAt) }} 更新</span>
            <button type="button" class="quiet-button" :disabled="deleting" @click="deleteAsset">删除</button>
            <p v-if="deleteError" role="alert">{{ deleteError }}</p>
            <span class="pill">使用 {{ assetDetail.usageSummary.totalUsedCount }} 次</span>
          </div>
          <p class="asset-detail-summary">{{ assetDetail.summary }}</p>
          <p class="asset-detail-summary">检索词：{{ assetDetail.retrievalTerms.join(' · ') || '尚未填写' }}</p>
          <div class="asset-detail-tabs" role="tablist" aria-label="详情内容" @keydown="handleTabKeydown">
            <button v-for="tab in ([['RENDERED', '正文'], ['RAW', '原文'], ['INFO', '知识信息']] as const)" :id="`asset-tab-${tab[0]}`" :key="tab[0]" type="button" role="tab" aria-controls="asset-panel" :tabindex="detailTab === tab[0] ? 0 : -1" :aria-selected="detailTab === tab[0]" @click="detailTab = tab[0]">{{ tab[1] }}</button>
          </div>
          <div v-if="detailTab === 'RENDERED'" id="asset-panel" class="markdown-body" role="tabpanel" :aria-labelledby="`asset-tab-${detailTab}`" tabindex="0" v-html="markdownPresentation(renderer.render(assetDetail.bodyMarkdown))"></div>
          <pre v-else-if="detailTab === 'RAW'" id="asset-panel" class="source-view" role="tabpanel" :aria-labelledby="`asset-tab-${detailTab}`" tabindex="0">{{ assetDetail.bodyMarkdown }}</pre>
          <div v-else id="asset-panel" class="asset-detail-info" role="tabpanel" :aria-labelledby="`asset-tab-${detailTab}`" tabindex="0">
            <dl class="metadata-sheet single-column">
              <div><dt>资产 ID</dt><dd><code>{{ assetDetail.assetId }}</code></dd></div>
              <div><dt>工作区</dt><dd>{{ assetDetail.workspace ?? "全局知识" }}</dd></div>
              <div><dt>修改时间</dt><dd><time :datetime="assetDetail.updatedAt">{{ formatDate(assetDetail.updatedAt) }}</time></dd></div>
              <div><dt>内容版本</dt><dd><code>{{ assetDetail.version }}</code></dd></div>
            </dl>
            <dl class="usage-strip">
              <div><dt>召回</dt><dd>{{ assetDetail.usageSummary.recallCount }}</dd></div>
              <div><dt>读取</dt><dd>{{ assetDetail.usageSummary.readCount }}</dd></div>
              <div><dt>累计使用</dt><dd>{{ assetDetail.usageSummary.totalUsedCount }}</dd></div>
            </dl>
            <section class="usage-section" aria-label="最近知识事实">
              <h3>最近召回与使用</h3>
              <p>只统计已持久事实；内容更新不重置该知识的累计使用。</p>
              <p v-if="!assetDetail.recentRecalls.length && !assetDetail.recentUsage.length">暂无已记录事实。</p>
              <div v-for="item in assetDetail.recentRecalls" :key="item.recallItemId" class="metadata-grid">
                <code>{{ item.recallItemId }}</code><span>{{ item.deliveredMode }}</span>
                <span>读取 {{ item.readCount }} · 使用 {{ item.totalUsedCount }}</span>
                <span v-if="item.version !== assetDetail.version">内容已变化（仅显示交付证据）</span>
              </div>
              <div v-for="item in assetDetail.recentUsage" :key="item.id" class="metadata-grid">
                <span>{{ item.kind === 'READ' ? '读取' : '使用' }}</span><time>{{ formatDate(item.occurredAt) }}</time>
                <code>{{ item.id }}</code><span>{{ item.assetWorkspace ?? 'GLOBAL' }}</span>
              </div>
            </section>
          </div>
        </article>
        <div v-else class="state-panel detail-state">
          <strong>知识详情暂不可用</strong>
          <p>关闭详情后刷新列表，重新打开知识。</p>
        </div>
      </aside>
    </div>

    <!-- 知识候选：卡片列表，全文在对话框中查看（2026-09-25 改版） -->
    <template v-else>
      <CandidateManager ref="candidateManager" :workspaces="workspaceSuggestions" :managed="inboxManaged" :selected="selectedInboxItem" @refresh="loadInbox(); loadWorkspaces()">
        <template #filters>
          <div class="asset-filter-bar inbox-toolbar" aria-label="知识候选筛选">
            <label class="asset-filter-field"><span>类型</span><select v-model="inboxType"><option value="">全部类型</option><option value="MEMORY">记忆</option><option value="DOCUMENT">文档</option><option value="SKILL">技能</option></select></label>
            <label class="asset-filter-field"><span>工作区</span><select v-model="inboxWorkspace"><option value="">全部</option><option :value="null">全局</option><option v-for="workspace in workspaceSuggestions" :key="workspace" :value="workspace">{{ workspace }}</option><option v-if="workspacesLoading" disabled>正在读取工作区…</option></select></label>
            <span v-if="workspaceError" class="field-error" role="alert">{{ workspaceError }} <button type="button" class="quiet-button" @click="loadWorkspaces">重试</button></span>
          </div>
        </template>
        <template #search>
          <label class="inbox-search">
            <UiIcon name="search" />
            <input v-model="inboxQuery" type="search" aria-label="搜索知识候选" placeholder="搜索候选标题、摘要或内容…" />
            <button v-if="inboxQuery" type="button" class="icon-button" aria-label="清除候选搜索" @click="inboxQuery = ''"><UiIcon name="close" /></button>
          </label>
        </template>
      </CandidateManager>
      <section ref="listScroll" class="list-scroll candidate-scroll" :aria-busy="inboxLoading" aria-label="知识候选列表">
        <div v-if="inboxLoading && !inboxItems.length && !issueCards.length" class="state-panel" role="status">正在读取知识候选…</div>
        <div v-else-if="inboxError && inboxErrorCopy" class="state-panel" role="alert">
          <strong>{{ inboxErrorCopy.title }}</strong>
          <p>{{ inboxErrorCopy.detail }}</p>
          <button type="button" class="quiet-button" @click="loadInbox()">重试</button>
        </div>
        <div v-else-if="!inboxItems.length && !issueCards.length" class="state-panel">
          <strong>知识候选已清空</strong>
          <p>暂无待处理的知识候选。</p>
        </div>
        <div v-else class="candidate-list">
          <article v-for="card in filteredIssueCards" :key="`issues-${card.assetId}`" class="candidate-card">
            <div class="candidate-card-head"><span class="pill">待修订问题</span><span class="pill">{{ card.workspace ?? '全局' }}</span><span class="candidate-note">当前版本 {{ card.version }}</span></div>
            <h3>{{ card.title }}</h3>
            <IssueList :issues="card.issues" dismissible :disabled="candidateManager?.writing" @dismiss="candidateManager?.dismissIssue($event)" />
            <button type="button" class="primary-button" :disabled="!inboxManaged || candidateManager?.busy" @click="candidateManager?.draftRevision(card)">起草修订</button>
          </article>
          <article v-for="item in inboxPageItems" :key="item.assetId" class="candidate-card" :class="{ selected: selectedInboxItem?.assetId === item.assetId }" @click="openInbox(item)">
            <div class="candidate-card-head">
              <span class="pill">候选 #{{ item.number }}</span>
              <span v-if="item.intent === 'REVISION' && item.knowledgeNumber != null" class="pill">修订 #{{ item.knowledgeNumber }}</span>
              <span class="asset-type" :class="`asset-tone-${item.type}`">{{ displayValue(item.type) }}</span>
              <span class="pill">{{ item.workspace ?? '全局' }}</span>
              <span class="candidate-status" :data-status="inboxChangeType(item)">{{ inboxChangeType(item) }}</span>
              <span v-if="candidateManager?.isRewriting(item.candidateId)" class="candidate-note"><span class="candidate-spinner" aria-hidden="true"></span>AI 修改中…</span>
              <span v-else-if="inboxBucket === 'ALL' && item.status === 'DEFERRED'" class="candidate-note">已暂存</span>
              <time class="candidate-date" :datetime="item.updatedAt" :title="formatListDate(item.updatedAt)">{{ shortDate(item.updatedAt) }}</time>
            </div>
            <h3><button type="button" class="candidate-title" :aria-current="selectedInboxItem?.assetId === item.assetId ? 'true' : undefined" @click.stop="openInboxDetail(item)">{{ item.title }}</button></h3>
            <p class="candidate-summary">{{ item.summary }}</p>
            <p class="candidate-summary">检索词：{{ item.retrievalTerms.join(' · ') || '尚未填写' }}</p>
            <section v-if="item.issues?.length" @click.stop>
              <h4>接受后将关闭的问题</h4>
              <p class="candidate-summary">包含起草之后报告的问题，请确认修订是否已处理。</p>
              <IssueList :issues="item.issues" dismissible :disabled="candidateManager?.writing" @dismiss="candidateManager?.dismissIssue($event)" />
              <button v-if="item.issues.some(issue => issue.status === 'OPEN')" type="button" class="secondary-button" :disabled="!inboxManaged || candidateManager?.busy" @click="openInbox(item); candidateManager?.draftRevision(item)">起草修订</button>
            </section>
            <div v-if="selectedInboxItem?.assetId === item.assetId && candidateManager?.selectedFeedback?.text" class="candidate-feedback" :class="candidateManager.selectedFeedback.tone" :role="candidateManager.selectedFeedback.tone === 'error' ? 'alert' : 'status'">
              <UiIcon :name="candidateManager.selectedFeedback.tone === 'success' ? 'check' : candidateManager.selectedFeedback.tone === 'error' ? 'warning' : 'info'" />
              <span>{{ candidateManager.selectedFeedback.text }}</span>
              <button v-if="candidateManager.selectedFeedback.canDiff" type="button" class="quiet-button" @click.stop="candidateManager.showDiff()">查看改动<UiIcon name="chevron" /></button>
              <button v-if="candidateManager.selectedFeedback.canQuery" type="button" class="quiet-button" @click.stop="candidateManager.queryResult()">查询结果</button>
            </div>
            <div class="candidate-actions" @click.stop>
              <template v-if="item.candidateId">
                <button type="button" class="primary-button" :disabled="candidateLocked(item)" @click="cardAct('accept', item)">接受</button>
                <button type="button" class="secondary-button" :disabled="candidateLocked(item)" @click="cardAct('defer', item)">{{ item.status === 'DEFERRED' ? '恢复待处理' : '暂存' }}</button>
                <button type="button" class="secondary-button" :aria-busy="candidateManager?.isRewriting(item.candidateId)" :disabled="!inboxManaged || candidateManager?.busy" @click="cardRewrite(item)"><UiIcon name="sparkles" />AI 改稿</button>
              </template>
              <span class="candidate-spacer"></span>
              <button type="button" class="quiet-button candidate-link" @click="openInboxDetail(item)">查看全文</button>
              <button v-if="item.candidateId" type="button" class="secondary-button danger-text" :disabled="candidateLocked(item)" @click="cardAct('reject', item)">拒绝</button>
            </div>
          </article>
          <div v-if="!inboxPageItems.length && !filteredIssueCards.length && (inboxItems.length || issueCards.length)" class="state-panel"><strong>没有符合条件的候选或问题</strong><p>试试其他关键词，或调整筛选条件。</p><button type="button" class="quiet-button" @click="inboxType = ''; inboxWorkspace = ''; inboxBucket = 'ALL'; inboxQuery = ''">清除筛选与搜索</button></div>
          <p v-if="inboxPageItems.length" class="candidate-hint">接受：确认当前版本并入库 · 暂存：稍后处理 · 拒绝：标记为已拒绝。AI 改稿保存后仍需你接受。</p>
        </div>
      </section>
      <nav v-if="inboxPageCount > 1" class="asset-pagination candidate-pagination" aria-label="知识候选分页">
        <p class="asset-page-summary" aria-live="polite">共 {{ filteredInbox.length }} 条候选，当前显示 {{ inboxPageItems.length ? (inboxPage - 1) * inboxPageSize + 1 : 0 }}–{{ inboxPageItems.length ? (inboxPage - 1) * inboxPageSize + inboxPageItems.length : 0 }} 条</p>
        <div class="asset-page-controls">
          <select v-model="inboxPageSize" class="asset-page-size" aria-label="每页条数" :disabled="inboxLoading"><option :value="20">每页 20 条</option><option :value="50">每页 50 条</option><option :value="100">每页 100 条</option></select>
          <button type="button" class="asset-page-arrow previous" aria-label="上一页" :disabled="inboxLoading || !!inboxError || inboxPage <= 1" @click="inboxPage--"><UiIcon name="chevron" /></button>
          <button type="button" class="asset-page-arrow" aria-label="下一页" :disabled="inboxLoading || !!inboxError || inboxPage >= inboxPageCount" @click="inboxPage++"><UiIcon name="chevron" /></button>
          <span class="asset-page-position">第 {{ inboxPageCount ? inboxPage : 0 }} / {{ inboxPageCount }} 页</span>
        </div>
      </nav>

      <PreviewDialog v-if="inboxDetailOpen && (selectedInboxItem || route.id)" class="candidate-dialog" label="候选详情" :expanded="inboxDetailExpanded" @close="inboxDetailOpen = false" @expand="inboxDetailExpanded = !inboxDetailExpanded">
        <div class="inbox-detail-panel">
          <template v-if="selectedInboxItem">
            <header class="inbox-preview-heading">
              <h2><span>{{ selectedInboxItem.title }}</span></h2>
              <button type="button" class="secondary-button" @click="inboxOriginalExpanded = false; inboxOriginalOpen = true">查看原文<UiIcon name="external" /></button>
            </header>
            <dl class="inbox-candidate-meta">
              <div><dt>候选编号</dt><dd>候选 #{{ selectedInboxItem.number }}</dd></div>
              <div v-if="selectedInboxItem.intent === 'REVISION' && selectedInboxItem.knowledgeNumber != null"><dt>修订目标</dt><dd>修订 #{{ selectedInboxItem.knowledgeNumber }}</dd></div>
              <div><dt>工作区</dt><dd :title="selectedInboxItem.workspace ?? '全局'">{{ selectedInboxItem.workspace ?? '全局' }}</dd></div>
              <div><dt>内容类型</dt><dd><span class="asset-type" :class="`asset-tone-${selectedInboxItem.type}`">{{ displayValue(selectedInboxItem.type) }}</span></dd></div>
              <div><dt>变更类型</dt><dd><span class="candidate-status" :data-status="inboxChangeType(selectedInboxItem)">{{ inboxChangeType(selectedInboxItem) }}</span></dd></div>
              <div><dt>更新时间</dt><dd><time :datetime="selectedInboxItem.updatedAt">{{ formatListDate(selectedInboxItem.updatedAt) }}</time></dd></div>
            </dl>
            <article :key="selectedInboxItem.assetId" class="inbox-document">
              <div class="inbox-preview-scroll">
                <CandidateSummary :item="selectedInboxItem" />
                <details v-if="selectedInboxItem.baselineMarkdown" ref="inboxBaseline" class="detail-disclosure" :open="inboxBaselineOpen" @toggle="inboxBaselineOpen = ($event.target as HTMLDetailsElement).open">
                  <summary>正式内容对照{{ selectedInboxItem.baseVersion === null ? '（尚未绑定基线）' : selectedInboxItem.currentFormalVersion !== selectedInboxItem.baseVersion ? '（基线已变化）' : '' }}</summary>
                  <pre class="source-view">{{ selectedInboxItem.baselineMarkdown }}</pre>
                </details>
                <details class="detail-disclosure">
                  <summary>完整元信息</summary>
                  <dl class="metadata-sheet">
                    <div><dt>候选编号</dt><dd><code>候选 #{{ selectedInboxItem.number }}</code></dd></div>
                    <div><dt>资产 ID</dt><dd><code>{{ selectedInboxItem.assetId }}</code></dd></div>
                    <div><dt>范围</dt><dd>{{ displayValue(selectedInboxItem.scope) }}</dd></div>
                    <div><dt>工作区</dt><dd>{{ selectedInboxItem.workspace ?? "全局知识" }}</dd></div>
                    <div><dt>修改时间</dt><dd>{{ formatDate(selectedInboxItem.updatedAt) }}</dd></div>
                    <div class="wide-row"><dt>内容版本</dt><dd><code>{{ selectedInboxItem.version }}</code></dd></div>
                  </dl>
                </details>
              </div>
              <footer class="candidate-footer">
                <div v-if="candidateManager?.selectedFeedback?.text || selectedInboxItem.baselineMarkdown" class="candidate-review-bar">
                  <div v-if="candidateManager?.selectedFeedback?.text" class="candidate-feedback" :class="candidateManager.selectedFeedback.tone" :role="candidateManager.selectedFeedback.tone === 'error' ? 'alert' : 'status'">
                    <UiIcon :name="candidateManager.selectedFeedback.tone === 'success' ? 'check' : candidateManager.selectedFeedback.tone === 'error' ? 'warning' : 'info'" />
                    <span>{{ candidateManager.selectedFeedback.text }}</span>
                    <button v-if="candidateManager.selectedFeedback.canDiff" type="button" class="quiet-button" @click="candidateManager.showDiff()">查看改动<UiIcon name="chevron" /></button>
                    <button v-if="candidateManager.selectedFeedback.canQuery" type="button" class="quiet-button" @click="candidateManager.queryResult()">查询结果</button>
                  </div>
                  <button v-if="selectedInboxItem.baselineMarkdown" type="button" class="secondary-button baseline-button" :aria-expanded="inboxBaselineOpen" @click="toggleInboxBaseline"><UiIcon name="layers" />正式内容对照</button>
                </div>
                <div class="candidate-actions">
                  <template v-if="selectedInboxItem.candidateId">
                    <button type="button" class="primary-button" :disabled="candidateLocked(selectedInboxItem)" @click="candidateManager?.act('accept', selectedInboxItem)"><UiIcon name="tick" />接受</button>
                    <button type="button" class="secondary-button" :disabled="candidateLocked(selectedInboxItem)" @click="candidateManager?.act('defer', selectedInboxItem)"><UiIcon name="folder" />{{ selectedInboxItem.status === 'DEFERRED' ? '恢复待处理' : '暂存' }}</button>
                    <button type="button" class="secondary-button" :aria-busy="candidateManager?.isRewriting(selectedInboxItem.candidateId)" :disabled="!inboxManaged || candidateManager?.busy" @click="candidateManager?.open('rewrite', selectedInboxItem)"><span v-if="candidateManager?.isRewriting(selectedInboxItem.candidateId)" class="candidate-spinner" aria-hidden="true"></span><UiIcon v-else name="sparkles" />{{ candidateManager?.isRewriting(selectedInboxItem.candidateId) ? 'AI 修改中…' : 'AI 改稿' }}</button>
                    <button type="button" class="secondary-button" :disabled="candidateLocked(selectedInboxItem)" @click="candidateManager?.act('reject', selectedInboxItem)"><UiIcon name="ban" />拒绝</button>
                  </template>
                </div>
              </footer>
            </article>
          </template>
          <div v-else-if="inboxLoading" class="state-panel detail-state" role="status" aria-live="polite"><span class="loading-line" aria-hidden="true"></span><strong>正在读取知识候选…</strong></div>
          <div v-else class="state-panel detail-state">
            <strong>候选已不存在</strong>
            <p>关闭详情后刷新知识候选，查看当前待处理候选。</p>
          </div>
        </div>
      </PreviewDialog>
      <PreviewDialog v-if="inboxOriginalOpen && selectedInboxItem" label="候选原文" :expanded="inboxOriginalExpanded" @close="inboxOriginalOpen = false" @expand="inboxOriginalExpanded = !inboxOriginalExpanded">
        <article class="detail-document inbox-original-document">
          <header class="document-header"><p class="eyebrow">Markdown 原文</p><h2>{{ selectedInboxItem.title }}</h2></header>
          <pre class="source-view" tabindex="0" aria-label="完整候选原文">{{ selectedInboxItem.bodyMarkdown }}</pre>
        </article>
      </PreviewDialog>
    </template>
  </main>
</template>

<style scoped>
.asset-library-page { padding: 0 24px 20px; min-height: 0; gap: 14px; }
.asset-library-page :deep(.page-header) { padding: 8px 4px 0; border-bottom: 0; min-height: 60px; }
.asset-library-page :deep(.page-heading h1) { font-size: 22px; line-height: 30px; font-weight: 600; }
.asset-library-page :deep(.page-heading p) { margin-top: 2px; font-size: 13px; line-height: 18px; }
.asset-library-page :deep(.page-actions) { display: flex; align-items: center; gap: 8px; }
.asset-library-page :deep(.page-actions .quiet-button) { height: 32px; padding-inline: 12px; gap: 8px; border-color: var(--line); font-size: 13px; }

/* Shared pieces */
.segmented { display: inline-flex; flex-shrink: 0; overflow: hidden; border: 1px solid var(--control-line); border-radius: var(--radius); }
.segmented button { padding: 5px 12px; color: var(--muted); font-size: 12.5px; line-height: 20px; white-space: nowrap; }
.segmented button + button { border-left: 1px solid var(--control-line); }
.segmented button:hover:not(:disabled) { color: var(--ink); }
.segmented button[aria-pressed="true"] { background: var(--selected); color: var(--ink); }
.pill { display: inline-flex; align-items: center; padding: 1px 8px; border: 1px solid var(--control-line); border-radius: 999px; color: var(--muted); font-size: 11.5px; line-height: 18px; white-space: nowrap; }
.asset-type { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.asset-type::before { content: ""; width: 8px; height: 8px; border-radius: 2px; background: var(--asset-tone); }
.asset-tone-MEMORY { --asset-tone: var(--asset-memory); }
.asset-tone-DOCUMENT { --asset-tone: var(--asset-document); }
.asset-tone-SKILL { --asset-tone: var(--asset-skill); }
.asset-filter-bar { display: flex; align-items: center; flex-wrap: wrap; flex-shrink: 0; gap: 10px 14px; padding: 0 4px; font-size: 13px; }
.asset-filter-field { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.asset-filter-field > span { color: var(--muted); white-space: nowrap; }
.asset-filter-field select, .asset-page-size {
  height: 32px; padding: 0 30px 0 10px; border: 1px solid var(--control-line); border-radius: var(--radius);
  background-color: var(--surface); color: var(--ink); font-size: 12.5px; appearance: none;
  background-image: url("../assets/chevron-down.svg?no-inline"); background-repeat: no-repeat; background-position: right 10px center;
}
.asset-filter-field select { min-width: 132px; max-width: 220px; }
select option { background: var(--surface); color: var(--ink); }
select:disabled { opacity: .5; cursor: default; }
.asset-filter-reset { color: var(--muted); padding: 6px 0; font-size: 12.5px; }
.asset-filter-reset:hover { color: var(--ink); }
.asset-filter-bar > .field-error { flex-basis: 100%; }
.asset-library-page .search-bar { padding: 0 4px; }
.asset-pagination { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 18px; padding: 10px 4px 0; font-size: 12px; font-variant-numeric: tabular-nums; }
.asset-page-summary { color: var(--muted); white-space: nowrap; }
.asset-page-summary > span { padding-inline: 4px; }
.asset-page-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.asset-page-size { margin-right: 6px; }
.asset-page-arrow, .asset-page-number { display: inline-flex; align-items: center; justify-content: center; min-width: 30px; height: 30px; padding: 0 8px; border-radius: var(--radius); }
.asset-page-arrow { border: 1px solid var(--control-line); background: var(--surface); }
.asset-page-arrow.previous .ui-icon { transform: rotate(180deg); }
.asset-page-number:hover:not(:disabled), .asset-page-arrow:hover:not(:disabled) { background: var(--hover); }
.asset-page-number[aria-current="page"] { background: var(--accent); color: #fff; }
.asset-page-gap { color: var(--muted); padding-inline: 4px; }
.asset-page-position { color: var(--muted); margin-left: 10px; white-space: nowrap; }

/* 知识资产 */
.asset-library-page { container-type: inline-size; container-name: asset-page; }
.library-split { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); flex: 1; min-height: 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--surface); }
.library-split.has-detail { grid-template-columns: minmax(0, 1fr) minmax(360px, 420px); }
.library-split.expanded { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
.library-split.expanded .library-main { display: none; }
.library-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 12px; padding: 16px 16px 14px 20px; background: var(--canvas); }
.asset-table-scroll { padding: 0; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: var(--control-line) transparent; }
.asset-table { width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 0; font-size: 13.5px; text-align: left; }
.asset-type-column { width: 84px; }
.asset-workspace-column { width: 150px; }
.asset-date-column { width: 104px; }
.asset-table th { position: sticky; top: 0; z-index: 1; padding: 8px 12px; background: var(--canvas); color: var(--muted); font-size: 12px; font-weight: 500; border-bottom: 1px solid var(--line); white-space: nowrap; }
.asset-table .asset-date-heading { text-align: right; }
.asset-table td { padding: 0 12px; height: 42px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.asset-table td:first-child { padding: 0; }
.asset-table td:last-child { text-align: right; }
.asset-table tbody tr { cursor: pointer; }
.asset-table tbody tr:hover, .asset-table tbody tr:focus-within { background: var(--row-hover); }
.asset-table tbody tr.selected { background: var(--selected); }
.asset-title-button { display: flex; align-items: center; width: 100%; min-height: 41px; padding: 10px 12px; text-align: left; line-height: 21px; }
.asset-title-button:focus-visible { outline-offset: -3px; box-shadow: none; }
.asset-title-copy { display: block; min-width: 0; }
.asset-title-text { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-snippet { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 3px; color: var(--muted); font-size: 12px; line-height: 18px; }
.asset-workspace-cell { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-updated { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.asset-detail-pane { position: relative; min-width: 0; min-height: 0; overflow: auto; padding: 22px 24px; border-left: 1px solid var(--line); scrollbar-width: thin; scrollbar-color: var(--control-line) transparent; }
.library-split.expanded .asset-detail-pane { border-left: 0; padding-inline: max(24px, calc((100% - 820px) / 2)); }
.asset-detail-tools { position: absolute; top: 12px; right: 12px; display: flex; gap: 2px; }
.asset-record-return { margin: 0 64px 12px 0; }
.asset-detail h2 { margin: 8px 40px 8px 0; font-size: 18px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.asset-detail-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.asset-detail-summary { margin: 0 0 16px; color: var(--muted); font-size: 13.5px; line-height: 1.7; }
.asset-detail-tabs { display: flex; gap: 18px; margin-bottom: 14px; border-bottom: 1px solid var(--line); font-size: 13px; }
.asset-detail-tabs button { padding: 8px 0; color: var(--muted); }
.asset-detail-tabs button[aria-selected="true"] { color: var(--ink); box-shadow: inset 0 -2px var(--accent); }
.asset-detail .markdown-body { font-size: 13.5px; }
.asset-detail .source-view { margin: 0; }
.asset-detail-info { display: grid; gap: 16px; }
.asset-detail-info .metadata-sheet code { overflow-wrap: anywhere; }

/* 知识候选 */
.inbox-page :deep(.candidate-manager) { width: 100%; }
.inbox-page :deep(.candidate-toolbar) { gap: 10px 14px; }
.inbox-toolbar { padding: 0; }
.inbox-search { display: flex; flex: 1 1 220px; align-items: center; gap: 8px; min-width: 180px; max-width: 320px; height: 32px; margin-left: auto; padding: 0 8px 0 10px; border: 1px solid var(--control-line); border-radius: var(--radius); background: var(--surface); color: var(--muted); }
.inbox-search:focus-within { border-color: var(--accent); }
.inbox-search input { width: 100%; min-width: 0; padding: 0; border: 0; background: transparent; font-size: 12.5px; }
.inbox-search input:focus-visible { outline: none; box-shadow: none; }
.inbox-search input::-webkit-search-cancel-button { display: none; }
.inbox-search .icon-button { width: 22px; height: 24px; padding: 3px; }
.inbox-help :deep(summary) { height: 32px; padding-inline: 4px; gap: 6px; color: var(--muted); font-size: 12px; }
.inbox-help :deep(.dropdown-panel) { width: min(340px, calc(100vw - 80px)); padding: 16px; }
.inbox-help-copy { color: var(--muted); font-size: 12px; line-height: 1.7; }
.inbox-help-copy h2 { color: var(--ink); font-size: 13px; margin-bottom: 10px; }
.inbox-help-copy p + p { margin-top: 8px; }
.candidate-scroll { padding: 0 4px; scrollbar-width: thin; scrollbar-color: var(--control-line) transparent; }
.candidate-list { display: grid; gap: 12px; }
.candidate-card { display: grid; gap: 6px; padding: 16px 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); cursor: default; }
.candidate-card.selected { border-color: color-mix(in srgb, var(--accent) 60%, var(--line)); }
.candidate-card-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.candidate-date { margin-left: auto; color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.candidate-card h3 { margin: 4px 0 0; font-size: 15px; font-weight: 600; line-height: 1.4; }
.candidate-title { text-align: left; overflow-wrap: anywhere; }
.candidate-title:hover { color: var(--accent); }
.candidate-card > .candidate-summary { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; margin: 0 0 6px; color: var(--muted); font-size: 13.5px; line-height: 1.65; }
.candidate-note { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; }
.candidate-note .ui-icon { width: 12px; height: 12px; }
.candidate-status { display: inline-flex; padding: 1px 8px; border-radius: 999px; background: var(--hover); color: var(--muted); font-size: 11.5px; line-height: 18px; white-space: nowrap; }
.candidate-status[data-status="新增"] { color: var(--success); background: color-mix(in srgb, var(--success) 13%, transparent); }
.candidate-status[data-status="修订"] { color: var(--accent); background: color-mix(in srgb, var(--accent) 13%, transparent); }
.candidate-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.candidate-actions button { min-height: 30px; padding: 4px 12px; gap: 6px; font-size: 13px; }
.candidate-actions .ui-icon { width: 14px; height: 14px; }
.candidate-actions button[aria-busy="true"] { color: var(--accent); cursor: wait; }
.candidate-spacer { flex: 1; }
.candidate-link { color: var(--accent); border-color: transparent; }
.danger-text { color: var(--warning); }
.candidate-hint { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
.candidate-feedback { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; color: var(--muted); font-size: 12.5px; line-height: 18px; }
.candidate-feedback > .ui-icon { width: 15px; height: 15px; }
.candidate-feedback.success > .ui-icon { color: var(--success); }
.candidate-feedback.error { color: var(--warning); }
.candidate-feedback .quiet-button { padding: 0 2px; min-height: 24px; font-size: 12px; color: var(--accent); }
.candidate-feedback .quiet-button .ui-icon { width: 12px; height: 12px; }
.candidate-spinner { flex-shrink: 0; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: candidate-spin 1s linear infinite; }
@keyframes candidate-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .candidate-spinner { animation: none; } }

/* 候选详情对话框 */
.candidate-dialog:not(.full-detail) { width: min(760px, calc(100vw - 32px)); }
.inbox-detail-panel { display: flex; flex-direction: column; min-width: 0; padding: 16px 20px 16px; }
.candidate-dialog .candidate-footer { position: sticky; bottom: 0; background: var(--surface); padding-bottom: 4px; }
.candidate-dialog.full-detail .candidate-footer { background: var(--canvas); }
.candidate-dialog.full-detail .inbox-detail-panel { max-width: 880px; margin: 0 auto; }
.inbox-preview-heading { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding: 4px 48px 12px 0; border-bottom: 1px solid var(--line); }
.inbox-preview-heading h2 { flex: 1; min-width: 0; font-size: 17px; line-height: 24px; font-weight: 600; overflow-wrap: anywhere; }
.inbox-preview-heading .secondary-button { height: 30px; padding-inline: 10px; gap: 6px; font-size: 12px; }
.inbox-preview-heading .secondary-button .ui-icon { width: 13px; height: 13px; }
.inbox-candidate-meta { display: flex; flex-shrink: 0; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0; padding: 10px 0; border-bottom: 1px solid var(--line); }
.inbox-candidate-meta > div { display: flex; min-width: 0; align-items: center; gap: 8px; }
.inbox-candidate-meta > div + div { padding-left: 12px; border-left: 1px solid var(--line); }
.inbox-candidate-meta dt { color: var(--muted); font-size: 12px; white-space: nowrap; }
.inbox-candidate-meta dd { margin: 0; font-size: 12px; line-height: 20px; overflow-wrap: anywhere; }
.inbox-document { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.inbox-preview-scroll { flex: 1; min-height: 0; overflow: auto; padding: 0 0 16px; scrollbar-width: thin; scrollbar-color: var(--control-line) transparent; overflow-wrap: anywhere; }
.inbox-preview-scroll > .field-error, .inbox-preview-scroll > [role="status"] { margin-top: 12px; font-size: 12px; }
.inbox-detail-panel .source-view { margin-block: 0; }
.inbox-detail-panel .metadata-sheet { grid-template-columns: minmax(0, 1fr); }
.candidate-footer { flex-shrink: 0; padding: 12px 0 0; border-top: 1px solid var(--line); }
.candidate-review-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.baseline-button { margin-left: auto; min-height: 30px; padding: 4px 9px; font-size: 12px; }
.inbox-original-document { padding-top: 12px; }

@media (max-width: 1100px) {
  .asset-library-page { padding-inline: 16px; }
}
@container asset-page (max-width: 1120px) {
  .library-split.has-detail:not(.expanded) { grid-template-columns: minmax(0, 1fr) 360px; }
  .has-detail .asset-workspace-column, .has-detail .asset-table th:nth-child(3), .has-detail .asset-table td:nth-child(3) { display: none; }
}
@container asset-page (max-width: 940px) {
  .has-detail .asset-date-column, .has-detail .asset-table th:nth-child(4), .has-detail .asset-table td:nth-child(4) { display: none; }
}
@container asset-page (max-width: 780px) {
  .library-split.has-detail:not(.expanded) { grid-template-columns: minmax(0, 1fr); }
  .library-split.has-detail .library-main { display: none; }
  .library-split.has-detail .asset-detail-pane { border-left: 0; }
  .asset-workspace-column, .asset-table th:nth-child(3), .asset-table td:nth-child(3) { display: none; }
}
@container asset-page (max-width: 560px) {
  .asset-date-column, .asset-table th:nth-child(4), .asset-table td:nth-child(4) { display: none; }
}
@media (max-width: 700px) {
  .asset-library-page { padding: 0 12px 12px; gap: 12px; }
  .asset-library-page :deep(.page-header) { flex-wrap: wrap; gap: 10px; padding: 8px 0 0; }
  .asset-filter-field { flex: 1 1 200px; justify-content: space-between; }
  .asset-filter-field select { flex: 1; max-width: none; }
  .library-main { padding: 12px; }
  .inbox-search { flex-basis: 100%; max-width: none; }
  .candidate-card { padding: 14px; }
  .inbox-candidate-meta > div + div { border-left: 0; padding-left: 0; }
}
</style>
