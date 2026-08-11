<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import { apiRequest } from '../services/api';

const data = ref<{
  recipes: Array<{ id: string; name: string }>;
  stores: Array<{ id: string; name: string }>;
  records: Array<{ id: string; recordDate: string; notes: string | null }>;
}>({ recipes: [], stores: [], records: [] });
const loading = ref(true);
const error = ref('');

onMounted(async () => {
  try { data.value = await apiRequest('/favorites'); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '加载失败'; }
  finally { loading.value = false; }
});
</script>
<template><section class="business-page"><header class="business-hero"><div><p class="business-eyebrow">Favorites</p><h1>收藏夹</h1><p>收藏的菜谱、店铺和饮食记录都来自真实数据库。</p></div></header><p v-if="loading">正在读取收藏…</p><p v-else-if="error" class="business-conflict">{{error}}</p><AppEmptyState v-else-if="!data.recipes.length&&!data.stores.length&&!data.records.length" title="还没有收藏" description="在菜谱、觅食或日记中点亮爱心。"/><div v-else class="business-grid"><section class="app-card"><h2>菜谱</h2><p v-for="x in data.recipes" :key="x.id">♥ {{x.name}}</p></section><section class="app-card"><h2>店铺</h2><p v-for="x in data.stores" :key="x.id">♥ {{x.name}}</p></section><section class="app-card"><h2>记录</h2><p v-for="x in data.records" :key="x.id">♥ {{x.recordDate}} · {{x.notes||'饮食记录'}}</p></section></div></section></template>
