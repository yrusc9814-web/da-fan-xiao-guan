<script setup lang="ts">
import AppIconButton from '../components/ui/AppIconButton.vue';
import MascotPlaceholder from '../components/mascot/MascotPlaceholder.vue';
</script>

<template>
  <header class="mobile-header mobile-only">
    <RouterLink class="mobile-brand" to="/" aria-label="搭饭小馆首页">
      <MascotPlaceholder placement="brand-logo" />
      <span class="mobile-brand__text">
        <strong>搭饭小馆</strong>
        <small>让每一餐都更美好</small>
      </span>
    </RouterLink>
    <RouterLink class="mobile-settings" to="/settings" aria-label="设置">
      <AppIconButton icon="settings" label="设置" />
    </RouterLink>
  </header>
</template>
