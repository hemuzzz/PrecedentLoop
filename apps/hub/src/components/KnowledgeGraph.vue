<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { OverviewDto } from "../api/types.js";
import { navigate } from "../navigation.js";
import UiIcon from "./UiIcon.vue";

const props = defineProps<{ scopes: OverviewDto["scopes"] }>();
const categories = [
  { key: "MEMORY", label: "记忆", icon: "memory" },
  { key: "DOCUMENT", label: "文档", icon: "document" },
  { key: "SKILL", label: "技能", icon: "code" },
  { key: "INBOX", label: "待确认", icon: "inbox" },
] as const;
const query = ref("");
const expanded = reactive(new Map<string, boolean>());
const limits = reactive(new Map<string, number>());
const viewport = ref<HTMLElement>();
const camera = reactive({ x: 24, y: 24, scale: 1 });
const size = reactive({ width: 1000, height: 650 });
const searching = computed(() => query.value.trim().length > 0);
type Node = {
  id: string; kind: "root" | "workspace" | "category" | "asset" | "more";
  label: string; icon: string; tone: string; subtitle?: string; count?: number;
  open?: boolean; disabled?: boolean; assetId?: string; pending?: boolean;
  children: Node[]; x: number; y: number; width: number; height: number;
};
function node(fields: Omit<Node, "children" | "x" | "y" | "width" | "height">, children: Node[] = []): Node {
  return { ...fields, children, x: 0, y: 0, width: 0, height: fields.kind === "root" || fields.kind === "workspace" ? 66 : fields.kind === "asset" ? 52 : 44 };
}
const graph = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(term);
  const scopes: Node[] = [];
  for (const scope of props.scopes) {
    const scopeId = JSON.stringify(scope.workspace);
    const label = scope.workspace ?? "GLOBAL（全局）";
    const scopeMatches = matches(label);
    const branches: Node[] = [];
    for (const category of categories) {
      const id = `${scopeId}/${category.key}`;
      const all = scope.items.filter(item => category.key === "INBOX" ? item.pending : !item.pending && item.type === category.key);
      const items = all.filter(item => scopeMatches || matches(category.label) || matches(item.title));
      if (term && !scopeMatches && !matches(category.label) && !items.length) continue;
      const count = category.key === "INBOX" ? scope.inboxCount : scope.assets[category.key];
      const open = count > 0 && (searching.value || (expanded.get(id) ?? (count === 1)));
      const limit = limits.get(id) ?? 8;
      const children = open ? items.slice(0, limit).map(item => node({
        id: `${id}/${item.assetId}`, kind: "asset", label: item.title, icon: "document", tone: category.key,
        assetId: item.assetId, pending: item.pending,
      })) : [];
      if (open && items.length > limit) children.push(node({ id: `${id}/more`, kind: "more", label: `再显示 ${Math.min(8, items.length - limit)} 条 · 剩余 ${items.length - limit}`, icon: "plus", tone: category.key }));
      branches.push(node({ id, kind: "category", label: category.label, icon: category.icon, tone: category.key, count, open, disabled: count === 0 }, children));
    }
    if (term && !scopeMatches && !branches.length) continue;
    const open = searching.value || (expanded.get(scopeId) ?? true);
    const total = Object.values(scope.assets).reduce((a, b) => a + b, 0);
    scopes.push(node({ id: scopeId, kind: "workspace", label, icon: "folder", tone: "workspace", open,
      subtitle: `正式 ${total} · 待确认 ${scope.inboxCount}` }, open ? branches : []));
  }
  const root = node({ id: "root", kind: "root", label: "记忆库系统", icon: "database", tone: "root",
    subtitle: `${props.scopes.filter(s => s.workspace !== null).length} 个工作区 · GLOBAL` }, scopes);
  const nodes: Node[] = [];
  const edges: { id: string; path: string; primary: boolean }[] = [];
  const columns = [0, 242, 514, 762];
  const widths = [182, 216, 190, 324];
  let bottom = 0;
  function layout(item: Node, depth: number) {
    item.x = columns[depth]!; item.width = widths[depth]!;
    if (item.children.length) {
      item.children.forEach((child, index) => {
        if (index && depth === 0) bottom += 16;
        layout(child, depth + 1);
      });
      item.y = (item.children[0]!.y + item.children[0]!.height / 2 + item.children.at(-1)!.y + item.children.at(-1)!.height / 2) / 2 - item.height / 2;
    } else { item.y = bottom; bottom += item.height + 10; }
    nodes.push(item);
    for (const child of item.children) {
      const x = item.x + item.width; const y = item.y + item.height / 2;
      const targetY = child.y + child.height / 2; const mid = (x + child.x) / 2;
      edges.push({ id: child.id, primary: depth === 0, path: `M${x},${y} C${mid},${y} ${mid},${targetY} ${child.x},${targetY}` });
    }
  }
  layout(root, 0);
  // DOM order follows the same hierarchy as the visual graph for keyboard navigation.
  const ordered: Node[] = [];
  const collect = (item: Node) => { ordered.push(item); item.children.forEach(collect); };
  collect(root);
  return { nodes: ordered, edges, width: Math.max(...nodes.map(n => n.x + n.width)), height: Math.max(bottom - 10, 66), matches: scopes.length };
});
function fit(preferReadable = false) {
  const { width, height } = graph.value;
  const widthScale = Math.min(1, (size.width - 48) / width);
  // Initial framing prioritizes readable labels; explicit Fit includes the full height.
  camera.scale = Math.max(preferReadable ? .85 : .35, Math.min(widthScale, (size.height - 48) / height));
  camera.x = Math.max(24, (size.width - width * camera.scale) / 2);
  camera.y = Math.max(24, (size.height - height * camera.scale) / 2);
}
function zoom(factor: number, x = size.width / 2, y = size.height / 2) {
  const next = Math.max(.35, Math.min(1.8, camera.scale * factor));
  camera.x = x - (x - camera.x) * next / camera.scale;
  camera.y = y - (y - camera.y) * next / camera.scale;
  camera.scale = next;
}
function activate(item: Node) {
  if (item.kind === "asset") { navigate(item.pending ? "inbox" : "library", item.assetId); return; }
  if (item.kind === "more") {
    const id = item.id.slice(0, -5); limits.set(id, (limits.get(id) ?? 8) + 8); return;
  }
  if (item.kind === "workspace" || item.kind === "category") {
    if (searching.value) return;
    // Keep the clicked node in place when its branch changes size.
    const oldY = item.y;
    expanded.set(item.id, !item.open);
    const next = graph.value.nodes.find(n => n.id === item.id);
    if (next) camera.y += (oldY - next.y) * camera.scale;
  }
}
function setAll(open: boolean) {
  for (const scope of props.scopes) {
    const id = JSON.stringify(scope.workspace);
    expanded.set(id, true);
    for (const category of categories) expanded.set(`${id}/${category.key}`, open);
  }
  void nextTick(() => fit(true));
}
let drag: { id: number; x: number; y: number } | undefined;
const dragging = ref(false);
function pointerDown(event: PointerEvent) {
  if (event.button !== 0 || (event.target as Element).closest("button")) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  dragging.value = true; viewport.value?.setPointerCapture(event.pointerId);
}
function pointerMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return;
  camera.x += event.clientX - drag.x; camera.y += event.clientY - drag.y;
  drag.x = event.clientX; drag.y = event.clientY;
}
function stopDrag() { drag = undefined; dragging.value = false; }
function wheel(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey) {
    const rect = viewport.value!.getBoundingClientRect();
    zoom(Math.exp(-event.deltaY * .008), event.clientX - rect.left, event.clientY - rect.top);
  } else { camera.x -= event.deltaX; camera.y -= event.deltaY; }
}
function keyboard(event: KeyboardEvent) {
  if (event.target !== viewport.value) return;
  const delta: Record<string, [number, number]> = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };
  if (delta[event.key]) { event.preventDefault(); camera.x += delta[event.key]![0]; camera.y += delta[event.key]![1]; }
  else if (event.key === "Home") { event.preventDefault(); fit(); }
}
function reveal(item: Node) {
  const x = camera.x + item.x * camera.scale; const y = camera.y + item.y * camera.scale;
  if (x < 8) camera.x += 8 - x;
  else if (x + item.width * camera.scale > size.width - 8) camera.x -= x + item.width * camera.scale - size.width + 8;
  if (y < 8) camera.y += 8 - y;
  else if (y + item.height * camera.scale > size.height - 8) camera.y -= y + item.height * camera.scale - size.height + 8;
}
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(([entry]) => { if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) { size.width = entry.contentRect.width; size.height = entry.contentRect.height; fit(true); } });
    if (viewport.value) observer.observe(viewport.value);
  }
  fit(true);
});
onBeforeUnmount(() => observer?.disconnect());
watch(() => props.scopes, () => nextTick(() => fit(true)));
watch(query, () => { limits.clear(); void nextTick(() => fit(true)); });
</script>

<template>
  <section class="knowledge-graph" aria-labelledby="graph-title">
    <header class="graph-header">
      <div><h2 id="graph-title">知识图谱</h2><p>按工作区浏览，点击标题查看详情</p></div>
      <div class="graph-tools">
        <label class="graph-search"><UiIcon name="search" /><input v-model="query" aria-label="搜索图谱节点" placeholder="搜索节点…" type="search" /></label>
        <button class="icon-button" aria-label="缩小图谱" title="缩小" @click="zoom(1 / 1.2)"><UiIcon name="minus" /></button>
        <button class="icon-button" aria-label="放大图谱" title="放大" @click="zoom(1.2)"><UiIcon name="plus" /></button>
        <button class="icon-button" aria-label="适应画布" title="适应画布" @click="fit()"><UiIcon name="fit" /></button>
        <button class="icon-button" aria-label="展开全部分类" title="展开全部分类" :disabled="searching" @click="setAll(true)"><UiIcon name="layers" /></button>
        <button class="icon-button" aria-label="收起全部分类" title="收起全部分类" :disabled="searching" @click="setAll(false)"><UiIcon name="minimize" /></button>
      </div>
    </header>
    <div ref="viewport" class="graph-viewport" :class="{ dragging }" tabindex="0" aria-label="知识图谱画布，可拖动画布或用方向键平移" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="stopDrag" @pointercancel="stopDrag" @lostpointercapture="stopDrag" @wheel.prevent="wheel" @keydown="keyboard">
      <div class="graph-world" :style="{ width: `${graph.width}px`, height: `${graph.height}px`, transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }">
        <svg class="graph-links" :width="graph.width" :height="graph.height" aria-hidden="true"><path v-for="edge in graph.edges" :key="edge.id" :d="edge.path" :class="{ primary: edge.primary }" /></svg>
        <component :is="item.kind === 'root' ? 'div' : 'button'" v-for="item in graph.nodes" :key="item.id" class="graph-node" :class="[item.kind, `tone-${item.tone}`, { empty: item.disabled }]" :style="{ left: `${item.x}px`, top: `${item.y}px`, width: `${item.width}px`, height: `${item.height}px` }" :disabled="item.disabled" :aria-expanded="item.open" :aria-label="item.kind === 'category' ? `${item.label} ${item.count} 条` : item.label" :title="item.label" @click="activate(item)" @focus="reveal(item)">
          <span class="node-symbol"><UiIcon :name="item.icon" /></span>
          <span class="node-copy"><span class="node-label">{{ item.label }}</span><small v-if="item.subtitle">{{ item.subtitle }}</small></span>
          <span v-if="item.count !== undefined" class="node-count">{{ item.count }}</span>
          <UiIcon v-if="item.open !== undefined && !item.disabled" name="chevron" class="node-chevron" :class="{ open: item.open }" />
          <UiIcon v-if="item.kind === 'asset'" name="chevron" class="leaf-arrow" />
        </component>
      </div>
      <p v-if="searching && !graph.matches" class="graph-no-results" role="status">没有匹配的节点，请尝试其他标题或工作区。</p>
    </div>
    <footer class="graph-footer"><span>{{ searching ? '搜索时自动展开匹配分支 · 清空搜索恢复浏览' : '拖动画布平移 · ⌘ / Ctrl + 滚轮缩放' }}</span><span>{{ Math.round(camera.scale * 100) }}%</span></footer>
  </section>
</template>

<style scoped>
.knowledge-graph { --graph-blue: #4d98ff; display: flex; flex-direction: column; flex: 1; min-height: 360px; min-width: 0; border: 1px solid var(--control-line); border-radius: 10px; background: var(--canvas); overflow: hidden; }
.graph-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 20px 12px; flex-wrap: wrap; }
.graph-header h2 { margin: 0; font-size: 18px; letter-spacing: -.4px; font-weight: 600; }
.graph-header p { margin: 5px 0 0; font-size: 12px; color: var(--muted); }
.graph-tools { display: flex; align-items: center; gap: 6px; }
.graph-tools .icon-button { width: 32px; height: 32px; border: 1px solid var(--control-line); border-radius: 6px; background: var(--surface); }
.graph-tools .ui-icon { width: 16px; height: 16px; }
.graph-search { display: flex; align-items: center; gap: 8px; width: 190px; height: 32px; padding: 0 10px; margin-right: 4px; border: 1px solid var(--control-line); border-radius: 6px; color: var(--muted); }
.graph-search input { min-width: 0; width: 100%; background: transparent; border: 0; outline: none; font-size: 12px; }
.graph-search:focus-within { outline: 2px solid var(--graph-blue); }
.graph-viewport { position: relative; flex: 1; min-height: 250px; overflow: hidden; touch-action: none; cursor: grab; background-image: radial-gradient(var(--control-line) .7px, transparent .7px); background-size: 18px 18px; }
.graph-viewport.dragging { cursor: grabbing; user-select: none; }
.graph-world { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.graph-links { position: absolute; overflow: visible; pointer-events: none; }
.graph-links path { fill: none; stroke: color-mix(in srgb, var(--muted) 65%, transparent); stroke-width: 1.2; }
.graph-links path.primary { stroke: var(--graph-blue); }
.graph-node { position: absolute; display: flex; align-items: center; gap: 10px; padding: 8px 12px; text-align: left; color: var(--ink); background: var(--surface); border: 1px solid var(--control-line); border-radius: 9px; font-size: 13px; line-height: 1.4; cursor: pointer; }
.graph-node::before { content: ''; position: absolute; width: 5px; height: 5px; border-radius: 50%; left: -4px; top: calc(50% - 2px); background: var(--muted); }
.graph-node.root::before { display: none; }
.graph-node.root { border-color: var(--graph-blue); background: color-mix(in srgb, var(--graph-blue) 10%, var(--surface)); box-shadow: 0 0 16px rgb(77 152 255 / 10%); cursor: default; }
.graph-node.workspace { border-color: color-mix(in srgb, var(--graph-blue) 30%, var(--control-line)); }
.node-symbol { color: var(--graph-blue); flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.root .node-symbol, .workspace .node-symbol { width: 32px; height: 36px; background: color-mix(in srgb, var(--graph-blue) 10%, transparent); border-radius: 8px; }
.node-symbol .ui-icon { width: 21px; height: 21px; }
.node-copy { display: flex; flex-direction: column; min-width: 0; flex: 1; gap: 3px; }
.node-label { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.root .node-label { font-size: 16px; font-weight: 600; }
.node-copy small, .node-count { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.node-count { margin-left: auto; }
.node-chevron, .leaf-arrow { width: 14px; height: 14px; color: var(--muted); flex-shrink: 0; }
.node-chevron.open { transform: rotate(90deg); }
.leaf-arrow { opacity: 0; }
.graph-node:hover:not(:disabled), .graph-node:focus-visible { border-color: var(--graph-blue); background: color-mix(in srgb, var(--graph-blue) 10%, var(--surface)); }
.graph-node:focus-visible { outline: 2px solid var(--graph-blue); outline-offset: 3px; }
.graph-node:hover .leaf-arrow, .graph-node:focus-visible .leaf-arrow { opacity: 1; }
.tone-MEMORY .node-symbol { color: var(--asset-memory); }
.tone-DOCUMENT .node-symbol { color: var(--asset-document); }
.tone-SKILL .node-symbol { color: var(--asset-skill); }
.tone-INBOX .node-symbol { color: var(--warning); }
.graph-node.empty { opacity: .55; cursor: default; }
.graph-node.more { background: var(--canvas); border-style: dashed; color: var(--muted); font-size: 12px; }
.graph-no-results { position: absolute; right: 24px; bottom: 20px; color: var(--muted); font-size: 13px; }
.graph-footer { display: flex; justify-content: space-between; gap: 10px; padding: 9px 16px; color: var(--muted); font-size: 10px; }
@media (max-width: 760px) { .graph-header { padding: 14px; gap: 12px; } .graph-tools { flex-wrap: wrap; } .graph-search { width: 150px; } }
</style>
