<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppButton from '../components/ui/AppButton.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import { apiRequest } from '../services/api';
interface Stats {
  period: { start: string; end: string };
  totalRecords: number;
  recordedDays: number;
  totalMeals: number;
  newTryCount: number;
  favoriteCount: number;
  averageRating: number | null;
  sourceBreakdown: Record<string, number>;
  mealTypeDistribution: Record<string, number>;
  topRecipes: Array<{ id: string; name: string; count: number }>;
  topStores: Array<{ id: string; name: string; count: number }>;
  shoppingCompletionRate: number | null;
}
const stats = ref<Stats | null>(null),
  error = ref(''),
  loading = ref(true),
  range = ref('month');
function dates() {
  const end = new Date(),
    start = new Date();
  if (range.value === 'week') start.setDate(end.getDate() - 6);
  else if (range.value === 'three') start.setMonth(end.getMonth() - 3);
  else start.setDate(1);
  return { start: start.toLocaleDateString('sv-SE'), end: end.toLocaleDateString('sv-SE') };
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    stats.value = await apiRequest('/statistics', { query: dates() });
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section class="business-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">Insights</p>
        <h1>统计分析</h1>
        <p>仅汇总已确认的饮食记录，草稿不会污染正式统计。</p>
      </div>
      <div class="calendar-nav">
        <select v-model="range" class="stats-select" aria-label="统计时间范围" @change="load">
          <option value="week">近 7 天</option>
          <option value="month">本月</option>
          <option value="three">近 3 个月</option></select
        ><AppButton variant="secondary" @click="load">刷新</AppButton>
      </div>
    </header>
    <AppErrorState v-if="error" title="统计读取失败" :description="error" @retry="load" />
    <div v-else-if="loading" class="stats-grid" aria-label="正在聚合真实记录">
      <AppSkeleton v-for="index in 6" :key="index" height="96px" />
    </div>
    <template v-else-if="stats"
      ><div class="stats-grid">
        <article class="app-card">
          <span>记录餐数</span><strong>{{ stats.totalMeals }}</strong>
        </article>
        <article class="app-card">
          <span>有记录天数</span><strong>{{ stats.recordedDays }}</strong>
        </article>
        <article class="app-card">
          <span>平均评分</span><strong>{{ stats.averageRating ?? '—' }}</strong>
        </article>
        <article class="app-card">
          <span>新尝试</span><strong>{{ stats.newTryCount }}</strong>
        </article>
        <article class="app-card">
          <span>收藏餐次</span><strong>{{ stats.favoriteCount }}</strong>
        </article>
        <article class="app-card">
          <span>购物完成率</span
          ><strong>{{
            stats.shoppingCompletionRate === null ? '—' : `${Math.round(stats.shoppingCompletionRate * 100)}%`
          }}</strong>
        </article>
      </div>
      <div class="business-grid">
        <article class="app-card">
          <h2>常吃菜谱</h2>
          <ol>
            <li v-for="x in stats.topRecipes" :key="x.id">
              {{ x.name }} <strong>{{ x.count }}</strong>
            </li>
          </ol>
          <p v-if="!stats.topRecipes.length">暂无数据</p>
        </article>
        <article class="app-card">
          <h2>常去店铺</h2>
          <ol>
            <li v-for="x in stats.topStores" :key="x.id">
              {{ x.name }} <strong>{{ x.count }}</strong>
            </li>
          </ol>
          <p v-if="!stats.topStores.length">暂无数据</p>
        </article>
        <article class="app-card">
          <h2>来源分布</h2>
          <p v-for="(count, name) in stats.sourceBreakdown" :key="name">{{ name }}：{{ count }}</p>
          <p v-if="!Object.keys(stats.sourceBreakdown).length">暂无数据</p>
        </article>
      </div></template
    >
  </section>
</template>
<style scoped>
.calendar-nav {
  display: flex;
  align-items: center;
  gap: 10px;
}
.stats-select {
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-input);
  background: var(--color-card);
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--space-3);
}
.stats-grid article {
  display: grid;
  gap: var(--space-2);
}
.stats-grid span {
  color: var(--color-text-secondary);
  font-size: 13px;
}
.stats-grid strong {
  font-size: 28px;
  color: var(--color-primary-hover);
}
ol {
  display: grid;
  gap: var(--space-2);
  padding-left: var(--space-5);
}
li strong {
  float: right;
}
@media (max-width: 900px) {
  .stats-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 540px) {
  .stats-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
