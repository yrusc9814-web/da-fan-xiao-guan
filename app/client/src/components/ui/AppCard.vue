<script setup lang="ts">
withDefaults(defineProps<{ as?: 'article' | 'div' | 'section'; elevated?: boolean }>(), {
  as: 'div',
  elevated: true
});
</script>

<template>
  <component :is="as" class="app-card" :class="{ 'app-card--flat': !elevated }">
    <slot />
  </component>
</template>
