<script setup lang="ts">
withDefaults(defineProps<{ lines?: number }>(), { lines: 3 });
</script>

<template>
  <div class="app-skeleton" aria-label="加载中" aria-busy="true">
    <span
      v-for="line in lines"
      :key="line"
      class="app-skeleton__line"
      :class="{ 'app-skeleton__line--short': line === lines }"
    ></span>
  </div>
</template>
