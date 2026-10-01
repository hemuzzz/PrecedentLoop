<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import OverviewView from "./views/OverviewView.vue";
import AssetsView from "./views/AssetsView.vue";
import KnowledgeView from "./views/KnowledgeView.vue";
import SystemStatusView from "./views/SystemStatusView.vue";
import UiIcon from "./components/UiIcon.vue";
import SettingsView from "./settings/SettingsView.vue";
import IntegrationNotices from "./settings/IntegrationNotices.vue";
import AgentStatusMini from "./settings/AgentStatusMini.vue";
import { HubApiClient } from "./api/client.js";
import { initializeTheme } from "./settings/appearance.js";
import { navigate, useRoute, type Page } from "./navigation.js";
const route = useRoute();
const activeView = ref<{ refreshInbox?: () => Promise<void> }>();
let unsubscribeOpenInbox: (() => void) | undefined;
const collapsed = ref(false);
const desktopMac = navigator.userAgent.includes("PrecedentLoopDesktop/1");
const navigation: { page: Page; label: string; icon: string; group?: string }[] = [
  { page: "overview", label: "总览", icon: "overview" },
  { page: "library", label: "知识资产", icon: "library" },
  { page: "inbox", label: "知识候选", icon: "inbox" },
  { page: "workspaces", label: "工作区", icon: "layers" },
  { page: "recalls", label: "召回记录", icon: "search", group: "记录" },
  { page: "usage", label: "使用记录", icon: "activity" },
];
// Sidebar counts come from the same overview projection as the 总览 page.
const counts = ref<Partial<Record<Page, number>>>({});
const integrationPending = ref(0);
const api = new HubApiClient();
async function refreshCounts() {
  try {
    const overview = await api.getOverview();
    counts.value = { library: overview.scopes.reduce((n, scope) => n + Object.values(scope.assets).reduce((a, b) => a + b, 0), 0),
      inbox: overview.scopes.reduce((n, scope) => n + scope.inboxCount, 0) };
  } catch { counts.value = {}; }
}
const view = computed(
  () =>
    ({ overview: OverviewView, workspaces: KnowledgeView, recalls: KnowledgeView, usage: KnowledgeView, status: SystemStatusView, settings: SettingsView })[
      route.value.page as "overview" | "workspaces" | "recalls" | "usage" | "status" | "settings"
    ] ?? AssetsView,
);
function documentMainFocus() {
  document.getElementById("main-content")?.focus();
}
function shortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key === ",") {
    event.preventDefault(); navigate("settings", "general"); return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    navigate("search");
    requestAnimationFrame(() =>
      document.querySelector<HTMLInputElement>(".search-bar input")?.focus(),
    );
  }
}
onMounted(() => {
  unsubscribeOpenInbox = window.precedentSetup?.onOpenInbox?.(() => {
    if (route.value.page === "inbox") {
      void activeView.value?.refreshInbox?.();
      void refreshCounts();
    }
    else navigate("inbox");
  });
  initializeTheme();
  window.addEventListener("keydown", shortcut);
  void refreshCounts();
});
watch(() => route.value.page, page => { if (["overview", "library", "inbox"].includes(page)) void refreshCounts(); });
onBeforeUnmount(() => {
  unsubscribeOpenInbox?.();
  window.removeEventListener("keydown", shortcut);
});
</script>
<template>
  <div class="app-shell" :class="{ 'sidebar-collapsed': collapsed, 'desktop-mac': desktopMac }">
    <div v-if="desktopMac" class="window-drag-region" aria-hidden="true"></div>
    <a class="skip-link" href="#main-content" @click.prevent="documentMainFocus"
      >跳到主要内容</a
    >
    <aside class="sidebar" aria-label="主导航">
      <div class="sidebar-heading">
        <div v-if="!collapsed" class="brand-lockup">
          <span class="brand-mark">P</span><strong>Precedent Loop</strong>
        </div>
        <button
          type="button"
          class="icon-button"
          :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
          :aria-expanded="!collapsed"
          @click="collapsed = !collapsed"
        >
          <UiIcon name="panel" />
        </button>
      </div>
      <button
        type="button"
        class="sidebar-search nav-row"
        :class="{ active: route.page === 'search' }"
        aria-label="搜索知识"
        :aria-current="route.page === 'search' ? 'page' : undefined"
        title="搜索知识 · ⌘K"
        @click="navigate('search')"
      >
        <UiIcon name="search" /><span v-if="!collapsed">搜索知识</span>
      </button>
      <nav class="primary-navigation" aria-label="页面导航">
        <template v-for="item in navigation" :key="item.page">
          <p v-if="item.group && !collapsed" class="nav-group-label">{{ item.group }}</p>
          <button
            type="button"
            class="nav-row"
            :class="{ active: route.page === item.page }"
            :aria-label="item.label"
            :title="collapsed ? item.label : undefined"
            :aria-current="route.page === item.page ? 'page' : undefined"
            @click="navigate(item.page)"
          >
            <UiIcon :name="item.icon" /><span v-if="!collapsed">{{ item.label }}</span>
            <span v-if="!collapsed && counts[item.page] !== undefined" class="nav-count">{{ counts[item.page] }}</span>
          </button>
        </template>
      </nav>
      <div class="sidebar-footer">
        <AgentStatusMini :collapsed="collapsed" @pending="integrationPending = $event" />
        <button class="nav-row" :class="{ active: route.page === 'status' }" :aria-current="route.page === 'status' ? 'page' : undefined" aria-label="系统状态" :title="collapsed ? '系统状态' : undefined" @click="navigate('status')"><UiIcon name="monitor-activity" /><span v-if="!collapsed">系统状态</span></button>
        <button class="nav-row" :class="{ active: route.page === 'settings' }" :aria-current="route.page === 'settings' ? 'page' : undefined" aria-label="设置" title="设置 · ⌘," @click="navigate('settings', 'general')"><UiIcon name="gear" /><span v-if="!collapsed">设置</span><span v-if="integrationPending" class="nav-dot" aria-label="有待处理的接入"></span></button>
      </div>
    </aside>
    <div id="main-content" class="main-content" tabindex="-1">
      <IntegrationNotices />
      <KeepAlive><component :is="view" ref="activeView" /></KeepAlive>
    </div>
  </div>
</template>
