<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { ConsumptionPreviewDto } from '../../../shared/types';
import AppButton from '../components/ui/AppButton.vue';
import AppDialog from '../components/ui/AppDialog.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog.vue';
import { apiRequest, ApiRequestError } from '../services/api';
import { displayLabel } from '../utils/display';
import { finiteInRange, isIsoDate } from '../utils/validation';
interface RecordItem {
  id: string;
  customName: string | null;
  recipe?: { name: string } | null;
  store?: { name: string } | null;
}
interface MealRecord {
  id: string;
  recordDate: string;
  recordTime: string | null;
  mealType: string;
  sourceType: string;
  status: string;
  rating: number | null;
  favorite: boolean;
  notes: string | null;
  version: number;
  items: RecordItem[];
}
const records = ref<MealRecord[]>([]),
  loading = ref(true),
  saving = ref(false),
  error = ref(''),
  conflict = ref(''),
  showForm = ref(false),
  status = ref('');
const route = useRoute(),
  pendingDelete = ref<MealRecord | null>(null);
const recipes = ref<Array<{ id: string; name: string }>>([]),
  stores = ref<Array<{ id: string; name: string }>>([]),
  diners = ref<Array<{ id: string; name: string }>>([]),
  selectedRecipeIds = ref<string[]>([]),
  selectedStoreIds = ref<string[]>([]),
  selectedDinerIds = ref<string[]>([]);
const preview = ref<ConsumptionPreviewDto | null>(null),
  previewRecord = ref<MealRecord | null>(null),
  selections = ref<Record<string, string[]>>({});
const form = ref({
  recordDate: new Date().toLocaleDateString('sv-SE'),
  mealType: 'DINNER',
  sourceType: 'HOMEMADE',
  customName: '',
  rating: '',
  notes: ''
});
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [recordData, recipeData, storeData, dinerData] = await Promise.all([
      apiRequest<MealRecord[]>('/records', { query: { status: status.value || undefined } }),
      apiRequest<any>('/recipes', { query: { pageSize: 100 } }),
      apiRequest<any>('/stores', { query: { pageSize: 100 } }),
      apiRequest<any>('/diners', { query: { pageSize: 100, active: true } })
    ]);
    records.value = recordData;
    recipes.value = recipeData.items ?? recipeData;
    stores.value = storeData.items ?? storeData;
    diners.value = dinerData.items ?? dinerData;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}
function toggle(kind: 'recipe' | 'store' | 'diner', id: string) {
  const target = kind === 'recipe' ? selectedRecipeIds : kind === 'store' ? selectedStoreIds : selectedDinerIds;
  target.value = target.value.includes(id) ? target.value.filter((value) => value !== id) : [...target.value, id];
}
async function createRecord() {
  if (!isIsoDate(form.value.recordDate)) {
    error.value = '请选择合法日期';
    return;
  }
  if (form.value.rating && !finiteInRange(form.value.rating, 0, 5)) {
    error.value = '评分必须在 0–5 之间';
    return;
  }
  const custom = form.value.customName
    .split(/[、,，]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const items = [
    ...selectedRecipeIds.value.map((recipeId) => ({ itemType: 'RECIPE', recipeId, mealRole: 'MAIN' })),
    ...selectedStoreIds.value.map((storeId) => ({ itemType: 'STORE', storeId, mealRole: 'MAIN' })),
    ...custom.map((customName) => ({ itemType: 'CUSTOM', customName, mealRole: 'SIDE' }))
  ].map((item, sortOrder) => ({ ...item, sortOrder }));
  if (!items.length) {
    error.value = '请至少选择或填写一个饮食项目';
    return;
  }
  saving.value = true;
  try {
    await apiRequest('/records', {
      method: 'POST',
      body: JSON.stringify({
        recordDate: form.value.recordDate,
        mealType: form.value.mealType,
        sourceType: form.value.sourceType,
        status: 'CONFIRMED',
        rating: form.value.rating ? Number(form.value.rating) : null,
        notes: form.value.notes || null,
        items,
        dinerIds: selectedDinerIds.value
      })
    });
    showForm.value = false;
    form.value.customName = '';
    selectedRecipeIds.value = [];
    selectedStoreIds.value = [];
    selectedDinerIds.value = [];
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败';
  } finally {
    saving.value = false;
  }
}
function removeRecord(record: MealRecord) {
  pendingDelete.value = record;
}
async function confirmRemove() {
  const record = pendingDelete.value;
  if (!record) return;
  saving.value = true;
  try {
    await apiRequest(`/records/${record.id}`, { method: 'DELETE', query: { version: record.version } });
    pendingDelete.value = null;
    await load();
  } catch (e) {
    handle(e);
  } finally {
    saving.value = false;
  }
}
async function openPreview(record: MealRecord, chosen: Record<string, string[]> = {}) {
  conflict.value = '';
  saving.value = true;
  try {
    preview.value = await apiRequest(`/records/${record.id}/consumption-preview`, {
      method: 'POST',
      body: JSON.stringify({ recordVersion: record.version, selections: chosen })
    });
    previewRecord.value = record;
    selections.value = chosen;
  } catch (e) {
    handle(e);
  } finally {
    saving.value = false;
  }
}
async function useSuggestedBatches() {
  if (!preview.value || !previewRecord.value) return;
  const chosen = Object.fromEntries(
    preview.value.items
      .filter((x) => x.requiresManualSelection)
      .map((x) => [x.recipeIngredientId, x.allocations.map((a) => a.batchId)])
  );
  await openPreview(previewRecord.value, chosen);
}
function toggleBatch(recipeIngredientId: string, batchId: string) {
  const current = selections.value[recipeIngredientId] ?? [];
  selections.value = {
    ...selections.value,
    [recipeIngredientId]: current.includes(batchId) ? current.filter((id) => id !== batchId) : [...current, batchId]
  };
}
function closePreview() {
  preview.value = null;
  previewRecord.value = null;
  selections.value = {};
}
async function applyBatchSelections() {
  if (previewRecord.value) await openPreview(previewRecord.value, selections.value);
}
async function confirmConsumption() {
  if (!preview.value || !previewRecord.value) return;
  saving.value = true;
  try {
    await apiRequest(`/records/${previewRecord.value.id}/confirm-consumption`, {
      method: 'POST',
      body: JSON.stringify({
        recordVersion: preview.value.recordVersion,
        previewToken: preview.value.previewToken,
        operationId: crypto.randomUUID(),
        selections: selections.value
      })
    });
    closePreview();
    await load();
  } catch (e) {
    handle(e);
  } finally {
    saving.value = false;
  }
}
function handle(e: unknown) {
  if (e instanceof ApiRequestError && e.status === 409) conflict.value = e.message;
  else error.value = e instanceof Error ? e.message : '操作失败';
}
onMounted(async () => {
  await load();
  const focus = String(route.query.focus ?? '');
  if (focus) {
    await nextTick();
    document.getElementById(`record-${focus}`)?.scrollIntoView({ block: 'center' });
  }
});
</script>
<template>
  <section class="business-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">Meal journal</p>
        <h1>饮食日记</h1>
        <p>草稿经库存预览与确认后，才会进入正式统计。</p>
      </div>
      <AppButton @click="showForm = !showForm">{{ showForm ? '收起' : '手动记录' }}</AppButton>
    </header>
    <form v-if="showForm" class="business-form app-card" @submit.prevent="createRecord">
      <label class="app-field"
        ><span class="app-field__label">日期</span><input v-model="form.recordDate" type="date" /></label
      ><label class="app-field"
        ><span class="app-field__label">餐次</span
        ><select v-model="form.mealType">
          <option value="BREAKFAST">早餐</option>
          <option value="LUNCH">午餐</option>
          <option value="DINNER">晚餐</option>
          <option value="AFTERNOON_TEA">下午茶</option>
        </select></label
      ><label class="app-field"
        ><span class="app-field__label">来源</span
        ><select v-model="form.sourceType">
          <option value="HOMEMADE">在家做</option>
          <option value="DINE_IN">堂食</option>
          <option value="TAKEOUT">外卖</option>
          <option value="CUSTOM">其他</option>
        </select></label
      ><AppInput v-model="form.customName" label="自定义项目" placeholder="多个项目用顿号分隔" />
      <div class="record-options">
        <fieldset>
          <legend>菜谱（可多选）</legend>
          <label v-for="recipe in recipes" :key="recipe.id"
            ><input
              type="checkbox"
              :checked="selectedRecipeIds.includes(recipe.id)"
              @change="toggle('recipe', recipe.id)"
            />{{ recipe.name }}</label
          >
        </fieldset>
        <fieldset>
          <legend>店铺（可多选）</legend>
          <label v-for="store in stores" :key="store.id"
            ><input
              type="checkbox"
              :checked="selectedStoreIds.includes(store.id)"
              @change="toggle('store', store.id)"
            />{{ store.name }}</label
          >
        </fieldset>
        <fieldset>
          <legend>食用者</legend>
          <label v-for="diner in diners" :key="diner.id"
            ><input
              type="checkbox"
              :checked="selectedDinerIds.includes(diner.id)"
              @change="toggle('diner', diner.id)"
            />{{ diner.name }}</label
          >
        </fieldset>
      </div>
      <AppInput v-model="form.rating" label="评分 0-5" /><AppInput v-model="form.notes" label="备注" /><AppButton
        type="submit"
        :loading="saving"
        >保存记录</AppButton
      >
    </form>
    <div class="business-toolbar app-card">
      <label class="app-field"
        ><span class="app-field__label">状态</span
        ><select v-model="status" @change="load">
          <option value="">全部</option>
          <option value="DRAFT">草稿</option>
          <option value="CONFIRMED">已确认</option>
        </select></label
      >
    </div>
    <div v-if="conflict" class="business-conflict" role="alert">{{ conflict }} <button class="text-button" @click="load">重新加载</button></div>
    <AppErrorState v-if="error" title="记录读取失败" :description="error" @retry="load" />
    <div v-else-if="loading" class="business-grid"><AppSkeleton v-for="index in 6" :key="index" height="170px" /></div>
    <AppEmptyState v-else-if="!records.length" title="还没有饮食记录" description="完成计划或手动记录一餐。" />
    <div v-else class="business-grid">
      <article
        v-for="record in records"
        :id="`record-${record.id}`"
        :key="record.id"
        class="business-card app-card"
        :class="{ 'business-card--focused': route.query.focus === record.id }"
      >
        <div>
          <div class="business-card__head">
            <div>
              <h2>{{ record.recordDate }} · {{ displayLabel(record.mealType) }}</h2>
              <p>
                {{ displayLabel(record.sourceType) }} · {{ displayLabel(record.status)
                }}{{ record.rating !== null ? ` · ${record.rating} 分` : '' }}
              </p>
            </div>
            <span>{{ record.favorite ? '♥' : '♡' }}</span>
          </div>
          <p>
            {{
              record.items
                .map((x) => x.recipe?.name || x.store?.name || x.customName)
                .filter(Boolean)
                .join('、') ||
              record.notes ||
              '暂无项目'
            }}
          </p>
        </div>
        <div class="business-card__actions">
          <button class="text-button" type="button" @click="removeRecord(record)">删除</button
          ><AppButton v-if="record.status === 'DRAFT'" size="sm" :loading="saving" @click="openPreview(record)"
            >预览并确认</AppButton
          >
        </div>
      </article>
    </div>
    <AppDialog
      :model-value="Boolean(preview)"
      title="库存扣减预览"
      dialog-class="consumption-panel"
      @update:model-value="
        (value) => {
          if (!value) closePreview();
        }
      "
    >
      <section v-if="preview" class="consumption-content">
        <p>预览不会修改库存；确认后库存、日志、缺料购物与日记状态会在同一事务更新。</p>
        <div class="consumption-items">
          <article v-for="row in preview.items" :key="row.recipeIngredientId">
            <strong>{{ row.ingredientName }}</strong
            ><span>需要 {{ row.requiredQuantity }} {{ displayLabel(row.unit) }}</span
            ><span>将扣 {{ row.allocations.reduce((n, x) => n + x.quantity, 0) }}；缺少 {{ row.shortageQuantity }}</span
            ><em v-if="row.requiresManualSelection">有多个批次，请选择后重新计算预览</em>
            <div v-if="row.availableBatches.length > 1" class="batch-choices">
              <label v-for="batch in row.availableBatches" :key="batch.batchId"
                ><input
                  type="checkbox"
                  :checked="(selections[row.recipeIngredientId] ?? []).includes(batch.batchId)"
                  @change="toggleBatch(row.recipeIngredientId, batch.batchId)"
                />
                {{ batch.availableQuantity }} {{ displayLabel(batch.unit)
                }}{{ batch.expiryDate ? ` · 到期 ${batch.expiryDate}` : ''
                }}{{ batch.location ? ` · ${batch.location}` : '' }}</label
              >
            </div>
          </article>
        </div>
        <div class="business-card__actions">
          <AppButton variant="ghost" @click="closePreview">取消</AppButton
          ><AppButton
            v-if="preview.items.some((x) => x.requiresManualSelection)"
            variant="secondary"
            @click="useSuggestedBatches"
            >采用建议批次</AppButton
          ><AppButton
            v-if="preview.items.some((x) => x.availableBatches.length > 1)"
            variant="secondary"
            @click="applyBatchSelections"
            >按选择重新预览</AppButton
          ><AppButton
            v-if="!preview.items.some((x) => x.requiresManualSelection)"
            :loading="saving"
            @click="confirmConsumption"
            >确认扣减并完成</AppButton
          >
        </div>
      </section>
    </AppDialog>
    <ConfirmDeleteDialog
      :model-value="Boolean(pendingDelete)"
      item-name="这条饮食记录"
      :loading="saving"
      @update:model-value="
        (value) => {
          if (!value) pendingDelete = null;
        }
      "
      @confirm="confirmRemove"
    />
  </section>
</template>
<style scoped>
.consumption-content {
  display: grid;
  gap: var(--space-4);
}
.consumption-content p {
  margin: 0;
}
.record-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}
.record-options fieldset {
  display: grid;
  align-content: start;
  gap: 6px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
}
.record-options label {
  font-size: 13px;
}
.consumption-items {
  display: grid;
  gap: var(--space-2);
}
.consumption-items article {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--space-1) var(--space-3);
  padding: var(--space-3);
  border-radius: 12px;
  background: #fff7f9;
}
.consumption-items em,
.batch-choices {
  grid-column: 1/-1;
}
.consumption-items em {
  color: var(--color-danger);
  font-size: 12px;
}
.batch-choices {
  display: grid;
  gap: 6px;
  padding-top: 6px;
}
.batch-choices label {
  font-size: 13px;
}
@media (max-width: 1023px) {
  .record-options {
    grid-template-columns: 1fr;
  }
}
</style>
