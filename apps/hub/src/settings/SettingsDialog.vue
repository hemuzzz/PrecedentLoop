<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
const props = defineProps<{ open: boolean; title: string; busy?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
watch(() => props.open, async open => { await nextTick(); if (open) dialog.value?.showModal(); else dialog.value?.close(); }, { immediate: true });
</script>
<template>
  <dialog ref="dialog" class="setup-dialog settings-dialog" :aria-label="title" @cancel.prevent="!busy && emit('close')">
    <header><h2>{{ title }}</h2></header><div class="setup-dialog-body"><slot /></div><footer><slot name="actions" /></footer>
  </dialog>
</template>
