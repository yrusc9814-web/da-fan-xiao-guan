<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppButton from '../components/ui/AppButton.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import { apiRequest } from '../services/api';

interface DeletedItem {
  id: string;
  entityType: string;
  entityId: string;
  name: string;
  deletedAt: string;
  expiresAt: string | null;
}
const items = ref<DeletedItem[]>([]),
  loading = ref(true),
  error = ref(''),
  message = ref('');
async function load() {
  loading.value = true;
  error.value = '';
  try {
    items.value = await apiRequest('/deleted-items');
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '读取失败';
  } finally {
    loading.value = false;
  }
}
async function restore(item: DeletedItem) {
  error.value = '';
  try {
    await apiRequest(`/deleted-items/${item.id}/restore`, { method: 'POST' });
    message.value = `已恢复“${item.name}”`;
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '恢复失败';
  }
}
const typeLabel = (value: string) =>
  ({
    Recipe: '菜谱',
    Ingredient: '食材',
    KitchenTool: '厨房工具',
    Store: '店铺',
    MealPlan: '计划',
    MealRecord: '记录',
    ShoppingList: '购物清单'
  })[value] ?? value;
onMounted(load);
</script>
<template>
  <section class="business-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">回收站</p>
        <h1>最近删除</h1>
        <p>删除的菜谱、食材、店铺等会在这里保留 30 天，期间可以随时找回。</p>
      </div>
    </header>
    <p v-if="message" class="business-success">{{ message }}</p>
    <AppErrorState v-if="error" title="回收站读取失败" :description="error" @retry="load" />
    <p v-else-if="loading">正在读取最近删除…</p>
    <AppEmptyState
      v-else-if="!items.length"
      title="最近删除是空的"
      description="删除的菜谱、食材、工具、店铺、计划、记录和购物清单会出现在这里。"
    />
    <div v-else class="business-grid">
      <article v-for="item in items" :key="item.id" class="business-card app-card">
        <div>
          <p>{{ typeLabel(item.entityType) }}</p>
          <h2>{{ item.name }}</h2>
          <p>
            删除于 {{ new Date(item.deletedAt).toLocaleString() }} ·
            {{ item.expiresAt ? `可恢复至 ${new Date(item.expiresAt).toLocaleDateString()}` : '可恢复' }}
          </p>
        </div>
        <AppButton size="sm" variant="secondary" @click="restore(item)">恢复</AppButton>
      </article>
    </div>
  </section>
</template>
