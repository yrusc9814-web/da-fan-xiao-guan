<script setup lang="ts">
withDefaults(defineProps<{ placement?: 'brand-logo' | 'home-hero' | 'sidebar-tip' | 'empty-state' }>(), {
  placement: 'empty-state'
});
</script>

<template>
  <div class="mascot-placeholder" role="img" :aria-label="`${placement}：待提供统一小羊资产`">
    <span>小羊素材<br />待提供</span>
  </div>
</template>
