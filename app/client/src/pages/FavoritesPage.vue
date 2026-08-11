<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppButton from '../components/ui/AppButton.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import { apiRequest } from '../services/api';
interface Favorite {
  id: string;
  name?: string;
  recordDate?: string;
  notes?: string | null;
  version: number;
}
const data = ref<{ recipes: Favorite[]; stores: Favorite[]; records: Favorite[] }>({
    recipes: [],
    stores: [],
    records: []
  }),
  loading = ref(true),
  busyId = ref(''),
  error = ref('');
const total = computed(() => data.value.recipes.length + data.value.stores.length + data.value.records.length);
async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await apiRequest('/favorites');
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}
function link(kind: string, item: Favorite) {
  if (kind === 'recipes') return `/recipes/${item.id}`;
  if (kind === 'stores') return { path: '/discovery', query: { focus: item.id } };
  return { path: '/records', query: { focus: item.id } };
}
async function remove(kind: 'recipes' | 'stores' | 'records', item: Favorite) {
  busyId.value = item.id;
  error.value = '';
  try {
    await apiRequest(`/${kind}/${item.id}/favorite`, {
      method: 'POST',
      body: JSON.stringify({ favorite: false, version: item.version })
    });
    data.value[kind] = data.value[kind].filter((x) => x.id !== item.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '取消收藏失败';
  } finally {
    busyId.value = '';
  }
}
onMounted(load);
</script>
<template>
  <section class="business-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">Favorites</p>
        <h1>收藏夹</h1>
        <p>收藏的菜谱、店铺和饮食记录都来自真实数据库。</p>
      </div>
    </header>
    <AppErrorState v-if="error" title="收藏操作失败" :description="error" @retry="load" />
    <div v-else-if="loading" class="business-grid"><AppSkeleton v-for="index in 3" :key="index" height="180px" /></div>
    <AppEmptyState v-else-if="!total" title="还没有收藏" description="在菜谱、觅食或日记中点亮爱心。" />
    <div v-else class="business-grid">
      <section v-for="kind in ['recipes', 'stores', 'records'] as const" :key="kind" class="app-card">
        <h2>{{ { recipes: '菜谱', stores: '店铺', records: '记录' }[kind] }}</h2>
        <article v-for="item in data[kind]" :key="item.id" class="favorite-row">
          <RouterLink :to="link(kind, item)">{{
            item.name ?? `${item.recordDate} · ${item.notes || '饮食记录'}`
          }}</RouterLink
          ><AppButton size="sm" variant="ghost" :loading="busyId === item.id" @click="remove(kind, item)"
            >取消收藏</AppButton
          >
        </article>
        <p v-if="!data[kind].length">暂无</p>
      </section>
    </div>
  </section>
</template>
<style scoped>
.favorite-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--color-border);
}
.favorite-row a {
  color: inherit;
  text-decoration: none;
  font-weight: 650;
}
</style>
