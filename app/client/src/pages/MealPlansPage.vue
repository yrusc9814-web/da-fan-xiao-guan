<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppButton from '../components/ui/AppButton.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import { apiRequest, ApiRequestError } from '../services/api';
import { displayLabel } from '../utils/display';
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
    recipe?: { name: string } | null;
    store?: { name: string } | null;
  }>;
}
const plans = ref<Plan[]>([]),
  loading = ref(true),
  saving = ref(false),
  error = ref(''),
  conflict = ref(''),
  showForm = ref(false);
const recipes = ref<Array<{ id: string; name: string }>>([]),
  stores = ref<Array<{ id: string; name: string }>>([]),
  diners = ref<Array<{ id: string; name: string }>>([]),
  selectedRecipeIds = ref<string[]>([]),
  selectedStoreIds = ref<string[]>([]),
  selectedDinerIds = ref<string[]>([]);
const today = new Date().toLocaleDateString('sv-SE');
const form = ref({ planDate: today, mealType: 'DINNER', dinerCount: '1', customName: '', notes: '' });
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [planData, recipeData, storeData, dinerData] = await Promise.all([
      apiRequest<Plan[]>('/plans', { query: { from: '2000-01-01', to: '2100-12-31' } }),
      apiRequest<any>('/recipes', { query: { pageSize: 100 } }),
      apiRequest<any>('/stores', { query: { pageSize: 100 } }),
      apiRequest<any>('/diners', { query: { pageSize: 100, active: true } })
    ]);
    plans.value = planData;
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
  try {
    await apiRequest(`/plans/${plan.id}/${type}`, { method: 'POST', body: JSON.stringify({ version: plan.version }) });
    await load();
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 409) conflict.value = e.message;
    else error.value = e instanceof Error ? e.message : '操作失败';
  }
}
onMounted(load);
</script>
<template>
  <section class="business-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">Meal planner</p>
        <h1>饮食计划</h1>
        <p>一餐可包含多道菜、店铺和自定义项目；完成后原子生成日记草稿。</p>
      </div>
      <AppButton @click="showForm = !showForm">{{ showForm ? '收起' : '安排一餐' }}</AppButton>
    </header>
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
          <label v-for="recipe in recipes" :key="recipe.id"
            ><input
              type="checkbox"
              :checked="selectedRecipeIds.includes(recipe.id)"
              @change="toggle('recipe', recipe.id)"
            />{{ recipe.name }}</label
          >
        </fieldset>
        <fieldset>
          <legend>从店铺添加（可多选）</legend>
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
      <AppInput v-model="form.notes" label="备注" /><AppButton type="submit" :loading="saving">保存计划</AppButton>
    </form>
    <div v-if="conflict" class="business-conflict">{{ conflict }} <button @click="load">重新加载</button></div>
    <AppErrorState v-if="error" title="计划读取失败" :description="error" @retry="load" />
    <div v-else-if="loading" class="business-grid">
      <AppSkeleton v-for="index in 6" :key="index" height="160px" />
    </div>
    <AppEmptyState v-else-if="!plans.length" title="还没有安排" description="从今天的一顿饭开始。" />
    <div v-else class="business-grid">
      <article v-for="plan in plans" :key="plan.id" class="business-card app-card">
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
          <button @click="action(plan, 'cancel')">取消计划</button
          ><AppButton size="sm" @click="action(plan, 'complete')">完成并生成草稿</AppButton>
        </div>
      </article>
    </div>
  </section>
</template>
<style scoped>
.plan-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
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
@media (max-width: 760px) {
  .plan-options {
    grid-template-columns: 1fr;
  }
}
</style>
