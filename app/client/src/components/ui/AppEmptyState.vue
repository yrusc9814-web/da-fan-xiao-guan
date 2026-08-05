<script setup lang="ts">
withDefaults(defineProps<{ title: string; description?: string }>(), { description: '' });
</script>

<template>
  <div class="app-state" role="status">
    <div class="app-state__mark" aria-hidden="true">—</div>
    <h3>{{ title }}</h3>
    <p v-if="description">{{ description }}</p>
    <slot />
  </div>
</template>
