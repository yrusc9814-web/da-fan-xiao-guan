<script setup lang="ts">
import { computed } from 'vue';

import brandLogoUrl from '../../assets/mascot/brand-logo.png';
import homeHeroUrl from '../../assets/mascot/home-hero.png';
import sidebarTipUrl from '../../assets/mascot/sidebar-tip.png';

const props = withDefaults(defineProps<{ placement?: 'brand-logo' | 'home-hero' | 'sidebar-tip' | 'empty-state' }>(), {
  placement: 'empty-state'
});

const assetUrl = computed(() => ({
  'brand-logo': brandLogoUrl,
  'home-hero': homeHeroUrl,
  'sidebar-tip': sidebarTipUrl,
  'empty-state': null
}[props.placement]));
</script>

<template>
  <div class="mascot-placeholder" :class="`mascot-placeholder--${placement}`" role="img" :aria-label="assetUrl ? `${placement}：小羊插画` : `${placement}：待提供统一小羊资产`">
    <img v-if="assetUrl" :src="assetUrl" :alt="`${placement}小羊插画`" />
    <span v-else>小羊素材<br />待提供</span>
  </div>
</template>
