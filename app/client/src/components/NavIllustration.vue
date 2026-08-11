<script setup lang="ts">
type NavIllustrationName =
  | 'calendar'
  | 'chef'
  | 'clipboard-check'
  | 'heart'
  | 'home'
  | 'ingredient'
  | 'journal'
  | 'settings'
  | 'statistics';

defineProps<{ name: NavIllustrationName; size?: number }>();
</script>

<template>
  <svg
    class="nav-illustration"
    :width="size ?? 22"
    :height="size ?? 22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'home'">
      <path d="m3.5 10.5 8.5-6.7 8.5 6.7v9.2H3.5Z" fill="currentColor" fill-opacity=".2" />
      <path d="M8.7 19.7v-5.2h6.6v5.2" fill="currentColor" fill-opacity=".4" />
      <path d="m3.5 10.5 8.5-6.7 8.5 6.7" />
    </template>

    <template v-else-if="name === 'chef'">
      <path d="M5.5 10.8h13v8.5h-13Z" fill="currentColor" fill-opacity=".2" />
      <path d="M6 10.8a3.5 3.5 0 1 1 2.2-6.2 4.7 4.7 0 0 1 7.6 1.2 3.1 3.1 0 1 1 2.2 5" fill="currentColor" fill-opacity=".32" />
      <path d="M8.5 14.2h7m-7 2.6h4.5" />
    </template>

    <template v-else-if="name === 'journal'">
      <path d="M5.2 4.2h13.2a2 2 0 0 1 2 2v13.2H6.2a2 2 0 0 1-2-2V6.2a2 2 0 0 1 2-2Z" fill="currentColor" fill-opacity=".2" />
      <path d="M8 8h8m-8 3.5h8m-8 3.5h5" />
      <path d="M4.2 7.2h2.5v12.2" fill="currentColor" fill-opacity=".18" />
    </template>

    <template v-else-if="name === 'ingredient'">
      <path d="m4.2 9.5 1.2 9.7h13.2l1.2-9.7Z" fill="currentColor" fill-opacity=".2" />
      <path d="M7.4 9.4a4.7 4.7 0 0 1 9.2 0" />
      <circle cx="9" cy="13.3" r="1.25" fill="currentColor" fill-opacity=".55" stroke="none" />
      <circle cx="12" cy="15.5" r="1.25" fill="currentColor" fill-opacity=".42" stroke="none" />
      <circle cx="15.2" cy="13.1" r="1.25" fill="currentColor" fill-opacity=".62" stroke="none" />
    </template>

    <template v-else-if="name === 'calendar'">
      <rect x="4" y="5.3" width="16" height="14.8" rx="2.2" fill="currentColor" fill-opacity=".18" />
      <path d="M4 9.5h16M8 3.5v3.2m8-3.2v3.2" />
      <circle cx="8" cy="12.8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12.8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="16" cy="12.8" r=".9" fill="currentColor" stroke="none" />
    </template>

    <template v-else-if="name === 'statistics'">
      <path d="M5 19V11m7 8V6m7 13v-5" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" opacity=".72" />
      <path d="M3.5 20.5h17" />
      <circle cx="5" cy="10.2" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="5.2" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="13.2" r="1.1" fill="currentColor" stroke="none" />
    </template>

    <template v-else-if="name === 'heart'">
      <path d="M12 19.3S3.5 14.5 3.5 8.7A4.3 4.3 0 0 1 12 6.4a4.3 4.3 0 0 1 8.5 2.3c0 5.8-8.5 10.6-8.5 10.6Z" fill="currentColor" fill-opacity=".28" />
      <path d="M8.3 9.4h.01m7.4 0h.01" stroke-width="2.4" />
    </template>

    <template v-else-if="name === 'clipboard-check'">
      <rect x="5.2" y="4.8" width="13.6" height="16" rx="2.2" fill="currentColor" fill-opacity=".2" />
      <path d="M9 4.8V3.4h6v1.4m-6.4 6.3 2.2 2.2 4.2-4.2m-6.4 6.3h5.8" />
    </template>

    <template v-else-if="name === 'settings'">
      <path d="m12 3.1 1 .2.7 2.2a7.4 7.4 0 0 1 1.7 1l2.2-.8 1.1 1.8-1.5 1.7c.2.6.3 1.2.3 1.8l2 1.3-.6 2-2.3.1a7.1 7.1 0 0 1-1.2 1.6l.3 2.2-2 .7-1.2-1.8a7.5 7.5 0 0 1-2.1 0L9.2 19l-2-.7.3-2.2a7.1 7.1 0 0 1-1.2-1.6L4 14.4l-.6-2 2-1.3c0-.6.1-1.2.3-1.8L4.2 7.5l1.1-1.8 2.2.8a7.4 7.4 0 0 1 1.7-1l.7-2.2Z" fill="currentColor" fill-opacity=".18" />
      <circle cx="12" cy="12.2" r="2.7" fill="currentColor" fill-opacity=".32" />
    </template>
  </svg>
</template>
