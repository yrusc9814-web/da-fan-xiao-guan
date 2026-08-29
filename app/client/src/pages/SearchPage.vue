<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppButton from '../components/ui/AppButton.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import { apiRequest } from '../services/api';
import { debounce } from '../utils/debounce';
import { createRequestSequence } from '../utils/request-sequence';
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
const searchSequence = createRequestSequence();
const emptyResult = (): Record<'recipes' | 'ingredients' | 'stores' | 'records', ResultItem[]> => ({
  recipes: [],
  ingredients: [],
  stores: [],
  records: []
});
const total = computed(() => Object.values(result.value).reduce((n, x) => n + x.length, 0));
// 程序性 replace 的目标值：在发起 replace 前同步写入，路由 watcher 用“值比对”识别
// 自己刚同步出的 echo（route.query.q === lastSyncedKeyword）并忽略，避免回写冲掉用户
// 更新的输入；浏览器前进/后退等外部导航带来的值与它不同，照常响应。写入时机不依赖
// promise 落定顺序，因此没有“计数归零后 echo 或外部导航被吞掉”的 race。
let lastSyncedKeyword = String(route.query.q ?? '');
// 最近一次真正发起搜索（submit、路由同步、输入防抖）的关键词：输入防抖到期时据此
// 跳过已被其它路径处理过的同一关键词，避免重复请求。
let lastSearchedKeyword = '';
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
  lastSearchedKeyword = query;
  const sequence = searchSequence.next();
  if (!query) {
    // 清空关键词：作废全部在途请求（sequence 已递增），并立刻复位结果/错误/骨架屏
    result.value = emptyResult();
    error.value = '';
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = '';
  if (route.query.q !== query) {
    // 路由同步 fire-and-forget：不阻塞 fetch，竞态由 searchSequence + watcher 值比对兜底
    lastSyncedKeyword = query;
    void router.replace({ query: { q: query } });
  }
  try {
    const data = await apiRequest<typeof result.value>('/search', { query: { q: query } });
    if (!searchSequence.isCurrent(sequence)) return;
    result.value = data;
    error.value = '';
  } catch (e) {
    if (!searchSequence.isCurrent(sequence)) return;
    error.value = e instanceof Error ? e.message : '搜索失败';
  } finally {
    if (searchSequence.isCurrent(sequence)) loading.value = false;
  }
}
// 输入即搜：与 selector 一致的 request-sequence + debounce 250ms 模式；表单 submit /
// 回车仍是立即搜索路径。连续输入只保留最后一次，请求竞态由 searchSequence 守卫，
// 已被 submit / 路由同步处理过的同一关键词由 lastSearchedKeyword 去重。
const searchOnInput = debounce(() => {
  if (q.value.trim() === lastSearchedKeyword) return;
  void search();
}, 250);
watch(q, () => searchOnInput());
watch(
  () => route.query.q,
  (value) => {
    const next = String(value ?? '');
    if (next === lastSyncedKeyword) {
      // 程序性 replace 自己产生的 echo：输入框已反映（或新于）该值，回写会冲掉用户输入
      return;
    }
    // 外部导航（浏览器前进/后退、其它代码 router.push）：采纳为新基线并正常响应
    lastSyncedKeyword = next;
    if (next !== q.value) {
      q.value = next;
      void search();
    }
  }
);
onMounted(() => {
  if (q.value) void search();
});
onUnmounted(() => {
  searchSequence.next();
  searchOnInput.cancel();
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
