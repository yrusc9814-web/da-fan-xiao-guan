<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppButton from '../components/ui/AppButton.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppInput from '../components/ui/AppInput.vue';
import { apiRequest, ApiRequestError } from '../services/api';
import { displayLabel } from '../utils/display';
interface Item {
  id: string;
  ingredientNameSnapshot: string;
  quantity: number;
  unit: string;
  completed: boolean;
  notes: string | null;
}
interface List {
  id: string;
  name: string;
  status: string;
  notes: string | null;
  version: number;
  items: Item[];
}
const lists = ref<List[]>([]),
  selected = ref<List | null>(null),
  loading = ref(true),
  saving = ref(false),
  error = ref(''),
  conflict = ref('');
const newList = ref(''),
  item = ref({ name: '', quantity: '1', unit: 'PIECE' });
async function load(preferred?: string) {
  loading.value = true;
  error.value = '';
  try {
    lists.value = await apiRequest('/shopping-lists');
    selected.value = lists.value.find((x) => x.id === (preferred ?? selected.value?.id)) ?? lists.value[0] ?? null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}
async function createList() {
  if (!newList.value.trim()) return;
  saving.value = true;
  try {
    const created = await apiRequest<List>('/shopping-lists', {
      method: 'POST',
      body: JSON.stringify({ name: newList.value, items: [] })
    });
    newList.value = '';
    await load(created.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '创建失败';
  } finally {
    saving.value = false;
  }
}
async function addItem() {
  if (!selected.value || !item.value.name.trim()) return;
  saving.value = true;
  try {
    await apiRequest(`/shopping-lists/${selected.value.id}/items`, {
      method: 'POST',
      body: JSON.stringify({
        version: selected.value.version,
        ingredientName: item.value.name,
        quantity: Number(item.value.quantity),
        unit: item.value.unit,
        sourceType: 'MANUAL'
      })
    });
    item.value.name = '';
    await load(selected.value.id);
  } catch (e) {
    handle(e);
  } finally {
    saving.value = false;
  }
}
let toggleChain: Promise<void> = Promise.resolve();
function toggle(row: Item) {
  const listId = selected.value?.id;
  if (!listId) return;
  // C-01：连续快速勾选时串行发送，后一个 PUT 总是基于前一个响应的最新 version，避免过期 version 触发 409
  toggleChain = toggleChain.then(() => doToggle(listId, row));
}
async function doToggle(listId: string, row: Item) {
  const list = lists.value.find((entry) => entry.id === listId);
  const target = list?.items.find((entry) => entry.id === row.id);
  if (!list || !target) return;
  try {
    const updated = await apiRequest<List>(`/shopping-list-items/${target.id}`, {
      method: 'PUT',
      body: JSON.stringify({ version: list.version, completed: !target.completed })
    });
    // 服务端返回更新后的整张清单，局部替换即可，避免整页 load 导致勾选状态回滚闪烁
    const index = lists.value.findIndex((entry) => entry.id === updated.id);
    if (index >= 0) lists.value[index] = updated;
    if (selected.value?.id === updated.id) selected.value = updated;
  } catch (e) {
    handle(e);
  }
}
async function clear() {
  if (!selected.value) return;
  try {
    await apiRequest(`/shopping-lists/${selected.value.id}/clear-completed`, {
      method: 'POST',
      body: JSON.stringify({ version: selected.value.version })
    });
    await load(selected.value.id);
  } catch (e) {
    handle(e);
  }
}
function handle(e: unknown) {
  if (e instanceof ApiRequestError && e.status === 409) conflict.value = e.message;
  else error.value = e instanceof Error ? e.message : '操作失败';
}
onMounted(() => load());
</script>
<template>
  <section class="business-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">Shopping</p>
        <h1>购物清单</h1>
        <p>同食材且单位可换算时自动合并，冲突时不会覆盖其他设备的修改。</p>
      </div>
    </header>
    <form class="business-toolbar app-card" @submit.prevent="createList">
      <AppInput v-model="newList" label="新清单" placeholder="例如：本周采购" /><AppButton
        type="submit"
        :loading="saving"
        >创建</AppButton
      >
    </form>
    <div v-if="conflict" class="business-conflict" role="alert">
      {{ conflict }} <button class="text-button" @click="load()">重新加载</button>
    </div>
    <AppErrorState v-if="error" title="购物清单读取失败" :description="error" @retry="load()" />
    <p v-else-if="loading">正在读取购物清单…</p>
    <AppEmptyState
      v-else-if="!lists.length"
      title="还没有购物清单"
      description="创建一张清单，或在库存不足时自动生成。"
    /><template v-else
      ><div class="business-toolbar app-card">
        <label class="app-field"
          ><span class="app-field__label">当前清单</span
          ><select v-model="selected">
            <option v-for="list in lists" :key="list.id" :value="list">
              {{ list.name }}（{{ list.items.length }}）
            </option>
          </select></label
        ><AppButton variant="ghost" @click="clear">清理已完成</AppButton>
      </div>
      <form v-if="selected" class="business-form app-card" @submit.prevent="addItem">
        <AppInput v-model="item.name" label="食材" /><AppInput v-model="item.quantity" label="数量" /><label
          class="app-field"
          ><span class="app-field__label">单位</span
          ><select v-model="item.unit">
            <option value="GRAM">克</option>
            <option value="KILOGRAM">千克</option>
            <option value="MILLILITER">毫升</option>
            <option value="LITER">升</option>
            <option value="PIECE">个</option>
          </select></label
        ><AppButton type="submit" :loading="saving">加入</AppButton>
      </form>
      <div v-if="selected" class="shopping-items app-card">
        <label v-for="row in selected.items" :key="row.id" class="shopping-row"
          ><input type="checkbox" :checked="row.completed" @change="toggle(row)" /><span
            :class="{ 'is-done': row.completed }"
            >{{ row.ingredientNameSnapshot }}</span
          ><strong>{{ row.quantity }} {{ displayLabel(row.unit) }}</strong></label
        ><AppEmptyState
          v-if="!selected.items.length"
          title="清单是空的"
          description="手动添加食材或从缺料结果生成。"
        /></div
    ></template>
  </section>
</template>
