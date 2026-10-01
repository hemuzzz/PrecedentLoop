<script setup lang="ts" generic="T extends string | number">
defineProps<{
  label: string;
  modelValue: T;
  options: readonly { value: T; label: string }[];
}>();
defineEmits<{ "update:modelValue": [value: T] }>();
</script>
<template>
  <div class="filter-options" role="group" :aria-label="label">
    <span class="menu-label">{{ label }}</span>
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      :aria-pressed="modelValue === option.value"
      @click="$emit('update:modelValue', option.value)"
    >
      <span>{{ option.label }}</span
      ><span class="option-check" aria-hidden="true">{{
        modelValue === option.value ? "✓" : ""
      }}</span>
    </button>
  </div>
</template>
