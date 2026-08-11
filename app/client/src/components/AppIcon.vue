<script setup lang="ts">
import { computed } from 'vue';

type IconName =
  | 'arrow-right'
  | 'bell'
  | 'calendar'
  | 'check'
  | 'chef'
  | 'clock'
  | 'clipboard-check'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'close'
  | 'discovery'
  | 'heart'
  | 'home'
  | 'ingredient'
  | 'info'
  | 'journal'
  | 'meal-breakfast'
  | 'meal-dinner'
  | 'meal-lunch'
  | 'menu'
  | 'plus'
  | 'search'
  | 'settings'
  | 'shopping'
  | 'sparkle'
  | 'star'
  | 'statistics'
  | 'user';

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), {
  size: 20
});

const paths: Record<IconName, string> = {
  'arrow-right': 'M5 12h13m-6-6 6 6-6 6',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  calendar: 'M5 4h14a2 2 0 0 1 2 2v13H3V6a2 2 0 0 1 2-2m-2 5h18M8 2v4m8-4v4',
  check: 'm5 12 4 4L19 6',
  chef: 'M6 10a4 4 0 1 1 2.6-7.02A5 5 0 0 1 18 6a4 4 0 0 1 0 8v7H6v-7a4 4 0 0 1 0-4',
  clock: 'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  'clipboard-check': 'M7 4h10a2 2 0 0 1 2 2v15H5V6a2 2 0 0 1 2-2m3 0V2h4v2m-5 7 2 2 4-4',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-left': 'm15 18-6-6 6-6',
  'chevron-right': 'm9 18 6-6-6-6',
  close: 'm6 6 12 12M18 6 6 18',
  discovery: 'M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0m5 3 2-5 5-2-2 5-5 2Z',
  heart: 'M20.8 8.8a5.5 5.5 0 0 0-9-4.2A5.5 5.5 0 0 0 2.8 8.8c0 5 9 10 9 10s9-5 9-10Z',
  home: 'm3 10 9-7 9 7v10H3V10Zm6 10v-6h6v6',
  ingredient: 'M4 9h16l-1 11H5L4 9Zm3 0a5 5 0 0 1 10 0M8 13h.01M12 13h.01M16 13h.01',
  info: 'M12 8h.01M11 12h1v4h1m-1-14a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z',
  journal: 'M5 4h14a2 2 0 0 1 2 2v14H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2m3 4h8m-8 4h8m-8 4h5',
  'meal-breakfast': 'M4 13h16a8 8 0 0 1-16 0Zm3-4 2-2m3 2 2-2m3 2 2-2',
  'meal-dinner': 'M4 13h16a8 8 0 0 1-16 0Zm2 4h12',
  'meal-lunch': 'M5 13h14l-1 6H6l-1-6Zm-2 0h18M8 9a4 4 0 0 1 8 0',
  menu: 'M4 6h16M4 12h16M4 18h16',
  plus: 'M12 5v14M5 12h14',
  search: 'm21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  settings:
    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm7.4-3.2a7.5 7.5 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a8 8 0 0 0-2.1-1.2L14.6 3h-4l-.3 2.6c-.8.3-1.5.7-2.1 1.2L5.9 5.9l-2 3.4 2 1.5a7.5 7.5 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9c.6.5 1.3.9 2.1 1.2l.3 2.6h4l.3-2.6c.8-.3 1.5-.7 2.1-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z',
  shopping: 'M4 8h16l-1 12H5L4 8Zm4 0a4 4 0 0 1 8 0',
  sparkle:
    'm12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Zm6 12 .6 2.4L21 18l-2.4.6L18 21l-.6-2.4L15 18l2.4-.6L18 15Z',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z',
  statistics: 'M5 19V9m7 10V5m7 14v-7M3 21h18',
  user: 'M20 21a8 8 0 0 0-16 0m12-13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'
};

const path = computed(() => paths[props.name]);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="path" />
  </svg>
</template>
