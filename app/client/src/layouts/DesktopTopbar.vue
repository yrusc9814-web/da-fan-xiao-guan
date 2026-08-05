<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue';
import AppIconButton from '../components/ui/AppIconButton.vue';
import AppInput from '../components/ui/AppInput.vue';
</script>

<template>
<header class="desktop-topbar desktop-only">
  <AppInput label="搜索" placeholder="搜索菜单、食材或功能…" disabled />
  <div class="desktop-topbar__actions">
    <AppIconButton icon="bell" label="通知（占位）" />
    <AppIconButton icon="calendar" label="日历（占位）" />
    <button type="button" class="user-entry" aria-label="用户入口（占位）">
      <span class="user-entry__avatar"><AppIcon name="user" :size="18" /></span>
      <span>个人空间</span>
      <AppIcon name="chevron-down" :size="16" />
    </button>
  </div>
</header>
</template>
