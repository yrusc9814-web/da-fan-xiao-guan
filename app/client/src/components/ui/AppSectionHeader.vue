<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <header class="app-section-header">
    <div>
      <h2>{{ title }}</h2>
      <p v-if="description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="app-section-header__actions"><slot name="actions" /></div>
  </header>
</template>
