<script setup lang="ts">
import { computed, ref } from "vue";
import type { AiProvider } from "../api/types.js";
import UiIcon from "./UiIcon.vue";
import { agentNames } from "../setup/integration-presentation.js";

const props = defineProps<{ workspaces: string[]; providers: AiProvider[]; busy: boolean; preparing: boolean; error: string }>();
const emit = defineEmits<{ submit: []; close: [] }>();
const files = defineModel<File[]>("files", { required: true });
const targets = defineModel<string[]>("targets", { required: true });
const provider = defineModel<"codex" | "claude">("provider", { required: true });
const instructions = defineModel<string>("instructions", { required: true });
const picker = ref<HTMLInputElement>();
const dragDepth = ref(0);
const totalSize = computed(() => files.value.reduce((size, file) => size + file.size, 0));
const selectionError = computed(() => {
  if (files.value.some(file => !/\.(md|markdown|mdx)$/i.test(file.name))) return "仅支持 .md、.markdown 和 .mdx 文件，请移除其他格式。";
  if (files.value.some(file => file.size === 0)) return "存在空文件，请移除后再整理。";
  return "";
});
const canSubmit = computed(() => !props.busy && files.value.length > 0 && !selectionError.value
  && props.providers.some(value => value.id === provider.value && value.available));
function sizeLabel(bytes: number): string {
  return bytes < 1000 ? `${bytes} B` : bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} KB` : `${(bytes / 1_000_000).toFixed(2)} MB`;
}
function addFiles(incoming: File[]): void {
  if (props.busy) return;
  const next = [...files.value];
  for (const file of incoming) {
    if (!next.some(value => value.name === file.name && value.size === file.size && value.lastModified === file.lastModified)) next.push(file);
  }
  files.value = next;
}
function chooseFiles(event: Event): void {
  const input = event.target as HTMLInputElement;
  addFiles([...(input.files ?? [])]);
  input.value = "";
}
function dropFiles(event: DragEvent): void {
  dragDepth.value = 0;
  addFiles([...(event.dataTransfer?.files ?? [])]);
}
</script>

<template>
  <form class="knowledge-import" @submit.prevent="canSubmit && emit('submit')">
    <div class="import-scroll">
      <header class="import-heading">
        <span class="import-emblem"><UiIcon name="file-upload" /></span>
        <div>
          <h2>导入知识</h2>
          <p>添加 Markdown 文档，由 AI 整理为待审阅候选。</p>
          <p class="heading-note">AI 会按内容整理成候选：一个文件可能整理出多条，也可能没有值得保留的内容。</p>
        </div>
      </header>

      <div class="import-columns">
        <section class="import-card file-card" aria-labelledby="import-files-title">
          <h3 id="import-files-title"><UiIcon name="document" />Markdown 文件</h3>
          <p class="card-description">支持拖放与点击选择，文件须为 UTF-8 Markdown。</p>
          <input ref="picker" type="file" class="file-picker" accept=".md,.markdown,.mdx,text/markdown" multiple :disabled="busy" aria-label="选择 Markdown 文件" @change="chooseFiles" />
          <div class="file-drop" :class="{ 'is-dragging': dragDepth > 0, 'is-disabled': busy }"
            @dragenter.prevent="!busy && dragDepth++" @dragover.prevent @dragleave.prevent="dragDepth = Math.max(0, dragDepth - 1)" @drop.prevent="dropFiles">
            <UiIcon name="upload" />
            <strong>{{ dragDepth > 0 ? '松开即可添加文件' : '拖放 Markdown 文件到这里' }}</strong>
            <span>支持 .md / .markdown / .mdx</span>
            <button type="button" class="import-primary" :disabled="busy" @click="picker?.click()">选择文件</button>
          </div>

          <div class="file-selection">
            <div class="selection-heading">
              <span aria-live="polite">已选择 {{ files.length }} 个文件 <span class="file-total">（{{ sizeLabel(totalSize) }}）</span></span>
              <div v-if="files.length" class="selection-actions">
                <button type="button" class="text-action" :disabled="busy" @click="picker?.click()">继续添加</button>
                <button type="button" class="clear-action" :disabled="busy" @click="files = []">清空</button>
              </div>
            </div>
            <ul v-if="files.length" class="selected-files" aria-label="已选文件">
              <li v-for="(file, index) in files" :key="`${file.name}:${file.lastModified}:${index}`">
                <span class="file-emblem"><UiIcon name="document" /></span>
                <div class="file-description"><span class="file-name" :title="file.name">{{ file.name }}</span><small>{{ sizeLabel(file.size) }}</small></div>
                <button type="button" class="remove-file" :disabled="busy" :aria-label="`移除 ${file.name}`" @click="files = files.filter((_, position) => position !== index)"><UiIcon name="close" /></button>
              </li>
            </ul>
            <p v-else class="file-empty">还没有添加文件</p>
          </div>
          <p v-if="selectionError" class="import-error" role="alert">{{ selectionError }}</p>
          <p class="file-help"><UiIcon name="info" />添加后可继续补充或移除文件。</p>
        </section>

        <div class="import-options">
          <section class="import-card" aria-labelledby="import-scope-title">
            <h3 id="import-scope-title"><UiIcon name="layers" />知识范围 <span class="optional">（可选）</span></h3>
            <p class="card-description">不选则由 AI 自动分类；选择后仅归入指定范围。</p>
            <div class="scope-options" role="group" aria-labelledby="import-scope-title">
              <label class="scope-choice" :class="{ selected: targets.includes('GLOBAL') }"><input v-model="targets" type="checkbox" value="GLOBAL" :disabled="busy" />全局</label>
              <label v-for="workspace in workspaces" :key="workspace" class="scope-choice" :class="{ selected: targets.includes(`WORKSPACE:${workspace}`) }"><input v-model="targets" type="checkbox" :value="`WORKSPACE:${workspace}`" :disabled="busy" />{{ workspace }}</label>
            </div>
            <p v-if="!targets.length" class="auto-scope" role="status"><UiIcon name="sparkles" />自动分类</p>
            <p v-if="!workspaces.length" class="workspace-discovery">{{ preparing ? '正在读取 Codex 保存的本地项目…' : '首次使用时，将从 Codex 保存的本地项目建立工作区。' }}</p>
          </section>

          <section class="import-card" aria-labelledby="import-provider-title">
            <h3 id="import-provider-title"><UiIcon name="sparkles" />AI 提供方</h3>
            <p class="card-description">选择本次整理使用的 AI。</p>
            <div class="provider-options" role="radiogroup" aria-labelledby="import-provider-title">
              <div v-for="value in providers" :key="value.id" class="provider-option" :class="{ selected: provider === value.id && value.available, unavailable: !value.available }">
                <label class="provider-choice">
                  <input v-model="provider" type="radio" name="import-provider" :value="value.id" :disabled="busy || !value.available" />
                  <span class="provider-copy"><strong>{{ agentNames[value.id] }}</strong><small>{{ value.available ? '已安装，可发起整理。' : '暂不可用，请检查本机配置。' }}</small></span>
                  <span class="provider-status" :class="{ available: value.available }">{{ value.available ? '可用' : '不可用' }}</span>
                </label>
                <details v-if="!value.available && value.reason" class="provider-reason"><summary>查看原因</summary><p>{{ value.reason }}</p></details>
              </div>
              <p v-if="!providers.length" class="provider-empty">尚未获取到可用的 AI 提供方。</p>
            </div>
          </section>

          <section class="import-card instructions-card" aria-labelledby="import-instructions-title">
            <h3 id="import-instructions-title"><UiIcon name="document" /><label for="import-instructions">整理要求 <span class="optional">（可选）</span></label></h3>
            <p class="card-description">给 AI 一个方向，帮助它决定重点保留哪些知识。</p>
            <textarea id="import-instructions" v-model="instructions" rows="3" maxlength="8000" :disabled="busy" placeholder="希望重点保留什么？也可以说明需要忽略的内容。"></textarea>
            <p class="instructions-example">例如：保留稳定的流程与约定，忽略临时讨论和重复示例。</p>
          </section>
        </div>
      </div>
      <p v-if="error" class="import-error submission-error" role="alert">{{ error }}</p>
    </div>

    <footer class="import-footer">
      <p class="import-notice"><UiIcon name="info" /><span>使用云端模型时，文件及{{ targets.length ? '所选范围' : '全局和已知工作区' }}内的比对知识会发送给模型。整理后需人工审阅和接受。</span></p>
      <div class="import-actions"><button type="button" class="import-secondary" @click="emit('close')">关闭</button><button type="submit" class="import-primary" :disabled="!canSubmit">{{ preparing ? '正在读取…' : busy ? '正在提交…' : '开始整理' }}</button></div>
    </footer>
  </form>
</template>

<style scoped>
.knowledge-import { --import-accent: #6666ff; --import-tint: color-mix(in srgb, var(--import-accent) 11%, transparent); display: flex; flex-direction: column; max-height: calc(100dvh - 48px); font-size: 13px; background: linear-gradient(140deg, color-mix(in srgb, var(--surface) 95%, #8190be), var(--surface) 65%); }
.import-scroll { min-height: 0; overflow-y: auto; padding: 30px 24px 22px; }
.import-heading { display: flex; align-items: center; gap: 26px; padding: 0 24px 26px; }
.import-emblem { display: grid; place-items: center; flex: 0 0 84px; height: 84px; border-radius: 22px; background: var(--import-tint); color: #9194c5; }
.import-emblem .ui-icon { width: 45px; height: 45px; stroke-width: 1.7; }
.import-heading h2 { font-size: 28px; line-height: 1.3; letter-spacing: -.5px; margin: 0 0 7px; font-weight: 650; }
.import-heading p { margin: 3px 0; font-size: 14px; color: var(--muted); }
.import-heading .heading-note { font-size: 12px; }
.import-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.import-card { min-width: 0; padding: 18px; border: 1px solid var(--control-line); border-radius: 13px; background: color-mix(in srgb, var(--hover) 45%, transparent); }
.import-card h3 { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600; margin: 0; }
.import-card h3 > .ui-icon { width: 22px; height: 22px; flex-shrink: 0; color: color-mix(in srgb, var(--ink) 80%, #8d9cc5); }
.card-description { margin: 8px 0 14px 32px; color: var(--muted); font-size: 12px; line-height: 1.75; }
.optional { font-size: 13px; font-weight: 400; color: var(--muted); }
.file-picker { display: none; }
.file-drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; min-height: 196px; padding: 24px 16px 20px; border: 1px dashed var(--import-accent); border-radius: 12px; background: color-mix(in srgb, var(--import-tint) 25%, transparent); text-align: center; }
.file-drop.is-dragging { background: var(--import-tint); box-shadow: inset 0 0 0 1px var(--import-accent); }
.file-drop.is-disabled { opacity: .6; }
.file-drop > .ui-icon { width: 44px; height: 44px; margin-bottom: 8px; color: #9498ca; stroke-width: 1.6; }
.file-drop strong { font-size: 14px; font-weight: 550; }
.file-drop > span { color: var(--muted); font-size: 12px; }
.file-drop .import-primary { margin-top: 8px; min-height: 36px; }
.file-selection { margin-top: 16px; border: 1px solid var(--control-line); border-radius: 12px; overflow: hidden; }
.selection-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 12px; flex-wrap: wrap; }
.file-total { color: var(--muted); font-variant-numeric: tabular-nums; }
.selection-actions { display: flex; gap: 10px; align-items: center; }
.text-action { padding: 3px 0; color: #8f92ff; font-size: 12px; }
.clear-action { padding: 3px 9px; border: 1px solid var(--control-line); border-radius: 6px; color: var(--muted); font-size: 12px; }
.selected-files { list-style: none; margin: 0; padding: 7px; display: flex; flex-direction: column; gap: 6px; max-height: 232px; overflow-y: auto; }
.selected-files li { display: flex; align-items: center; gap: 12px; padding: 7px 9px; min-width: 0; border: 1px solid var(--line); border-radius: 9px; background: var(--row-hover); }
.file-emblem { width: 38px; height: 42px; display: grid; place-items: center; flex-shrink: 0; border-radius: 10px; background: var(--import-tint); color: #b1b5d0; }
.file-emblem .ui-icon { width: 22px; height: 22px; }
.file-description { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-description small { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.remove-file { display: grid; place-items: center; margin-left: auto; width: 28px; height: 28px; flex-shrink: 0; border-radius: 6px; color: var(--muted); }
.remove-file .ui-icon { width: 16px; height: 16px; }
.remove-file:hover, .clear-action:hover { background: var(--hover); color: var(--ink); }
.file-empty { margin: 0; padding: 30px 12px; text-align: center; color: var(--muted); font-size: 12px; }
.file-help { display: flex; align-items: center; gap: 6px; margin: 14px 0 0; color: var(--muted); font-size: 11px; flex-wrap: wrap; }
.file-help .ui-icon { width: 14px; height: 14px; }
.import-options { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.scope-options { display: flex; flex-wrap: wrap; gap: 8px; }
.scope-choice { display: flex; align-items: center; gap: 9px; padding: 11px 12px; border: 1px solid var(--control-line); border-radius: 8px; cursor: pointer; overflow-wrap: anywhere; }
.scope-choice input { width: 17px; height: 17px; margin: 0; flex-shrink: 0; accent-color: var(--import-accent); }
.scope-choice.selected, .provider-option.selected { border-color: var(--import-accent); background: var(--import-tint); }
.auto-scope { display: flex; align-items: center; gap: 6px; color: #9c9fff; font-size: 12px; margin: 10px 0 0; }
.auto-scope .ui-icon { width: 14px; height: 14px; }
.workspace-discovery { margin: 8px 0 0; font-size: 11px; line-height: 1.7; color: var(--muted); }
.provider-options { display: flex; flex-direction: column; gap: 8px; }
.provider-option { border: 1px solid var(--control-line); border-radius: 10px; }
.provider-choice { display: flex; align-items: center; gap: 12px; padding: 11px 14px; cursor: pointer; }
.provider-choice input { accent-color: var(--import-accent); width: 18px; height: 18px; margin: 0; flex-shrink: 0; }
.provider-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.provider-copy strong { font-size: 14px; font-weight: 550; }
.provider-copy small { font-size: 11px; color: var(--muted); }
.provider-status { margin-left: auto; padding: 4px 9px; border-radius: 20px; font-size: 11px; color: var(--muted); background: var(--selected); white-space: nowrap; }
.provider-status.available { color: var(--success); background: color-mix(in srgb, var(--success) 15%, transparent); }
.unavailable .provider-choice { cursor: default; }
.provider-reason { margin: -3px 14px 10px 44px; font-size: 11px; color: var(--muted); }
.provider-reason p { overflow-wrap: anywhere; line-height: 1.6; margin-bottom: 0; }
.provider-empty { margin: 0; font-size: 12px; color: var(--muted); }
.instructions-card { flex: 1; }
.instructions-card textarea { display: block; width: 100%; min-height: 84px; max-height: 240px; resize: vertical; padding: 12px; border: 1px solid var(--control-line); border-radius: 10px; background: var(--row-hover); font-size: 12px; line-height: 1.7; }
.instructions-card textarea::placeholder { color: var(--muted); }
.instructions-example { font-size: 11px; line-height: 1.7; color: var(--muted); margin: 8px 0 0; }
.import-footer { display: flex; align-items: center; gap: 24px; justify-content: space-between; flex-shrink: 0; border-top: 1px solid var(--control-line); padding: 17px 24px; background: color-mix(in srgb, var(--canvas) 30%, transparent); }
.import-notice { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 11px; line-height: 1.8; margin: 0; }
.import-notice .ui-icon { width: 25px; height: 25px; flex-shrink: 0; color: #9498ba; }
.import-actions { display: flex; gap: 12px; flex-shrink: 0; }
.import-primary, .import-secondary { min-height: 42px; min-width: 98px; padding: 8px 22px; border-radius: 10px; font-size: 13px; font-weight: 550; border: 1px solid var(--control-line); }
.import-primary { background: linear-gradient(135deg, #6068ff, #5852ec); color: #fff; border-color: #7677ff; box-shadow: inset 0 1px 0 rgb(255 255 255 / 12%); }
.import-primary:hover:not(:disabled) { filter: brightness(1.1); }
.import-secondary { background: var(--hover); }
.import-error { color: #ec9292; font-size: 12px; line-height: 1.7; }
.submission-error { margin: 16px 0 0; }
@media (max-width: 820px) {
  .import-columns { grid-template-columns: 1fr; }
  .import-heading { padding-left: 0; gap: 18px; }
  .import-emblem { flex-basis: 64px; height: 64px; border-radius: 18px; }
  .import-emblem .ui-icon { width: 36px; height: 36px; }
  .import-heading h2 { font-size: 24px; }
  .file-drop { min-height: 165px; }
  .import-footer { gap: 16px; }
}
@media (max-width: 680px) {
  .knowledge-import { max-height: calc(100dvh - 24px); }
  .import-scroll { padding: 28px 16px 16px; }
  .import-heading { align-items: flex-start; padding-right: 16px; }
  .import-heading .heading-note { font-size: 11px; }
  .import-emblem { flex-basis: 44px; height: 48px; border-radius: 12px; }
  .import-emblem .ui-icon { width: 28px; height: 28px; }
  .import-heading p { font-size: 12px; }
  .import-card { padding: 14px; }
  .import-footer { padding: 14px 16px; flex-wrap: wrap; gap: 12px; }
  .import-actions { margin-left: auto; }
  .import-notice { font-size: 10px; }
}
</style>
