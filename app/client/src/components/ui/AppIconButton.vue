<script setup lang="ts">
import AppIcon from '../AppIcon.vue';

withDefaults(defineProps<{
  label: string;
  icon: InstanceType<typeof AppIcon>['$props']['name'];
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
}>(), {
  size: 'md',
  disabled: false
});
</script>

<template>
  <button
    type="button"
    class="app-icon-button"
    :class="`app-icon-button--${size}`"
    :aria-label="label"
    :disabled="disabled"
  >
    <AppIcon :name="icon" />
  </button>
</template>
