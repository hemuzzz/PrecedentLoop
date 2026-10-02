<script setup lang="ts">
import type { AssetIssue } from "../api/types.js";
defineProps<{ issues: AssetIssue[]; disabled?: boolean; dismissible?: boolean }>();
defineEmits<{ dismiss: [issueId: string] }>();
const kinds: Record<AssetIssue["kind"], string> = { OUTDATED: "过时", INACCURATE: "有误", INCOMPLETE: "不完整", MISLEADING: "标题摘要误导", MISSED: "换说法才召回到", UNREACHABLE: "自测未命中", BROKEN_REFERENCE: "引用文件不存在" };
const sources: Record<AssetIssue["source"], string> = { CODEX: "Codex", CLAUDE: "Claude", RETRIEVAL_CHECK: "召回自测", REFERENCE_CHECK: "引用核对" };
</script>
<template>
  <ul class="issue-list">
    <li v-for="issue in issues" :key="issue.issueId">
      <div class="issue-heading"><strong>{{ kinds[issue.kind] }}</strong><span>{{ sources[issue.source] }} · 报告时版本 {{ issue.assetVersion }} · {{ issue.status === 'DRAFTED' ? '已起草修订' : '待处理' }}</span></div>
      <p :aria-label="issue.kind === 'BROKEN_REFERENCE' ? '失效路径' : issue.kind === 'UNREACHABLE' ? '未命中问法' : '问题说明'">{{ issue.detail }}</p>
      <p v-if="issue.evidence" class="issue-evidence">依据：{{ issue.evidence }}</p>
      <p v-if="issue.queries?.length" class="issue-evidence">未命中查询词：{{ issue.queries.join(' · ') }}</p>
      <button v-if="dismissible" type="button" class="quiet-button" :disabled="disabled" @click.stop="$emit('dismiss', issue.issueId)">驳回问题</button>
    </li>
  </ul>
</template>
<style scoped>
.issue-list { list-style: none; padding: 0; margin: 12px 0; }
.issue-list li { padding: 12px 0; border-top: 1px solid var(--control-line); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.issue-heading { display: flex; flex-wrap: wrap; gap: 8px 12px; }
.issue-heading span, .issue-evidence { color: var(--muted); font-size: 12px; }
.issue-list p { margin: 6px 0; white-space: pre-wrap; }
</style>
