<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { HubApiClient } from "../api/client.js";
import type { AiOperation, AiProvider, InboxItem } from "../api/types.js";
import PreviewDialog from "./PreviewDialog.vue";
import ImportKnowledgeForm from "./ImportKnowledgeForm.vue";
import FilterMenu from "./FilterMenu.vue";
import UiIcon from "./UiIcon.vue";

const props = defineProps<{ workspaces: string[]; managed: boolean; pendingRetrievalCheckCount: number; selected?: InboxItem | undefined }>();
const emit = defineEmits<{ refresh: [] }>();
const api = new HubApiClient();
const operation = ref<AiOperation | null>(null);
const writing = ref(false);
const preparing = ref(false);
const busy = computed(() => preparing.value || writing.value || operation.value?.state === "RUNNING");
const error = ref("");
const modal = ref<"import" | "rewrite" | "backfill-terms" | "retrieval-check" | "draft-revision" | "delete" | "diff" | null>(null);
const draftTarget = ref<{ assetId: string; title: string; candidateId?: string }>();
const expanded = ref(false);
const item = ref<InboxItem>();
const rewriteBefore = ref<InboxItem>();
const providers = ref<AiProvider[]>([]);
const provider = ref<"codex" | "claude">("codex");
const instructions = ref("");
const files = ref<File[]>([]);
const targets = ref<string[]>([]);
const importWorkspaces = ref<string[]>([]);
const importMenu = ref<InstanceType<typeof FilterMenu>>();
const afterMarkdown = ref("");
const rewriteRequestId = ref("");
const storageKey = "precedent-loop-inbox-operation";
type OperationKind = "import" | "rewrite" | "backfill-terms" | "retrieval-check" | "draft-revision" | "accept" | "defer" | "reject";
interface OperationContext { requestId: string; kind: OperationKind; candidateId?: string | undefined }
const context = ref<OperationContext>();
const writingContext = ref<OperationContext>();
const errorTarget = ref<{ requestId?: string; candidateId?: string | undefined }>();
const importRunning = computed(() => (writing.value && writingContext.value?.kind === "import")
  || (operation.value?.state === "RUNNING" && operation.value.operation === "import"));
function isRewriting(candidateId?: string): boolean {
  return !!candidateId && ((writing.value && ["rewrite", "draft-revision"].includes(writingContext.value?.kind ?? "") && writingContext.value?.candidateId === candidateId)
    || (context.value?.candidateId === candidateId && ["rewrite", "draft-revision"].includes(context.value.kind)
      && operation.value?.requestId === context.value.requestId && operation.value.state === "RUNNING"));
}
const feedback = computed(() => {
  const current = operation.value?.requestId === context.value?.requestId || !context.value ? operation.value : null;
  const tone = error.value || current?.state === "FAILED" ? "error" : current?.state === "SUCCEEDED" ? "success" : "info";
  const text = error.value || (current?.state === "FAILED" ? current.error?.message || "操作未完成"
    : current?.state === "SUCCEEDED" ? current.operation === "rewrite" ? "已修改，待审阅"
      : current.operation === "import" ? `已生成 ${current.result?.count ?? 0} 条候选，待审阅`
      : current.operation === "retrieval-check" ? `召回自测完成：${current.result?.done ?? 0} / ${current.result?.total ?? 0}`
      : current.operation === "backfill-terms" ? `已补齐 ${current.result?.written ?? 0} 条知识的检索词` : current.operation === "draft-revision" ? "已起草修订，待审阅" : "操作已完成"
    : current?.state === "NOT_COMMITTED" ? context.value?.kind === "retrieval-check" ? "本次操作状态已不在当前运行中；已保存的自测结果仍保留，再次执行将跳过已测版本。" : context.value?.kind === "backfill-terms"
      ? "本次补齐记录已不在当前运行中；已保存的检索词会保留，可再次执行以补齐剩余内容。" : "未发现本次提交记录，请确认后再操作。"
    : current?.state === "RUNNING" && current.operation === "backfill-terms" ? `正在补齐检索词：${current.result?.processed ?? 0} / ${current.result?.total ?? 0}`
    : current?.state === "RUNNING" && current.operation === "draft-revision" ? "正在起草修订…"
    : current?.state === "RUNNING" && current.operation === "retrieval-check" ? `正在召回自测：${current.result?.done ?? 0} / ${current.result?.total ?? 0}`
    : current?.state === "RUNNING" && !context.value ? "有 AI 操作正在进行" : "");
  const target = error.value ? errorTarget.value : context.value;
  return { text, tone, candidateId: target?.candidateId, requestId: target?.requestId ?? current?.requestId,
    canQuery: (!!error.value && !!target?.requestId) || current?.state === "FAILED" || current?.state === "NOT_COMMITTED",
    canDiff: !error.value && current?.state === "SUCCEEDED" && current.operation === "rewrite"
      && current.requestId === rewriteRequestId.value && !!rewriteBefore.value && !!afterMarkdown.value };
});
const selectedFeedback = computed(() => feedback.value.candidateId && feedback.value.candidateId === props.selected?.candidateId ? feedback.value : undefined);
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const diff = computed(() => {
  const before = rewriteBefore.value ? displayContent(rewriteBefore.value).split("\n") : [], after = afterMarkdown.value.split("\n");
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return { removed: before.slice(start, oldEnd).join("\n"), added: after.slice(start, newEnd).join("\n"), changed: start < oldEnd || start < newEnd };
});
function displayContent(value: Pick<InboxItem, "title" | "summary" | "retrievalTerms" | "bodyMarkdown">): string {
  const heading = `# ${value.title}`;
  const firstLine = /^([^\r\n]*)(?:\r\n|\r|\n|$)/u.exec(value.bodyMarkdown)!;
  const body = firstLine[1] === heading
    ? value.bodyMarkdown.slice(firstLine[0].length).replace(/^(?:\r\n|\r|\n)+/u, "") : value.bodyMarkdown;
  return `${heading}\n\n${value.summary}\n\n检索词：${JSON.stringify(value.retrievalTerms)}\n\n${body}`;
}
function remember(id: string, next?: OperationContext): void {
  if (next) context.value = next;
  else if (context.value?.requestId !== id) {
    context.value = undefined;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(`${storageKey}-context`) || "null");
      if (saved && typeof saved === "object" && "requestId" in saved && saved.requestId === id
        && "kind" in saved && typeof saved.kind === "string" && ["import", "rewrite", "backfill-terms", "retrieval-check", "draft-revision", "accept", "defer", "reject"].includes(saved.kind)) {
        context.value = { requestId: id, kind: saved.kind as OperationKind,
          ...("candidateId" in saved && typeof saved.candidateId === "string" ? { candidateId: saved.candidateId } : {}) };
      }
    } catch { /* An unavailable context must not attach progress to another candidate. */ }
  }
  try {
    localStorage.setItem(storageKey, id);
    if (context.value) localStorage.setItem(`${storageKey}-context`, JSON.stringify(context.value));
  } catch { /* current session still works */ }
}
function remembered(): string | undefined { try { return localStorage.getItem(storageKey) ?? undefined; } catch { return undefined; } }
function queryResult(): void {
  const id = feedback.value.requestId ?? operation.value?.requestId ?? remembered();
  if (operation.value?.state === "RUNNING" && id && id !== operation.value.requestId) void queryAfterFailure(id);
  else void poll(id);
}
function showDiff(): void { if (selectedFeedback.value?.canDiff) modal.value = "diff"; }
function message(value: unknown): string { return value instanceof Error ? value.message : "操作未完成"; }
async function poll(id?: string): Promise<void> {
  if (timer) clearTimeout(timer);
  try {
    const result = await api.operation(id);
    if (disposed) return;
    operation.value = result.operation;
    if (result.operation) remember(result.operation.requestId);
    error.value = "";
    if (result.operation?.state === "RUNNING") {
      if (result.operation.operation === "retrieval-check") emit("refresh");
      timer = setTimeout(() => void poll(result.operation!.requestId), 1200);
    } else if (result.operation?.state === "FAILED" && result.operation.operation === "retrieval-check") {
      emit("refresh");
    } else if (result.operation?.state === "SUCCEEDED") {
      emit("refresh");
      if (result.operation.operation === "rewrite" && result.operation.requestId === rewriteRequestId.value && rewriteBefore.value && !afterMarkdown.value) {
        const updated = (await api.getInbox()).items.find(candidate => candidate.candidateId === rewriteBefore.value?.candidateId);
        if (updated) afterMarkdown.value = displayContent(updated);
      }
    }
  } catch (failure) {
    if (!disposed) { errorTarget.value = context.value; error.value = `${message(failure)}。提交结果尚未确认，可继续查询。`; timer = setTimeout(() => void poll(id), 3000); }
  }
}
onMounted(async () => {
  // Recover the active operation even if another window started it. Fall back
  // to the locally remembered request to query a durable result after restart.
  try { const current = (await api.operation()).operation; await poll(current?.state === "RUNNING" ? current.requestId : remembered()); }
  catch (failure) { error.value = message(failure); }
});
onBeforeUnmount(() => { disposed = true; if (timer) clearTimeout(timer); });
async function open(kind: "import" | "rewrite" | "backfill-terms" | "retrieval-check" | "draft-revision", selected?: InboxItem): Promise<void> {
  if (busy.value) return;
  importMenu.value?.close();
  item.value = selected ? { ...selected } : undefined;
  errorTarget.value = { candidateId: selected?.candidateId };
  modal.value = kind; instructions.value = ""; files.value = []; targets.value = []; error.value = "";
  providers.value = []; importWorkspaces.value = [...props.workspaces]; preparing.value = true;
  try {
    providers.value = (await api.providers()).providers;
    const first = providers.value.find(value => value.isDefault) ?? providers.value.find(value => value.available); if (first) provider.value = first.id;
  } catch (failure) { providers.value = []; error.value = message(failure); }
  if (kind === "import") {
    try {
      importWorkspaces.value = (await api.candidateAction<{ workspaces: string[] }>("workspaces", {})).workspaces;
      emit("refresh");
    } catch (failure) { error.value = [error.value, message(failure)].filter(Boolean).join("；"); }
  }
  preparing.value = false;
}
function selection(selected: InboxItem, requestId: string) { return { requestId, candidateId: selected.candidateId, assetId: selected.assetId, candidateVersion: selected.version }; }
async function draftRevision(target: { assetId: string; title: string; candidateId?: string }): Promise<void> {
  if (busy.value) return;
  draftTarget.value = target;
  await open("draft-revision");
}
async function dismissIssue(issueId: string): Promise<void> {
  if (writing.value) return;
  writing.value = true; error.value = ""; errorTarget.value = {};
  try { await api.candidateAction("dismiss-issue", { issueId }); emit("refresh"); }
  catch (failure) { error.value = message(failure); }
  finally { writing.value = false; }
}
async function act(action: "accept" | "defer" | "reject", selected: InboxItem, confirmed = false): Promise<void> {
  if (writing.value) return;
  if (action === "reject" && !confirmed) { item.value = { ...selected }; modal.value = "delete"; return; }
  const requestId = crypto.randomUUID();
  writingContext.value = { requestId, kind: action, candidateId: selected.candidateId };
  errorTarget.value = writingContext.value;
  writing.value = true; error.value = "";
  if (operation.value?.state !== "RUNNING") remember(requestId, { requestId, kind: action, candidateId: selected.candidateId });
  try {
    const input = { ...selection(selected, requestId), ...(action === "defer" ? { deferred: selected.status !== "DEFERRED" } : {}),
      ...(action === "accept" && selected.baseVersion !== null ? { baseVersion: selected.baseVersion } : {}) };
    await api.candidateAction(action, input);
    modal.value = null;
    if (operation.value?.state !== "RUNNING") await poll(requestId);
    emit("refresh");
  } catch (failure) { error.value = message(failure); await queryAfterFailure(requestId); }
  finally { writing.value = false; writingContext.value = undefined; }
}
async function submit(): Promise<void> {
  if (busy.value) return;
  const kind = modal.value;
  if (kind !== "import" && kind !== "rewrite" && kind !== "backfill-terms" && kind !== "retrieval-check" && kind !== "draft-revision") return;
  const requestId = crypto.randomUUID();
  writingContext.value = { requestId, kind, ...(kind === "rewrite" ? { candidateId: item.value?.candidateId } : {}) };
  errorTarget.value = writingContext.value;
  writing.value = true; error.value = "";
  let sent = false;
  try {
    let input: object;
    if (kind === "import") {
      if (!files.value.length) throw new Error("请选择 Markdown 文件");
      const sources = await Promise.all(files.value.map(async file => {
        if (!/\.(md|markdown|mdx)$/i.test(file.name)) throw new Error("仅支持 .md、.markdown 和 .mdx 文件");
        const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
        if (!content || content.includes("\0")) throw new Error("文件必须是有效的 UTF-8 Markdown 文本");
        return { name: file.name, content };
      }));
      input = { requestId, provider: provider.value, instructions: instructions.value, sources,
        targets: targets.value.map(value => value === "GLOBAL" ? { scope: "GLOBAL" } : { scope: "WORKSPACE", workspace: value.slice(10) }) };
    } else if (kind === "draft-revision") {
      if (!draftTarget.value) throw new Error("请重新选择待修订知识");
      input = { requestId, provider: provider.value, assetId: draftTarget.value.assetId };
    } else if (kind === "retrieval-check") {
      input = { requestId, provider: provider.value, ...(item.value ? { target: { kind: "CANDIDATE", id: item.value.candidateId } } : {}) };
    } else if (kind === "backfill-terms") {
      input = { requestId, provider: provider.value };
    } else {
      if (!item.value || !instructions.value.trim()) throw new Error("请填写修改意见");
      input = { ...selection(item.value, requestId), provider: provider.value, instructions: instructions.value };
      rewriteBefore.value = { ...item.value };
      rewriteRequestId.value = requestId;
      afterMarkdown.value = "";
    }
    remember(requestId, { requestId, kind, ...(kind === "rewrite" ? { candidateId: item.value!.candidateId } : kind === "draft-revision" ? { candidateId: draftTarget.value?.candidateId } : {}) }); sent = true;
    const response = await api.candidateAction<{ operation: AiOperation }>(kind, input);
    operation.value = response.operation;
    modal.value = null;
    await poll(requestId);
  } catch (failure) { error.value = message(failure); if (sent) await queryAfterFailure(requestId); }
  finally { writing.value = false; writingContext.value = undefined; }
}
async function queryAfterFailure(requestId: string): Promise<void> {
  const originalError = error.value;
  try {
    const result = (await api.operation(requestId)).operation;
    if (operation.value?.state === "RUNNING" && operation.value.requestId !== requestId) {
      if (result?.state === "SUCCEEDED") { error.value = ""; modal.value = null; emit("refresh"); }
      else error.value = originalError;
      return;
    }
    operation.value = result;
    if (result?.state === "SUCCEEDED" || result?.state === "RUNNING") { modal.value = null; await poll(requestId); }
    else error.value = originalError;
  } catch { error.value = `${originalError}。提交结果尚未确认，请查询结果后再操作。`; }
}
defineExpose({ act, open, busy, writing, isRewriting, selectedFeedback, queryResult, showDiff, draftRevision, dismissIssue });
</script>

<template>
  <section class="candidate-manager" aria-label="候选操作">
    <div class="candidate-toolbar">
      <slot name="filters" />
      <div class="candidate-import-action">
        <button type="button" class="primary-button candidate-import-button" :aria-busy="importRunning" :disabled="busy || !managed" @click="open('import')">
          <span v-if="importRunning" class="spinner" aria-hidden="true"></span><UiIcon v-else name="file-upload" />{{ importRunning ? 'AI 整理中…' : '导入外部知识' }}
        </button>
        <FilterMenu ref="importMenu" class="candidate-import-menu" label="导入选项" icon="chevron">
          <button type="button" class="candidate-import-option" :disabled="busy || !managed" @click="open('import')">
            <UiIcon name="document" />
            <span><strong>导入 Markdown</strong><small>支持 .md、.markdown 和 .mdx 文件</small></span>
          </button>
        </FilterMenu>
      </div>
      <slot name="search" />
      <button type="button" class="secondary-button" :disabled="busy || !managed" @click="open('backfill-terms')">补齐检索词</button>
      <button type="button" class="secondary-button" :disabled="busy || !managed || !pendingRetrievalCheckCount" @click="open('retrieval-check')">召回自测（{{ pendingRetrievalCheckCount }}）</button>
    </div>
    <div v-if="!managed || (!feedback.candidateId && feedback.text)" class="candidate-operation-bar">
      <span v-if="!managed" class="muted">候选存储尚未迁移，当前仅可浏览。</span>
      <template v-else>
        <span :role="feedback.tone === 'error' ? 'alert' : 'status'" :class="{ 'field-error': feedback.tone === 'error' }">{{ feedback.text }}</span>
        <button v-if="feedback.canQuery" type="button" class="quiet-button" @click="queryResult">查询结果</button>
      </template>
    </div>
    <details v-if="operation?.state === 'SUCCEEDED' && operation.operation === 'import' && (operation.result?.sourceResults?.length || operation.result?.warnings?.length)" class="result-details">
      <summary>查看整理说明</summary>
      <p v-for="source in operation.result?.sourceResults" :key="source.name"><strong>{{ source.name }}</strong> · {{ source.explanation }}</p>
      <p v-for="warning in operation.result?.warnings" :key="warning">{{ warning }}</p>
    </details>
    <details v-if="operation?.operation === 'backfill-terms' && operation.result" class="result-details">
      <summary>补齐结果：已处理 {{ operation.result.processed }} / {{ operation.result.total }}，已写入 {{ operation.result.written }} 条</summary>
      <p v-for="result in operation.result.items" :key="result.assetId"><strong>{{ result.title }}</strong> · {{ result.skippedReason ? `跳过：${result.skippedReason}` : result.retrievalTerms?.join(' · ') }}</p>
      <p>开始下一次 AI 操作或重启后，本次结果不再保留。需要修改检索词时，请起草修订并接受候选。</p>
    </details>
    <details v-if="operation?.operation === 'retrieval-check' && operation.result" class="result-details">
      <summary>自测结果：{{ operation.result.done }} / {{ operation.result.total }}</summary>
      <section v-for="result in operation.result.items" :key="`${result.kind}:${result.id}`">
        <p><strong>{{ result.title }}</strong> · {{ result.passed ? '通过' : '未通过' }}</p>
        <p v-for="(question, index) in result.result" :key="index">{{ question.question }} · {{ question.hit ? '命中' : '未命中' }} · {{ question.rank === null ? '无匹配' : `第 ${question.rank} 名` }}<br />查询词：{{ question.queries.join(' · ') }}</p>
      </section>
    </details>
    <details v-if="operation?.state === 'SUCCEEDED' && operation.operation === 'draft-revision' && operation.result?.explanation" class="result-details">
      <summary>查看起草说明</summary><p>{{ operation.result.explanation }}</p>
    </details>
    <PreviewDialog v-if="modal" :label="modal === 'retrieval-check' ? '召回自测' : modal === 'delete' ? '拒绝候选' : modal === 'diff' ? '改稿对照' : modal === 'rewrite' ? 'AI 修改候选' : modal === 'backfill-terms' ? '补齐检索词' : modal === 'draft-revision' ? '起草修订' : '导入知识'" :expanded="modal !== 'import' && expanded" :wide="modal === 'import'" @close="modal = null" @expand="expanded = !expanded">
      <ImportKnowledgeForm v-if="modal === 'import'" v-model:files="files" v-model:targets="targets" v-model:provider="provider" v-model:instructions="instructions"
        :workspaces="importWorkspaces" :providers="providers" :busy="busy" :preparing="preparing" :error="error" @submit="submit" @close="modal = null" />
      <div v-else class="candidate-form">
        <template v-if="modal === 'delete'">
          <h2>确认拒绝候选《{{ item?.title }}》？</h2>
          <p v-if="error" role="alert" class="field-error">{{ error }}</p>
          <div class="form-actions"><button class="secondary-button" type="button" @click="modal = null">取消</button><button class="danger-button" type="button" :disabled="writing" @click="item && act('reject', item, true)">拒绝</button></div>
        </template>
        <template v-else-if="modal === 'diff'">
          <p class="eyebrow">候选 #{{ rewriteBefore?.number }}</p><h2>改稿已保存</h2>
          <p>以下展示本次发生变化的正文区段；正式知识尚未更新。</p>
          <p v-if="!diff.changed">内容未变化。</p>
          <div v-else class="revision-columns"><section><h3>修改前</h3><pre class="removed">{{ diff.removed || '（空）' }}</pre></section><section><h3>修改后</h3><pre class="added">{{ diff.added || '（空）' }}</pre></section></div>
          <button type="button" class="secondary-button" @click="modal = null">继续审阅</button>
        </template>
        <form v-else @submit.prevent="submit">
          <p v-if="modal === 'rewrite'" class="eyebrow">候选 #{{ item?.number }}</p>
          <h2>{{ modal === 'retrieval-check' ? '召回自测' : modal === 'backfill-terms' ? '补齐检索词' : modal === 'draft-revision' ? '起草修订' : 'AI 修改候选' }}</h2>
          <p v-if="modal === 'retrieval-check'">{{ item ? '重新自测此候选的当前版本。' : `自测 ${pendingRetrievalCheckCount} 个尚未测试的当前版本，并核对工作区知识的文件引用。` }}每个目标生成 3 个问法，全部进入前 8 名才通过。已完成批次会保留。</p>
          <p v-if="modal === 'draft-revision'">{{ draftTarget?.title }}：依据原文与全部待处理问题起草修订；已有候选时修改该候选。AI 读不到源码，生成后仍需你审阅并接受。</p>
          <p v-if="modal === 'backfill-terms'">为全部检索词为空的知识生成并直接保存检索词，不改变正文和版本。已写入批次会保留，中断后可再次执行。</p>
          <p class="muted">{{ modal === 'retrieval-check' ? '使用云端模型时，自测目标的标题、摘要、正文节选与检索词会提交给相应模型处理。' : modal === 'backfill-terms' ? '使用云端模型时，检索词为空的知识标题、摘要和正文节选会提交给相应模型处理。' : '使用云端模型时，本次资料与选定范围内的比对知识会提交给相应模型处理。' }}</p>
          <p>{{ item?.title }}</p>
          <label class="form-field">AI 提供方<select v-model="provider" :disabled="writing"><option v-for="value in providers" :key="value.id" :value="value.id" :disabled="!value.available">{{ value.id === 'codex' ? 'Codex CLI' : 'Claude Code CLI' }}{{ value.available ? '' : ' · 不可用' }}</option></select></label>
          <p v-for="value in providers.filter(value => !value.available)" :key="value.id" class="muted">{{ value.id }}：{{ value.reason }}</p>
          <label v-if="modal === 'rewrite'" class="form-field">修改意见<textarea v-model="instructions" rows="5" maxlength="8000" required :disabled="writing" placeholder="说明需要补充、修正或精简的内容…"></textarea></label>
          <p v-if="error" role="alert" class="field-error">{{ error }}</p>
          <div class="form-actions"><button type="button" class="secondary-button" @click="modal = null">关闭</button><button class="primary-button" type="submit" :disabled="busy || (modal === 'rewrite' && !instructions.trim()) || !providers.some(value => value.id === provider && value.available)">{{ writing ? '正在提交…' : modal === 'retrieval-check' ? '开始自测' : modal === 'backfill-terms' ? '开始补齐' : modal === 'draft-revision' ? '开始起草' : '开始改稿' }}</button></div>
        </form>
      </div>
    </PreviewDialog>
  </section>
</template>

<style scoped>
.candidate-manager { flex-shrink: 0; min-width: 0; padding: 0 4px; }
.candidate-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 14px 20px; }
.candidate-operation-bar, .form-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.candidate-operation-bar { color: var(--muted); font-size: 12px; line-height: 20px; margin-top: 10px; }
.candidate-operation-bar:empty { display: none; }
.candidate-import-action { position: relative; display: inline-flex; align-items: stretch; flex-shrink: 0; border-radius: 6px; background: var(--accent); color: #fff; }
.candidate-import-button { height: 38px; gap: 8px; padding-inline: 14px; border-radius: 6px 0 0 6px; background: transparent; font-size: 13px; }
.candidate-import-button:hover:not(:disabled) { background: rgb(255 255 255 / 10%); }
.candidate-import-button .ui-icon { width: 15px; height: 15px; }
.candidate-import-menu { position: static; border-left: 1px solid rgb(255 255 255 / 16%); }
.candidate-import-menu :deep(summary) { width: 36px; height: 38px; justify-content: center; padding: 0; border-radius: 0 6px 6px 0; color: #fff; }
.candidate-import-menu :deep(summary:hover), .candidate-import-menu[open] :deep(summary) { background: rgb(255 255 255 / 10%); }
.candidate-import-menu :deep(summary > span) { display: none; }
.candidate-import-menu :deep(summary .ui-icon) { width: 12px; height: 12px; transform: rotate(90deg); }
.candidate-import-menu :deep(.dropdown-panel) { left: 0; right: auto; width: 280px; max-width: calc(100vw - 96px); margin-top: 4px; padding: 5px; }
.candidate-import-option { display: flex; align-items: flex-start; width: 100%; gap: 10px; padding: 10px; border-radius: 5px; text-align: left; }
.candidate-import-option:hover:not(:disabled) { background: var(--hover); }
.candidate-import-option > .ui-icon { margin-top: 2px; color: var(--muted); }
.candidate-import-option strong { display: block; color: var(--ink); font-size: 13px; font-weight: 500; }
.candidate-import-option small { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; }
.candidate-manager > .field-error { margin-top: 10px; font-size: 12px; }
.muted { opacity: .7; line-height: 1.6; }
.candidate-form { padding: 48px 32px 32px; max-width: 960px; margin: auto; }
.candidate-form h2 { margin: 8px 0 16px; font-size: 24px; }
.form-field { display: flex; flex-direction: column; gap: 8px; margin: 22px 0; font-size: 14px; }
.form-field textarea, .form-field select { font: inherit; color: inherit; background: transparent; padding: 10px 12px; border: 1px solid #8885; border-radius: 8px; }
.form-field textarea { resize: vertical; }
.form-actions { justify-content: flex-end; margin-top: 24px; }
.danger-button { color: #b63737; border: 1px solid #b6373766; background: transparent; border-radius: 8px; padding: 9px 16px; cursor: pointer; }
.danger-button:disabled { opacity: .5; cursor: default; }
.result-details { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); font-size: 12px; line-height: 1.7; }
.result-details p { margin-top: 8px; overflow-wrap: anywhere; }
.result-details[open] { max-height: 180px; overflow-y: auto; }
.revision-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.revision-columns section { min-width: 0; }
.revision-columns pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 16px; font-size: 13px; line-height: 1.6; border-radius: 8px; }
.removed { background: #d44b4b12; border: 1px solid #d44b4b44; }
.added { background: #27834a12; border: 1px solid #27834a44; }
.running { display: flex; align-items: center; gap: 8px; }
.spinner { width: 13px; height: 13px; border: 2px solid #8885; border-top-color: currentColor; border-radius: 50%; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
@media (max-width: 680px) { .revision-columns { grid-template-columns: 1fr; } .candidate-form { padding: 48px 18px 24px; } }
@media (max-width: 700px) { .candidate-manager { padding-inline: 0; } }
</style>
