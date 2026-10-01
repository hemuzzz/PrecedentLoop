<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import UiIcon from "./UiIcon.vue";
withDefaults(defineProps<{ label?: string; count?: number; icon?: string }>(), {
  label: "筛选",
  count: 0,
  icon: "filter",
});
const root = ref<HTMLDetailsElement>();
function close() {
  if (root.value) root.value.open = false;
}
defineExpose({ close });
function outside(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target))
    close();
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    root.value?.querySelector("summary")?.focus();
  }
  if (
    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  const items = Array.from(
    root.value?.querySelectorAll<HTMLButtonElement>(
      ".dropdown-panel button:not(:disabled)",
    ) ?? [],
  );
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : current < 0
          ? event.key === "ArrowDown"
            ? 0
            : items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
  if (root.value) root.value.open = true;
  items[index]?.focus();
}
onMounted(() => window.addEventListener("pointerdown", outside));
onBeforeUnmount(() => window.removeEventListener("pointerdown", outside));
</script>
<template>
  <details ref="root" class="filter-menu" @keydown="keydown">
    <summary :aria-label="label">
      <UiIcon :name="icon" /><span>{{ label }}</span
      ><span v-if="count" class="filter-count">{{ count }}</span>
    </summary>
    <div class="dropdown-panel" role="group" :aria-label="label"><slot /></div>
  </details>
</template>
