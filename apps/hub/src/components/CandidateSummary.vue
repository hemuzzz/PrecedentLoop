<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import MarkdownIt from "markdown-it";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";
import type { InboxItem } from "../api/types.js";
import UiIcon from "./UiIcon.vue";
import { markdownPresentation } from "../markdown-presentation.js";

const props = defineProps<{ item: InboxItem }>();

const body = computed(() => props.item.bodyMarkdown);
const renderer = new MarkdownIt({ html: false, linkify: false, typographer: false }).use(markdownItCjkFriendly);
renderer.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index]!;
  const language = renderer.utils.escapeHtml(token.info.trim().split(/\s+/u)[0] || "代码");
  const lines = token.content.replace(/\n$/u, "").split("\n")
    .map(line => `<span class="candidate-code-line">${renderer.utils.escapeHtml(line)}</span>`).join("\n");
  return `<div class="candidate-code"><div class="candidate-code-heading"><span>${language}</span><button type="button" data-copy-code aria-label="复制代码">复制</button></div><pre><code>${lines}${token.content.endsWith("\n") ? "\n" : ""}</code></pre></div>`;
};
const rendered = computed(() => markdownPresentation(renderer.render(body.value)));
const copyMessage = ref("");
let copyTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => props.item.bodyMarkdown, () => { copyMessage.value = ""; });
onBeforeUnmount(() => { if (copyTimer) clearTimeout(copyTimer); });
async function copyCode(event: MouseEvent): Promise<void> {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-copy-code]") : null;
  const code = target?.closest(".candidate-code")?.querySelector("code");
  if (!target || !code) return;
  try { await navigator.clipboard.writeText(code.textContent ?? ""); copyMessage.value = "代码已复制"; }
  catch { copyMessage.value = "复制失败，请选中代码手动复制"; }
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copyMessage.value = ""; }, 3000);
}
</script>

<template>
  <div class="candidate-summary">
    <section class="summary-section">
      <h3><UiIcon name="document" />摘要</h3>
      <p>{{ item.summary || '这份候选尚未填写摘要，可查看下方正文。' }}</p>
    </section>
    <section class="summary-section">
      <h3>检索词</h3>
      <p>{{ item.retrievalTerms.join(' · ') || '尚未填写' }}</p>
    </section>
    <section class="summary-section">
      <h3><UiIcon name="document" />正文预览</h3>
      <div v-if="body" :key="item.assetId" class="markdown-body candidate-body-preview" aria-label="候选正文预览" @click="copyCode" v-html="rendered"></div>
      <p v-else>这份候选暂无正文。</p>
      <p v-if="copyMessage" class="copy-feedback" role="status">{{ copyMessage }}</p>
    </section>
  </div>
</template>

<style scoped>
.summary-section { padding: 14px 0; border-bottom: 1px solid var(--control-line); }
.summary-section:last-child { padding-bottom: 0; }
.summary-section > h3 { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 14px; font-weight: 600; }
.summary-section h3 .ui-icon { width: 19px; height: 19px; color: var(--accent); }
.summary-section > p { color: var(--muted); font-size: 13px; line-height: 1.75; overflow-wrap: anywhere; }
.candidate-body-preview { min-width: 0; font-size: 14px; line-height: 1.75; color: var(--ink); }
.candidate-body-preview :deep(> :first-child) { margin-top: 0; }
.candidate-body-preview :deep(h1) { font-size: 22px; line-height: 1.4; margin: 18px 0 10px; }
.candidate-body-preview :deep(h2) { font-size: 18px; line-height: 1.5; margin: 18px 0 8px; }
.candidate-body-preview :deep(h3) { font-size: 15px; font-weight: 600; margin: 16px 0 6px; }
.candidate-body-preview :deep(p), .candidate-body-preview :deep(ul), .candidate-body-preview :deep(ol) { margin: 8px 0 12px; }
.candidate-body-preview :deep(ul), .candidate-body-preview :deep(ol) { padding-left: 24px; }
.candidate-body-preview :deep(li::marker) { color: var(--accent); }
.candidate-body-preview :deep(blockquote) { margin: 12px 0; padding: 8px 14px; border-left: 4px solid var(--accent); border-radius: 0 6px 6px 0; background: var(--hover); color: var(--ink); }
.candidate-body-preview :deep(blockquote p) { margin: 2px 0; }
.candidate-body-preview :deep(table) { max-width: 100%; margin-block: 12px; border-collapse: collapse; }
.candidate-body-preview :deep(th), .candidate-body-preview :deep(td) { padding: 8px 12px; border: 1px solid var(--control-line); text-align: left; }
.candidate-body-preview :deep(th) { background: var(--hover); font-weight: 600; }
.candidate-body-preview :deep(a) { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.candidate-body-preview :deep(.candidate-code) { overflow: hidden; margin: 12px 0; border: 1px solid var(--control-line); border-radius: 7px; }
.candidate-body-preview :deep(.candidate-code-heading) { display: flex; align-items: center; justify-content: space-between; padding: 5px 12px; background: var(--hover); color: var(--muted); font-size: 11px; }
.candidate-body-preview :deep(.candidate-code-heading button) { padding: 2px 5px; font-size: 11px; }
.candidate-body-preview :deep(.candidate-code pre) { border: 0; border-radius: 0; margin: 0; padding: 12px 14px; white-space: pre; overflow-wrap: normal; overflow-x: auto; font-size: 12px; line-height: 1.7; }
.candidate-body-preview :deep(.candidate-code code) { counter-reset: candidate-line; }
.candidate-body-preview :deep(.candidate-code-line::before) { content: counter(candidate-line); counter-increment: candidate-line; display: inline-block; min-width: 2ch; margin-right: 18px; text-align: right; color: var(--muted); user-select: none; }
.copy-feedback { color: var(--accent); }
</style>
