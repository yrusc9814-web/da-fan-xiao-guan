<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
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
import { debounce } from '../utils/debounce';
import { createRequestSequence } from '../utils/request-sequence';
import { itemsFrom, withSelected } from '../utils/selector-options';
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
  loadingMore = ref(false),
  saving = ref(false),
  error = ref(''),
  conflict = ref(''),
  showForm = ref(false),
  status = ref('');
const page = ref(1),
  pageSize = 20,
  total = ref(0);
const recordsSequence = createRequestSequence();
const recipeSearchSequence = createRequestSequence();
const storeSearchSequence = createRequestSequence();
const dinerSearchSequence = createRequestSequence();
const hasMore = computed(() => records.value.length < total.value);
const route = useRoute(),
  pendingDelete = ref<MealRecord | null>(null);
const recipes = ref<Array<{ id: string; name: string }>>([]),
  stores = ref<Array<{ id: string; name: string }>>([]),
  diners = ref<Array<{ id: string; name: string }>>([]),
  recipeCache = ref<Array<{ id: string; name: string }>>([]),
  storeCache = ref<Array<{ id: string; name: string }>>([]),
  dinerCache = ref<Array<{ id: string; name: string }>>([]),
  recipeSearch = ref(''),
  storeSearch = ref(''),
  dinerSearch = ref(''),
  selectedRecipeIds = ref<string[]>([]),
  selectedStoreIds = ref<string[]>([]),
  selectedDinerIds = ref<string[]>([]);
const visibleRecipes = computed(() => withSelected(recipes.value, selectedRecipeIds.value, recipeCache.value));
const visibleStores = computed(() => withSelected(stores.value, selectedStoreIds.value, storeCache.value));
const visibleDiners = computed(() => withSelected(diners.value, selectedDinerIds.value, dinerCache.value));
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
async function loadCatalog(kind: 'recipes' | 'stores' | 'diners', search: string) {
  const sequence =
    kind === 'recipes'
      ? recipeSearchSequence.next()
      : kind === 'stores'
        ? storeSearchSequence.next()
        : dinerSearchSequence.next();
  const query =
    kind === 'diners'
      ? { search: search.trim() || undefined, pageSize: 20, active: true }
      : { search: search.trim() || undefined, pageSize: 20 };
  const data = await apiRequest<unknown>(`/${kind}`, { query });
  const current =
    kind === 'recipes'
      ? recipeSearchSequence.isCurrent(sequence)
      : kind === 'stores'
        ? storeSearchSequence.isCurrent(sequence)
        : dinerSearchSequence.isCurrent(sequence);
  if (!current) return;
  const items = itemsFrom<{ id: string; name: string }>(data);
  if (kind === 'recipes') {
    recipes.value = items;
    recipeCache.value = withSelected(items, selectedRecipeIds.value, recipeCache.value);
  } else if (kind === 'stores') {
    stores.value = items;
    storeCache.value = withSelected(items, selectedStoreIds.value, storeCache.value);
  } else {
    diners.value = items;
    dinerCache.value = withSelected(items, selectedDinerIds.value, dinerCache.value);
  }
}
async function load(reset = true, requestedPage?: number) {
  if (reset) page.value = 1;
  // 追加页先按 targetPage 请求，成功后才把页码提交进 page：失败时 page 原地不动，
  // 下一次“加载更多”仍重试同一页，不会跳页。
  const targetPage = requestedPage ?? page.value;
  const sequence = recordsSequence.next();
  if (reset) loading.value = true;
  else loadingMore.value = true;
  error.value = '';
  try {
    const [recordData] = await Promise.all([
      apiRequest<{ items: MealRecord[]; total: number }>('/records', {
        query: { status: status.value || undefined, page: targetPage, pageSize }
      }),
      reset
        ? Promise.all([
            loadCatalog('recipes', recipeSearch.value),
            loadCatalog('stores', storeSearch.value),
            loadCatalog('diners', dinerSearch.value)
          ])
        : Promise.resolve()
    ]);
    if (!recordsSequence.isCurrent(sequence)) return false;
    records.value = reset ? recordData.items : [...records.value, ...recordData.items];
    total.value = recordData.total;
    page.value = targetPage;
    return true;
  } catch (e) {
    if (!recordsSequence.isCurrent(sequence)) return false;
    // 追加页失败不弹全局错误：保留已加载列表与“加载更多”按钮，用户可直接再次点击重试
    if (reset) error.value = e instanceof Error ? e.message : '加载失败';
    return false;
  } finally {
    if (recordsSequence.isCurrent(sequence)) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}
async function loadMore() {
  if (!hasMore.value || loading.value || loadingMore.value) return false;
  return load(false, page.value + 1);
}
function rememberSelection(source: Array<{ id: string; name: string }>, cache: typeof recipeCache, id: string) {
  const item = source.find((entry) => entry.id === id);
  if (item && !cache.value.some((entry) => entry.id === id)) cache.value = [...cache.value, item];
}
function toggle(kind: 'recipe' | 'store' | 'diner', id: string) {
  const target = kind === 'recipe' ? selectedRecipeIds : kind === 'store' ? selectedStoreIds : selectedDinerIds;
  const adding = !target.value.includes(id);
  target.value = adding ? [...target.value, id] : target.value.filter((value) => value !== id);
  if (adding) {
    if (kind === 'recipe') rememberSelection(recipes.value, recipeCache, id);
    else if (kind === 'store') rememberSelection(stores.value, storeCache, id);
    else rememberSelection(diners.value, dinerCache, id);
  }
}
const searchRecipes = debounce(() => {
  void loadCatalog('recipes', recipeSearch.value).catch(() => undefined);
}, 250);
const searchStores = debounce(() => {
  void loadCatalog('stores', storeSearch.value).catch(() => undefined);
}, 250);
const searchDiners = debounce(() => {
  void loadCatalog('diners', dinerSearch.value).catch(() => undefined);
}, 250);
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
  while (focus && !records.value.some((record) => record.id === focus) && hasMore.value) {
    // 追加失败（页码不再前进）时必须终止，否则会带着同一页无限重试
    if (!(await loadMore())) break;
  }
  if (focus) {
    await nextTick();
    document.getElementById(`record-${focus}`)?.scrollIntoView({ block: 'center' });
  }
});
onUnmounted(() => {
  recordsSequence.next();
  searchRecipes.cancel();
  searchStores.cancel();
  searchDiners.cancel();
});
</script>
<template>
  <section class="business-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">Meal journal</p>
        <h1>饮食日记</h1>
        <p>待完成的餐次完成记录后会计入统计。</p>
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
          <AppInput v-model="recipeSearch" label="搜索菜谱" @update:model-value="searchRecipes" />
          <label v-for="recipe in visibleRecipes" :key="recipe.id"
            ><input
              type="checkbox"
              :checked="selectedRecipeIds.includes(recipe.id)"
              @change="toggle('recipe', recipe.id)"
            />{{ recipe.name }}</label
          >
        </fieldset>
        <fieldset>
          <legend>店铺（可多选）</legend>
          <AppInput v-model="storeSearch" label="搜索店铺" @update:model-value="searchStores" />
          <label v-for="store in visibleStores" :key="store.id"
            ><input
              type="checkbox"
              :checked="selectedStoreIds.includes(store.id)"
              @change="toggle('store', store.id)"
            />{{ store.name }}</label
          >
        </fieldset>
        <fieldset>
          <legend>食用者</legend>
          <AppInput v-model="dinerSearch" label="搜索食用者" @update:model-value="searchDiners" />
          <label v-for="diner in visibleDiners" :key="diner.id"
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
        ><select v-model="status" @change="() => load(true)">
          <option value="">全部</option>
          <option value="DRAFT">待完成</option>
          <option value="CONFIRMED">已记录</option>
        </select></label
      >
    </div>
    <div v-if="conflict" class="business-conflict" role="alert">
      {{ conflict }} <button class="text-button" @click="() => load(true)">重新加载</button>
    </div>
    <AppErrorState v-if="error" title="记录读取失败" :description="error" @retry="() => load(true)" />
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
      <div v-if="hasMore" class="business-card__actions">
        <AppButton variant="secondary" :loading="loadingMore" @click="loadMore">加载更多</AppButton>
      </div>
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
        <p>预览不会修改库存；确认后库存扣减、缺料购物清单与记录状态会在同一事务更新。</p>
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
