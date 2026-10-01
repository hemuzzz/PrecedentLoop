<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>();
</script>
<template>
  <header class="page-header">
    <div class="page-heading">
      <h1>{{ title }}</h1>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <div class="page-actions"><slot /></div>
  </header>
</template>
