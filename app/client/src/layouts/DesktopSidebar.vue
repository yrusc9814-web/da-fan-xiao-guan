<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue';
import MascotPlaceholder from '../components/mascot/MascotPlaceholder.vue';
import AppCard from '../components/ui/AppCard.vue';

const navItems = [
  { label: '首页', path: '/', icon: 'home' as const },
  { label: '菜谱推荐', path: '/recommendations', icon: 'chef' as const },
  { label: '饮食记录', path: '/records', icon: 'journal' as const },
  { label: '食材库存', path: '/inventory', icon: 'shopping' as const },
  { label: '饮食日历', path: '/calendar', icon: 'calendar' as const },
  { label: '统计分析', path: '/statistics', icon: 'statistics' as const },
  { label: '收藏夹', path: '/favorites', icon: 'heart' as const },
  { label: '购物清单', path: '/shopping', icon: 'check' as const },
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
      <AppIcon :name="item.icon" :size="21" />
      <span>{{ item.label }}</span>
    </RouterLink>
  </nav>

  <AppCard class="desktop-sidebar__tip" :elevated="false">
    <MascotPlaceholder placement="sidebar-tip" />
    <strong>搭饭小贴士</strong>
    <p>公共提示位将在后续节点接入真实内容。</p>
  </AppCard>
</aside>
</template>
