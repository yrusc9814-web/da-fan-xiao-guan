<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppButton from '../components/ui/AppButton.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import { apiRequest } from '../services/api';
type ResultItem = { id: string; name?: string; recordDate?: string; notes?: string | null };
const route = useRoute(),
  router = useRouter(),
  q = ref(String(route.query.q ?? '')),
  loading = ref(false),
  error = ref(''),
  result = ref<Record<'recipes' | 'ingredients' | 'stores' | 'records', ResultItem[]>>({
    recipes: [],
    ingredients: [],
    stores: [],
    records: []
  });
const sectionLabels = { recipes: '菜谱', ingredients: '食材', stores: '店铺', records: '记录' };
const total = computed(() => Object.values(result.value).reduce((n, x) => n + x.length, 0));
function target(key: string, item: ResultItem) {
  if (key === 'recipes') return `/recipes/${item.id}`;
  if (key === 'ingredients') return { path: '/inventory', query: { focus: item.id } };
  if (key === 'stores') return { path: '/discovery', query: { focus: item.id } };
  return { path: '/records', query: { focus: item.id } };
}
function title(item: ResultItem) {
  return item.name ?? `${item.recordDate} · ${item.notes || '饮食记录'}`;
}
async function search() {
  const query = q.value.trim();
  if (!query) {
    result.value = { recipes: [], ingredients: [], stores: [], records: [] };
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    if (route.query.q !== query) await router.replace({ query: { q: query } });
    result.value = await apiRequest('/search', { query: { q: query } });
  } catch (e) {
    error.value = e instanceof Error ? e.message : '搜索失败';
  } finally {
    loading.value = false;
  }
}
watch(
  () => route.query.q,
  (value) => {
    const next = String(value ?? '');
    if (next !== q.value) {
      q.value = next;
      void search();
    }
  }
);
onMounted(() => {
  if (q.value) void search();
});
</script>
<template>
  <section class="business-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">Global search</p>
        <h1>全局搜索</h1>
        <p>同时查找菜谱、结构化食材、店铺和饮食记录。</p>
      </div>
    </header>
    <form class="business-toolbar app-card" @submit.prevent="search">
      <AppInput v-model="q" label="关键词" autofocus /><AppButton type="submit" :loading="loading">搜索</AppButton>
    </form>
    <AppErrorState v-if="error" title="搜索失败" :description="error" @retry="search" />
    <div v-else-if="loading" class="business-grid"><AppSkeleton v-for="index in 4" :key="index" height="140px" /></div>
    <AppEmptyState v-else-if="!total" title="没有找到结果" description="换一个菜名、食材、店铺或备注关键词试试。" />
    <div v-else class="business-grid">
      <section v-for="(items, key) in result" :key="key" class="app-card">
        <h2>{{ sectionLabels[key] }}</h2>
        <RouterLink v-for="item in items" :key="item.id" class="search-result" :to="target(key, item)"
          >{{ title(item) }}<span>查看 →</span></RouterLink
        >
        <p v-if="!items.length">暂无</p>
      </section>
    </div>
  </section>
</template>
<style scoped>
.search-result {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 10px 0;
  border-bottom: 1px solid var(--color-border);
  color: inherit;
  text-decoration: none;
}
.search-result span {
  color: var(--color-primary-hover);
}
</style>
