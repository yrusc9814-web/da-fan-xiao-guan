<script setup lang="ts">
withDefaults(defineProps<{ tone?: 'primary' | 'green' | 'orange' | 'purple' | 'neutral' }>(), {
  tone: 'primary'
});
</script>

<template>
  <span class="app-badge" :class="`app-badge--${tone}`"><slot /></span>
</template>
