<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue';

const navItems = [
  { label: '首页', path: '/', icon: 'home' as const },
  { label: '厨师', path: '/chef', icon: 'chef' as const },
  { label: '觅食', path: '/discovery', icon: 'shopping' as const },
  { label: '日记', path: '/journal', icon: 'journal' as const }
];
</script>

<template>
  <nav class="mobile-bottom-nav mobile-only" aria-label="移动端主导航">
    <RouterLink
      v-for="item in navItems"
      :key="item.path"
      :to="item.path"
      class="mobile-nav-link"
      exact-active-class="mobile-nav-link--active"
      :aria-label="item.label"
    >
      <AppIcon :name="item.icon" :size="22" />
      <span>{{ item.label }}</span>
    </RouterLink>
  </nav>
</template>
