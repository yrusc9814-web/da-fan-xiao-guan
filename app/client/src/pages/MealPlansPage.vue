<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppButton from '../components/ui/AppButton.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import { apiRequest, ApiRequestError } from '../services/api';
import { monthRange, parseLocalIsoDate, toLocalIsoDate } from '../utils/calendar';
import { debounce } from '../utils/debounce';
import { displayLabel } from '../utils/display';
import { createRequestSequence } from '../utils/request-sequence';
import { itemsFrom, withSelected } from '../utils/selector-options';
import { isIsoDate, positiveInteger } from '../utils/validation';

interface Plan {
  id: string;
  planDate: string;
  mealType: string;
  dinerCount: number;
  status: string;
  notes: string | null;
  version: number;
  items: Array<{
    id: string;
    customName: string | null;
    recipe?: { id: string; name: string } | null;
    store?: { name: string } | null;
  }>;
}
interface CompletePlanResult {
  pendingDraftRecordId?: string;
}
const plans = ref<Plan[]>([]),
  loading = ref(true),
  saving = ref(false),
  error = ref(''),
  conflict = ref(''),
  showForm = ref(false);
// UXB-003：完成计划后指向刚生成的「待完成」记录，引导确认库存扣减（无 DRAFT 术语）
const completedDraftLink = ref('');
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
const route = useRoute();
const today = toLocalIsoDate(new Date());
const selectedDate = computed(() => {
  const raw = Array.isArray(route.query.date) ? route.query.date[0] : route.query.date;
  return typeof raw === 'string' && isIsoDate(raw) && parseLocalIsoDate(raw) ? raw : today;
});
const selectedMonth = computed(() => {
  const date = parseLocalIsoDate(selectedDate.value) ?? new Date();
  return monthRange(date.getFullYear(), date.getMonth());
});
const form = ref({ planDate: selectedDate.value, mealType: 'DINNER', dinerCount: '1', customName: '', notes: '' });
const catalogsLoaded = ref(false);
let loadedMonthKey = '';
let plansRequestSequence = 0;
let inflightMonthKey = '';
const recipeSearchSequence = createRequestSequence();
const storeSearchSequence = createRequestSequence();
const dinerSearchSequence = createRequestSequence();
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
  const items = itemsFrom<{ id: string; name: string }>(await apiRequest(`/${kind}`, { query }));
  const current =
    kind === 'recipes'
      ? recipeSearchSequence.isCurrent(sequence)
      : kind === 'stores'
        ? storeSearchSequence.isCurrent(sequence)
        : dinerSearchSequence.isCurrent(sequence);
  if (!current) return;
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
async function loadCatalogs() {
  await Promise.all([
    loadCatalog('recipes', recipeSearch.value),
    loadCatalog('stores', storeSearch.value),
    loadCatalog('diners', dinerSearch.value)
  ]);
  catalogsLoaded.value = true;
}
async function loadPlans(force = false) {
  const monthKey = `${selectedMonth.value.start}:${selectedMonth.value.end}`;
  if (!force && (monthKey === loadedMonthKey || monthKey === inflightMonthKey)) return;
  const sequence = ++plansRequestSequence;
  inflightMonthKey = monthKey;
  loading.value = true;
  error.value = '';
  try {
    const planData = await apiRequest<Plan[]>('/plans', {
      query: { from: selectedMonth.value.start, to: selectedMonth.value.end }
    });
    if (sequence !== plansRequestSequence) return;
    plans.value = planData;
    loadedMonthKey = monthKey;
  } catch (e) {
    if (sequence !== plansRequestSequence) return;
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    if (sequence === plansRequestSequence) {
      inflightMonthKey = '';
      loading.value = false;
    }
  }
}
async function load(forcePlans = true) {
  loading.value = true;
  error.value = '';
  try {
    await Promise.all([loadPlans(forcePlans), catalogsLoaded.value ? Promise.resolve() : loadCatalogs()]);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}
async function focusSelectedDate() {
  await nextTick();
  document.querySelector<HTMLElement>(`[data-plan-date="${selectedDate.value}"]`)?.scrollIntoView({ block: 'center' });
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
async function createPlan() {
  if (!isIsoDate(form.value.planDate)) {
    error.value = '请选择合法日期';
    return;
  }
  if (!positiveInteger(form.value.dinerCount)) {
    error.value = '人数必须是大于 0 的整数';
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
    error.value = '请至少选择或填写一个项目';
    return;
  }
  saving.value = true;
  try {
    await apiRequest('/plans', {
      method: 'POST',
      body: JSON.stringify({
        planDate: form.value.planDate,
        mealType: form.value.mealType,
        dinerCount: Number(form.value.dinerCount),
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
async function action(plan: Plan, type: 'complete' | 'cancel') {
  conflict.value = '';
  completedDraftLink.value = '';
  try {
    const data = await apiRequest<CompletePlanResult>(`/plans/${plan.id}/${type}`, {
      method: 'POST',
      body: JSON.stringify({ version: plan.version })
    });
    await load();
    // UXB-003：完成计划后把生成的「待完成」记录链接出来，用户可直接去确认库存
    if (type === 'complete' && data?.pendingDraftRecordId) {
      completedDraftLink.value = data.pendingDraftRecordId;
    }
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 409) conflict.value = e.message;
    else error.value = e instanceof Error ? e.message : '操作失败';
  }
}
watch(
  selectedDate,
  async () => {
    form.value.planDate = selectedDate.value;
    await loadPlans(false);
    await focusSelectedDate();
  },
  { immediate: true }
);
onMounted(() => {
  void loadCatalogs().catch((e) => {
    error.value = e instanceof Error ? e.message : '加载失败';
  });
});
onUnmounted(() => {
  searchRecipes.cancel();
  searchStores.cancel();
  searchDiners.cancel();
});
</script>
<template>
  <section class="business-page" :data-selected-date="selectedDate">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">Meal planner</p>
        <h1>饮食计划</h1>
        <p>一餐可包含多道菜、店铺和自定义项目；吃完后在这里记录这一餐。</p>
      </div>
      <AppButton @click="showForm = !showForm">{{ showForm ? '收起' : '安排一餐' }}</AppButton>
    </header>
    <div v-if="completedDraftLink" class="business-guide" role="status">
      <span>这一餐已生成记录，去核对食材并完成记录：</span>
      <RouterLink :to="{ name: 'records', query: { focus: completedDraftLink } }">去饮食记录确认 →</RouterLink>
    </div>
    <form v-if="showForm" class="business-form app-card" @submit.prevent="createPlan">
      <label class="app-field"
        ><span class="app-field__label">日期</span><input v-model="form.planDate" type="date" /></label
      ><label class="app-field"
        ><span class="app-field__label">餐次</span
        ><select v-model="form.mealType">
          <option value="BREAKFAST">早餐</option>
          <option value="LUNCH">午餐</option>
          <option value="DINNER">晚餐</option>
          <option value="AFTERNOON_TEA">下午茶</option>
        </select></label
      ><AppInput v-model="form.dinerCount" label="人数" /><AppInput
        v-model="form.customName"
        label="自定义项目"
        placeholder="多个项目用顿号分隔"
      />
      <div class="plan-options">
        <fieldset>
          <legend>从菜谱添加（可多选）</legend>
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
          <legend>从店铺添加（可多选）</legend>
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
      <AppInput v-model="form.notes" label="备注" /><AppButton type="submit" :loading="saving">保存计划</AppButton>
    </form>
    <div v-if="conflict" class="business-conflict" role="alert">
      {{ conflict }} <button class="text-button" @click="() => load()">重新加载</button>
    </div>
    <AppErrorState v-if="error" title="计划读取失败" :description="error" @retry="loadPlans" />
    <div v-else-if="loading" class="business-grid">
      <AppSkeleton v-for="index in 6" :key="index" height="160px" />
    </div>
    <AppEmptyState v-else-if="!plans.length" title="还没有安排" description="从今天的一顿饭开始。" />
    <div v-else class="business-grid">
      <article
        v-for="plan in plans"
        :key="plan.id"
        class="business-card app-card"
        :class="{ 'business-card--selected': plan.planDate === selectedDate }"
        :data-plan-date="plan.planDate"
      >
        <div>
          <div class="business-card__head">
            <div>
              <h2>{{ plan.planDate }} · {{ displayLabel(plan.mealType) }}</h2>
              <p>{{ plan.dinerCount }} 人 · {{ displayLabel(plan.status) }}</p>
            </div>
          </div>
          <p>
            {{
              plan.items
                .map((x) => x.recipe?.name || x.store?.name || x.customName)
                .filter(Boolean)
                .join('、') || '暂无项目'
            }}
          </p>
        </div>
        <div v-if="plan.status === 'PLANNED' || plan.status === 'UNPLANNED'" class="business-card__actions">
          <button class="text-button" @click="action(plan, 'cancel')">取消计划</button
          ><AppButton size="sm" @click="action(plan, 'complete')">完成这一餐</AppButton>
        </div>
      </article>
    </div>
  </section>
</template>
<style scoped>
.plan-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}
.plan-options fieldset {
  display: grid;
  align-content: start;
  gap: 6px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
}
.plan-options label {
  font-size: 13px;
}
.business-card--selected {
  outline: 2px solid var(--color-primary);
}
.business-guide {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-4);
  border-radius: 12px;
  background: #eef6ff;
  border: 1px solid #bcd9ff;
  color: #1f4e8c;
  font-size: 14px;
}
.business-guide a {
  color: var(--color-primary-hover);
  font-weight: var(--font-weight-bold);
}
@media (max-width: 1023px) {
  .plan-options {
    grid-template-columns: 1fr;
  }
}
</style>
