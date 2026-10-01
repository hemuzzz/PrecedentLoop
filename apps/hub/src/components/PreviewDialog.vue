<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import UiIcon from "./UiIcon.vue";
defineProps<{ label: string; expanded?: boolean; wide?: boolean }>();
const emit = defineEmits<{ close: []; expand: [] }>();
const dialog = ref<HTMLDialogElement>();
let origin: HTMLElement | null = null;
onMounted(async () => {
  origin =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  await nextTick();
  dialog.value?.showModal();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  if (origin?.isConnected) origin.focus();
});
function backdrop(event: MouseEvent) {
  if (event.target !== dialog.value || !dialog.value) return;
  const r = dialog.value.getBoundingClientRect();
  if (
    event.clientX < r.left ||
    event.clientX > r.right ||
    event.clientY < r.top ||
    event.clientY > r.bottom
  )
    emit("close");
}
</script>
<template>
  <dialog
    ref="dialog"
    class="preview-dialog"
    :class="{ 'full-detail': expanded, 'wide-dialog': wide }"
    :aria-label="label"
    @cancel.prevent="emit('close')"
    @click="backdrop"
  >
    <div class="preview-actions">
      <button
        v-if="!wide"
        type="button"
        class="icon-button"
        :aria-label="expanded ? '收起阅读视图' : '展开阅读'"
        @click="emit('expand')"
      >
        <UiIcon :name="expanded ? 'minimize' : 'expand'" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="关闭"
        autofocus
        @click="emit('close')"
      >
        <UiIcon name="close" />
      </button>
    </div>
    <slot />
  </dialog>
</template>

<style scoped>
.preview-dialog.wide-dialog {
  width: 1080px;
  max-width: calc(100vw - 40px);
  max-height: calc(100dvh - 48px);
  overflow: hidden;
  border-radius: 18px;
}
.wide-dialog .preview-actions {
  position: absolute;
  top: 12px;
  right: 12px;
  padding: 0;
  background: transparent;
}
.wide-dialog::backdrop { background: rgb(4 7 15 / 58%); backdrop-filter: blur(5px); }
@media (max-width: 680px) {
  .preview-dialog.wide-dialog { max-width: calc(100vw - 20px); max-height: calc(100dvh - 24px); border-radius: 14px; }
}
</style>
