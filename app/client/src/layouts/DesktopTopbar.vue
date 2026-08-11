<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue';
import AppIconButton from '../components/ui/AppIconButton.vue';
import AppInput from '../components/ui/AppInput.vue';
import { useDashboardStore } from '../stores/dashboard';
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const dashboardStore = useDashboardStore();
const router = useRouter();
const searchQuery = ref('');
function search() { if (searchQuery.value.trim()) void router.push({ path: '/search', query: { q: searchQuery.value.trim() } }); }
</script>

<template>
<header class="desktop-topbar desktop-only">
  <AppInput v-model="searchQuery" label="搜索" type="search" placeholder="搜索菜谱、食材、店铺或记录…" @keyup.enter="search" />
  <div class="desktop-topbar__actions">
    <RouterLink to="/inventory"><AppIconButton icon="bell" label="库存提醒" /></RouterLink>
    <RouterLink to="/calendar"><AppIconButton icon="calendar" label="饮食日历" /></RouterLink>
    <RouterLink to="/settings" class="user-entry" aria-label="用户设置">
      <span class="user-entry__avatar"><AppIcon name="user" :size="18" /></span>
      <span>{{ dashboardStore.data?.userNickname ?? '个人空间' }}</span>
      <AppIcon name="chevron-down" :size="16" />
    </RouterLink>
  </div>
</header>
</template>
