<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="app-state app-state--error" role="alert">
    <div class="app-state__mark" aria-hidden="true">!</div>
    <h3>{{ title }}</h3>
    <p v-if="description">{{ description }}</p>
    <slot />
  </div>
</template>
