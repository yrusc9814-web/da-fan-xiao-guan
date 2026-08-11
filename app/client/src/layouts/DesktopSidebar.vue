<script setup lang="ts">
import MascotPlaceholder from '../components/mascot/MascotPlaceholder.vue';
import NavIllustration from '../components/NavIllustration.vue';
import { useDashboardStore } from '../stores/dashboard';

const dashboardStore = useDashboardStore();

const navItems = [
  { label: '首页', path: '/', icon: 'home' as const },
  { label: '菜谱推荐', path: '/recommendations', icon: 'chef' as const },
  { label: '我的菜谱', path: '/recipes', icon: 'journal' as const },
  { label: '饮食计划', path: '/plans', icon: 'calendar' as const },
  { label: '饮食记录', path: '/records', icon: 'journal' as const },
  { label: '食材库存', path: '/inventory', icon: 'ingredient' as const },
  { label: '厨房工具', path: '/tools', icon: 'chef' as const },
  { label: '饮食日历', path: '/calendar', icon: 'calendar' as const },
  { label: '统计分析', path: '/statistics', icon: 'statistics' as const },
  { label: '收藏夹', path: '/favorites', icon: 'heart' as const },
  { label: '购物清单', path: '/shopping', icon: 'clipboard-check' as const },
  { label: '设置', path: '/settings', icon: 'settings' as const }
];
</script>

<template>
<aside class="desktop-sidebar desktop-only">
  <RouterLink class="brand-lockup" to="/" aria-label="搭饭小馆首页">
    <MascotPlaceholder placement="brand-logo" />
    <span class="brand-lockup__text">
      <strong>搭饭小馆</strong>
      <small>让每一餐都更美好</small>
    </span>
  </RouterLink>

  <nav class="desktop-sidebar__nav" aria-label="桌面端主导航">
    <RouterLink
      v-for="item in navItems"
      :key="item.path"
      :to="item.path"
      class="desktop-nav-link"
      exact-active-class="desktop-nav-link--active"
      :aria-label="item.label"
    >
      <span class="desktop-nav-link__icon" :class="`desktop-nav-link__icon--${item.icon}`" aria-hidden="true">
        <NavIllustration :name="item.icon" :size="22" />
      </span>
      <span>{{ item.label }}</span>
    </RouterLink>
  </nav>

  <div class="desktop-sidebar__tip">
    <MascotPlaceholder placement="sidebar-tip" />
    <strong>搭饭小贴士</strong>
    <p>{{ dashboardStore.data?.tip ?? '记得记录今天吃过的每一餐，慢慢找到适合自己的节奏。' }}</p>
  </div>
</aside>
</template>
