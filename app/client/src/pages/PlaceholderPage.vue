<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import AppCard from '../components/ui/AppCard.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';

const route = useRoute();
const title = computed(() => String(route.meta.title ?? '页面占位'));
const headingId = computed(() => `placeholder-${String(route.name ?? 'page')}`);
</script>

<template>
  <template>
    <section class="placeholder-page" :aria-labelledby="headingId">
      <AppCard class="placeholder-page__inner">
        <AppEmptyState :title="title" description="功能将在后续节点实现，本轮仅验证响应式页面框架。" />
      </AppCard>
    </section>
  </template>
</template>
