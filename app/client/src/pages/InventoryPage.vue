<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { IngredientDto, InventoryBatchDto, PaginationResponse } from '../../../shared/types';
import AppButton from '../components/ui/AppButton.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import { apiRequest, ApiRequestError } from '../services/api';

const ingredients = ref<IngredientDto[]>([]), loading = ref(true), saving = ref(false);
const error = ref(''), conflict = ref(''), query = ref('');
const showCreate = ref(false), form = ref({ name: '', category: '', quantity: '0', unit: 'GRAM', minStock: '' });
const adjustTarget = ref<{ ingredient: IngredientDto; batch: InventoryBatchDto } | null>(null), adjustQuantity = ref('');
const panel=ref<'logs'|'recommend'|null>(null),logs=ref<Array<any>>([]),recommendations=ref<Array<any>>([]),recommendMode=ref('ALLOW_PURCHASE');
const totalQuantity = computed(() => ingredients.value.reduce((sum, item) => sum + item.quantity, 0));
function normalizeIngredient(item: IngredientDto & { inventoryBatches?: InventoryBatchDto[] }): IngredientDto {
  return {
    ...item,
    status: item.status ?? (item.quantity <= 0 ? 'EMPTY' : 'NORMAL'),
    batches: item.batches ?? item.inventoryBatches ?? []
  };
}
function listFrom(value: IngredientDto[] | PaginationResponse<IngredientDto>) { return (Array.isArray(value) ? value : value.items).map((item) => normalizeIngredient(item)); }
async function load() { loading.value = true; error.value = ''; try { ingredients.value = listFrom(await apiRequest('/ingredients', { query: { search: query.value, pageSize: 100 } })); } catch (reason) { error.value = reason instanceof Error ? reason.message : '加载失败'; } finally { loading.value = false; } }
async function createIngredient() {
  if (!form.value.name.trim()) return; saving.value = true;
  try {
    await apiRequest('/ingredients', { method: 'POST', body: JSON.stringify({ name: form.value.name.trim(), category: form.value.category || null, unit: form.value.unit, minStock: form.value.minStock ? Number(form.value.minStock) : null, batches: [{ quantity: Number(form.value.quantity), unit: form.value.unit }] }) });
    form.value = { name: '', category: '', quantity: '0', unit: 'GRAM', minStock: '' }; showCreate.value = false; await load();
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '保存失败'; } finally { saving.value = false; }
}
async function confirmAdjust() {
  if (!adjustTarget.value || !adjustQuantity.value) return; saving.value = true; conflict.value = '';
  try {
    const { ingredient, batch } = adjustTarget.value;
    await apiRequest(`/ingredients/${ingredient.id}/adjust`, { method: 'POST', body: JSON.stringify({ batchId: batch.id, batchVersion: batch.version, quantity: Number(adjustQuantity.value), unit: batch.unit, changeType: Number(adjustQuantity.value) >= 0 ? 'MANUAL_ADD' : 'MANUAL_DEDUCT' }) });
    adjustTarget.value = null; adjustQuantity.value = ''; await load();
  } catch (reason) { if (reason instanceof ApiRequestError && reason.status === 409) conflict.value = reason.message; else error.value = reason instanceof Error ? reason.message : '调整失败'; } finally { saving.value = false; }
}
async function removeIngredient(ingredient:IngredientDto){if(!window.confirm(`确定删除“${ingredient.name}”吗？可在 30 天内恢复。`))return;try{await apiRequest(`/ingredients/${ingredient.id}`,{method:'DELETE',query:{version:ingredient.version}});await load()}catch(reason){if(reason instanceof ApiRequestError&&reason.status===409)conflict.value=reason.message;else error.value=reason instanceof Error?reason.message:'删除失败'}}
async function loadLogs(){panel.value='logs';try{logs.value=await apiRequest('/inventory/logs',{query:{take:100}})}catch(reason){error.value=reason instanceof Error?reason.message:'日志读取失败'}}
async function loadRecommendations(){panel.value='recommend';saving.value=true;try{const data=await apiRequest<{items:Array<any>}>('/kitchen/recommend',{method:'POST',body:JSON.stringify({mode:recommendMode.value,limit:20})});recommendations.value=data.items}catch(reason){error.value=reason instanceof Error?reason.message:'库存推荐失败'}finally{saving.value=false}}
onMounted(load);
</script>
<template>
  <section class="business-page">
    <header class="business-hero"><div><p class="business-eyebrow">Pantry</p><h1>食材库存</h1><p>{{ ingredients.length }} 种食材，当前批次合计 {{ totalQuantity.toFixed(1) }} 个计量单位。</p></div><AppButton @click="showCreate = !showCreate">{{ showCreate ? '收起' : '新增食材' }}</AppButton></header>
    <div class="business-toolbar app-card"><AppButton variant="secondary" @click="panel=null">库存批次</AppButton><AppButton variant="secondary" @click="loadLogs">库存日志</AppButton><label class="app-field"><span class="app-field__label">库存推荐模式</span><select v-model="recommendMode"><option value="ONLY_INVENTORY">只用现有库存</option><option value="ALLOW_PURCHASE">允许补购</option><option value="MUST_CONSUME">优先消耗</option></select></label><AppButton :loading="saving" @click="loadRecommendations">生成库存推荐</AppButton></div>
    <section v-if="panel==='logs'" class="app-card"><h2>库存变更日志</h2><AppEmptyState v-if="!logs.length" title="暂无库存日志" description="补库、手动调整和做饭扣减都会留下记录。"/><div v-else class="business-list"><p v-for="entry in logs" :key="entry.id"><strong>{{entry.ingredientNameSnapshot}}</strong> · {{entry.changeType}} · {{entry.changeQuantity}} {{entry.unit}} · {{new Date(entry.createdAt).toLocaleString()}}</p></div></section>
    <section v-if="panel==='recommend'" class="app-card"><h2>库存推荐结果</h2><AppEmptyState v-if="!recommendations.length" title="没有符合条件的菜谱" description="可调整模式、补充库存或录入厨房工具。"/><div v-else class="business-grid"><article v-for="result in recommendations" :key="result.recipe.id" class="business-card"><h3>{{result.recipe.name}}</h3><p>{{result.completionLabel}} · {{result.reason}}</p><p v-if="result.missingIngredients.length">缺少：{{result.missingIngredients.map((item:any)=>item.name).join('、')}}</p></article></div></section>
    <form v-if="showCreate" class="business-form app-card" @submit.prevent="createIngredient"><AppInput v-model="form.name" label="食材名称" /><AppInput v-model="form.category" label="分类" /><AppInput v-model="form.quantity" label="初始数量" /><label class="app-field"><span class="app-field__label">单位</span><select v-model="form.unit"><option v-for="unit in ['GRAM','KILOGRAM','MILLILITER','LITER','PIECE','BOX','BAG','BOTTLE','CAN','PACK','PORTION','OTHER']" :key="unit">{{ unit }}</option></select></label><AppInput v-model="form.minStock" label="最低库存" /><AppButton type="submit" :loading="saving">保存</AppButton></form>
    <div class="business-toolbar app-card"><AppInput v-model="query" label="搜索库存" @keyup.enter="load" /><AppButton variant="secondary" @click="load">查询</AppButton></div>
    <div v-if="conflict" class="business-conflict" role="alert">{{ conflict }}，请重新加载库存后再调整。 <button type="button" @click="load">重新加载</button></div>
    <AppErrorState v-if="error" title="库存读取失败" :description="error" @retry="load" />
    <div v-else-if="loading" class="business-grid"><AppSkeleton v-for="index in 6" :key="index" height="190px" /></div>
    <AppEmptyState v-else-if="ingredients.length === 0" title="冰箱还是空的" description="录入食材与保质期后，就能开始库存推荐。" />
    <div v-else class="business-grid"><article v-for="ingredient in ingredients" :key="ingredient.id" class="business-card app-card"><div class="business-card__head"><div><h2>{{ ingredient.name }}</h2><p>{{ ingredient.category || '未分类' }} · {{ ingredient.status }}</p></div><strong>{{ ingredient.quantity }} {{ ingredient.unit }}</strong></div><div class="business-batches"><button v-for="batch in ingredient.batches" :key="batch.id" type="button" @click="adjustTarget = { ingredient, batch }"><span>{{ batch.quantity }} {{ batch.unit }}</span><small>{{ batch.expiryDate || '无到期日' }} · 点击调整</small></button></div><div class="business-card__actions"><span>版本 {{ingredient.version}}</span><button type="button" @click="removeIngredient(ingredient)">删除</button></div></article></div>
    <div v-if="adjustTarget" class="business-modal" @click.self="adjustTarget = null"><form class="business-modal__panel app-card" @submit.prevent="confirmAdjust"><h2>调整 {{ adjustTarget.ingredient.name }}</h2><p>当前 {{ adjustTarget.batch.quantity }} {{ adjustTarget.batch.unit }}，负数表示扣减。</p><AppInput v-model="adjustQuantity" label="变化数量" placeholder="例如 200 或 -100" /><div class="business-card__actions"><AppButton variant="ghost" @click="adjustTarget = null">取消</AppButton><AppButton type="submit" :loading="saving">确认调整</AppButton></div></form></div>
  </section>
</template>
