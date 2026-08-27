<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import AppButton from '../components/ui/AppButton.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppTextarea from '../components/ui/AppTextarea.vue';
import { apiRequest, ApiRequestError } from '../services/api';
import { displayLabel } from '../utils/display';
import { finiteInRange, positiveInteger } from '../utils/validation';
const route = useRoute(),
  router = useRouter(),
  id = computed(() => (typeof route.params.id === 'string' ? route.params.id : null)),
  saving = ref(false),
  loading = ref(Boolean(id.value)),
  error = ref(''),
  conflict = ref('');
const form = ref({
  name: '',
  imagePath: null as string | null,
  cookingTimeMinutes: '',
  difficulty: '',
  spicyLevel: '0',
  servings: '1',
  sourceNote: '',
  notes: '',
  favorite: false,
  enabledForRecommendation: true,
  mealTypes: ['DINNER'] as string[],
  mealRoles: ['MAIN'] as string[],
  tags: ''
});
interface IngredientRow {
  ingredientId: string | null;
  name: string;
  quantity: string;
  unit: string;
  optional: boolean;
  isPrimary: boolean;
  search: string;
}
const ingredients = ref<IngredientRow[]>([
    { ingredientId: null, name: '', quantity: '', unit: 'GRAM', optional: false, isPrimary: true, search: '' }
  ]),
  steps = ref([{ content: '', imagePath: null as string | null }]);
const availableTools = ref<Array<{ id: string; name: string }>>([]),
  selectedToolIds = ref<string[]>([]);
const inventoryIngredients = ref<Array<{ id: string; name: string; quantity: number; unit: string }>>([]),
  inventoryError = ref('');
const ready = ref(false),
  dirty = ref(false),
  saved = ref(false);
async function loadInventoryIngredients() {
  try {
    const data = await apiRequest<any>('/ingredients', { query: { search: '', pageSize: 100 } });
    const list = Array.isArray(data) ? data : data.items ?? [];
    inventoryIngredients.value = list.map((item: any) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit
    }));
  } catch (reason) {
    inventoryError.value = reason instanceof Error ? reason.message : '库存食材加载失败';
  }
}
function isKnownInventoryIngredient(id: string): boolean {
  return inventoryIngredients.value.some((item) => item.id === id);
}
function inventoryIngredientOptions(
  row: IngredientRow
): Array<{ id: string; name: string; quantity: number; unit: string }> {
  const term = row.search.trim().toLowerCase();
  const filtered = term
    ? inventoryIngredients.value.filter((item) => item.name.toLowerCase().includes(term))
    : inventoryIngredients.value;
  // 已选中的选项即使被搜索词过滤掉，也要无条件保留在列表中，保证 select 仍能正确显示当前值
  if (row.ingredientId && !filtered.some((item) => item.id === row.ingredientId)) {
    const selected = inventoryIngredients.value.find((item) => item.id === row.ingredientId);
    if (selected) return [...filtered, selected];
  }
  return filtered;
}
function onIngredientSelect(row: IngredientRow, event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value) {
    const item = inventoryIngredients.value.find((candidate) => candidate.id === value);
    row.ingredientId = value;
    if (item) {
      row.name = item.name;
      if (!row.quantity) row.unit = item.unit;
    }
  } else {
    row.ingredientId = null;
  }
}
async function load() {
  try {
    availableTools.value = await apiRequest('/tools');
    await loadInventoryIngredients();
    if (!id.value) return;
    const x = await apiRequest<any>(`/recipes/${id.value}`);
    form.value = {
      name: x.name,
      imagePath: x.imagePath,
      cookingTimeMinutes: String(x.cookingTimeMinutes ?? ''),
      difficulty: x.difficulty ?? '',
      spicyLevel: String(x.spicyLevel ?? 0),
      servings: String(x.servings ?? 1),
      sourceNote: x.sourceNote ?? '',
      notes: x.notes ?? '',
      favorite: x.favorite,
      enabledForRecommendation: x.enabledForRecommendation,
      mealTypes: (x.mealTypes ?? []).map((m: any) => (typeof m === 'string' ? m : m.mealType)),
      mealRoles: (x.mealRoles ?? []).map((m: any) => (typeof m === 'string' ? m : m.mealRole)),
      tags: (x.tags ?? [])
        .map((t: any) => (typeof t === 'string' ? t : (t.tag?.name ?? t.name)))
        .filter(Boolean)
        .join('、')
    };
    ingredients.value = (x.ingredients ?? []).map((v: any) => ({
      ingredientId: v.ingredientId,
      name: v.ingredientNameSnapshot ?? v.ingredientName,
      quantity: String(v.quantity ?? ''),
      unit: v.unit ?? 'GRAM',
      optional: v.optional,
      isPrimary: v.isPrimary,
      search: ''
    }));
    steps.value = (x.steps ?? []).map((v: any) => ({ content: v.content, imagePath: v.imagePath }));
    selectedToolIds.value = (x.tools ?? []).map((v: any) => v.toolId).filter(Boolean);
    (form.value as any).version = x.version;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取失败';
  } finally {
    loading.value = false;
  }
}
function toggleMeal(value: string) {
  form.value.mealTypes = form.value.mealTypes.includes(value)
    ? form.value.mealTypes.filter((x) => x !== value)
    : [...form.value.mealTypes, value];
}
function toggleRole(value: string) {
  form.value.mealRoles = form.value.mealRoles.includes(value)
    ? form.value.mealRoles.filter((x) => x !== value)
    : [...form.value.mealRoles, value];
}
function toggleTool(value: string) {
  selectedToolIds.value = selectedToolIds.value.includes(value)
    ? selectedToolIds.value.filter((x) => x !== value)
    : [...selectedToolIds.value, value];
}
async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const body = new FormData();
  body.append('file', file);
  try {
    const asset = await apiRequest<{ url: string }>('/uploads/images', { method: 'POST', body });
    form.value.imagePath = asset.url;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '上传失败';
  }
}
async function save() {
  if (!form.value.name.trim()) {
    error.value = '请填写菜名';
    return;
  }
  if (form.value.cookingTimeMinutes && !finiteInRange(form.value.cookingTimeMinutes, 0)) {
    error.value = '烹饪分钟必须是大于或等于 0 的数字';
    return;
  }
  if (!positiveInteger(form.value.servings)) {
    error.value = '份数必须是大于或等于 1 的整数';
    return;
  }
  if (!finiteInRange(form.value.spicyLevel, 0, 5)) {
    error.value = '辣度必须是 0 到 5 之间的数字';
    return;
  }
  if (ingredients.value.some((row) => row.quantity && !finiteInRange(row.quantity, 0))) {
    error.value = '食材数量必须是大于或等于 0 的数字';
    return;
  }
  saving.value = true;
  error.value = '';
  conflict.value = '';
  const payload = {
    name: form.value.name,
    imagePath: form.value.imagePath,
    cookingTimeMinutes: form.value.cookingTimeMinutes ? Number(form.value.cookingTimeMinutes) : null,
    difficulty: form.value.difficulty || null,
    spicyLevel: Number(form.value.spicyLevel),
    servings: Number(form.value.servings),
    sourceNote: form.value.sourceNote || null,
    notes: form.value.notes || null,
    favorite: form.value.favorite,
    enabledForRecommendation: form.value.enabledForRecommendation,
    mealTypes: form.value.mealTypes,
    mealRoles: form.value.mealRoles,
    tags: form.value.tags
      .split(/[、,，]/)
      .map((x) => x.trim())
      .filter(Boolean),
    ingredients: ingredients.value
      .filter((x) => x.name.trim())
      .map((x, index) => ({
        ingredientId: x.ingredientId,
        ingredientName: x.name,
        quantity: x.quantity ? Number(x.quantity) : null,
        unit: x.unit,
        optional: x.optional,
        isPrimary: x.isPrimary,
        sortOrder: index
      })),
    steps: steps.value
      .filter((x) => x.content.trim())
      .map((x, index) => ({ stepNo: index + 1, content: x.content, imagePath: x.imagePath })),
    toolIds: selectedToolIds.value.map((toolId) => ({
      toolId,
      name: availableTools.value.find((tool) => tool.id === toolId)?.name ?? '厨房工具',
      required: true
    }))
  };
  try {
    await apiRequest(id.value ? `/recipes/${id.value}` : '/recipes', {
      method: id.value ? 'PUT' : 'POST',
      body: JSON.stringify(id.value ? { ...payload, version: (form.value as any).version } : payload)
    });
    saved.value = true;
    await router.push('/recipes');
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 409) conflict.value = e.message;
    else error.value = e instanceof Error ? e.message : '保存失败';
  } finally {
    saving.value = false;
  }
}
watch(
  [form, ingredients, steps, selectedToolIds],
  () => {
    if (ready.value) dirty.value = true;
  },
  { deep: true }
);
onBeforeRouteLeave(
  () => !dirty.value || saved.value || saving.value || window.confirm('菜谱还有未保存的修改，确定离开吗？')
);
onMounted(async () => {
  await load();
  ready.value = true;
});
</script>
<template>
  <section class="business-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">Recipe editor</p>
        <h1>{{ id ? '编辑菜谱' : '新增菜谱' }}</h1>
        <p>食材、步骤、标签、餐次、菜品角色与必要工具在一个事务中保存；失败时表单内容会保留。</p>
      </div>
      <AppButton :loading="saving" @click="save">保存菜谱</AppButton>
    </header>
    <p v-if="loading">正在读取菜谱…</p>
    <div v-else class="editor-layout">
      <section class="app-card editor-section">
        <h2>基础信息</h2>
        <AppInput v-model="form.name" label="菜名" />
        <div class="editor-row">
          <AppInput v-model="form.cookingTimeMinutes" label="烹饪分钟" /><AppInput
            v-model="form.servings"
            label="份数"
          /><AppInput v-model="form.difficulty" label="难度" /><AppInput v-model="form.spicyLevel" label="辣度 0-5" />
        </div>
        <AppInput v-model="form.tags" label="标签" placeholder="家常、快手" /><AppTextarea
          v-model="form.sourceNote"
          label="来源说明"
        /><AppTextarea v-model="form.notes" label="备注" /><label class="app-field"
          ><span class="app-field__label">菜谱图片（JPG/PNG/WEBP，≤8MB）</span
          ><input type="file" accept="image/jpeg,image/png,image/webp" @change="upload" /></label
        ><img v-if="form.imagePath" :src="form.imagePath" alt="菜谱预览" class="editor-image" />
        <h3>适用餐次</h3>
        <div class="editor-checks">
          <label v-for="meal in ['BREAKFAST', 'LUNCH', 'DINNER', 'AFTERNOON_TEA', 'SOUP']" :key="meal"
            ><input type="checkbox" :checked="form.mealTypes.includes(meal)" @change="toggleMeal(meal)" />{{
              displayLabel(meal)
            }}</label
          >
        </div>
        <h3>套餐角色</h3>
        <div class="editor-checks">
          <label v-for="role in ['MAIN', 'SIDE', 'STAPLE', 'SOUP', 'DRINK']" :key="role"
            ><input type="checkbox" :checked="form.mealRoles.includes(role)" @change="toggleRole(role)" />{{
              displayLabel(role)
            }}</label
          ><label><input v-model="form.enabledForRecommendation" type="checkbox" />参与推荐</label>
        </div>
        <h3>必要工具</h3>
        <div class="editor-checks">
          <label v-for="tool in availableTools" :key="tool.id"
            ><input type="checkbox" :checked="selectedToolIds.includes(tool.id)" @change="toggleTool(tool.id)" />{{
              tool.name
            }}</label
          ><span v-if="!availableTools.length">尚未录入厨房工具</span>
        </div>
      </section>
      <section class="app-card editor-section">
        <div class="business-card__head">
          <h2>结构化食材</h2>
          <AppButton
            size="sm"
            variant="secondary"
            @click="
              ingredients.push({
                ingredientId: null,
                name: '',
                quantity: '',
                unit: 'GRAM',
                optional: false,
                isPrimary: false,
                search: ''
              })
            "
            >添加一行</AppButton
          >
        </div>
        <div v-for="(row, index) in ingredients" :key="index" class="ingredient-row">
          <AppInput v-model="row.name" label="食材" /><label class="app-field"
            ><span class="app-field__label">库存食材</span
            ><input
              v-model="row.search"
              type="search"
              class="ingredient-search"
              placeholder="搜索食材名称…"
              aria-label="搜索库存食材"
            /><select :value="row.ingredientId ?? ''" @change="onIngredientSelect(row, $event)">
              <option value="">手动输入（未关联库存食材）</option>
              <option
                v-if="row.ingredientId && !isKnownInventoryIngredient(row.ingredientId)"
                :value="row.ingredientId"
                disabled
              >
                原关联食材已删除，请重新选择
              </option>
              <option v-for="item in inventoryIngredientOptions(row)" :key="item.id" :value="item.id">
                {{ item.name }}（{{ item.quantity }} {{ displayLabel(item.unit) }}）
              </option>
            </select></label
          ><AppInput v-model="row.quantity" label="数量" /><label class="app-field"
            ><span class="app-field__label">单位</span
            ><select v-model="row.unit">
              <option
                v-for="unit in [
                  'GRAM',
                  'KILOGRAM',
                  'MILLILITER',
                  'LITER',
                  'PIECE',
                  'BOX',
                  'BAG',
                  'BOTTLE',
                  'CAN',
                  'PACK',
                  'PORTION',
                  'OTHER'
                ]"
                :key="unit"
                :value="unit"
              >
                {{ displayLabel(unit) }}
              </option>
            </select></label
          ><label><input v-model="row.optional" type="checkbox" />可选</label
          ><button class="text-button" type="button" @click="ingredients.splice(index, 1)">移除</button
          ><p v-if="row.ingredientId === null" class="ingredient-row__hint"
            >未关联库存食材（做饭消耗不会自动扣减库存）</p
          >
        </div>
        <p v-if="inventoryError" class="ingredient-row__hint">{{ inventoryError }}</p>
      </section>
      <section class="app-card editor-section">
        <div class="business-card__head">
          <h2>制作步骤</h2>
          <AppButton size="sm" variant="secondary" @click="steps.push({ content: '', imagePath: null })"
            >添加步骤</AppButton
          >
        </div>
        <div v-for="(step, index) in steps" :key="index" class="step-row">
          <strong>{{ index + 1 }}</strong
          ><AppTextarea v-model="step.content" :label="`步骤 ${index + 1}`" /><button
            class="text-button"
            type="button"
            @click="steps.splice(index, 1)"
          >
            移除
          </button>
        </div>
      </section>
    </div>
    <p v-if="conflict" class="business-conflict">{{ conflict }}，请复制当前内容后重新加载最新版本。</p>
    <p v-if="error" class="business-error">{{ error }}</p>
  </section>
</template>
<style scoped>
.editor-layout,
.editor-section {
  display: grid;
  gap: var(--space-4);
}
.editor-section h2 {
  margin: 0;
}
.editor-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-3);
}
.editor-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}
.ingredient-row {
  display: grid;
  grid-template-columns: 1.5fr 1.5fr 1fr 1fr auto auto;
  align-items: end;
  gap: 10px;
}
.ingredient-row__hint {
  grid-column: 1 / -1;
  align-self: start;
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
.step-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--space-3);
}
.editor-image {
  max-width: 280px;
  max-height: 180px;
  object-fit: cover;
  border-radius: var(--radius-input);
}
@media (max-width: 1023px) {
  .editor-row,
  .ingredient-row {
    grid-template-columns: 1fr 1fr;
  }
  .ingredient-row .app-field:first-child {
    grid-column: 1/-1;
  }
  .step-row {
    grid-template-columns: auto 1fr;
  }
  .step-row button {
    grid-column: 2;
  }
}
</style>
<style scoped>
@media (max-width: 1023px) {
  .business-hero {
    position: sticky;
    z-index: var(--z-header);
    top: 0;
    align-items: center;
    padding: var(--space-3) 14px;
    background: rgba(255, 248, 250, 0.96);
    backdrop-filter: blur(12px);
  }
  .business-hero p {
    display: none;
  }
  .editor-row,
  .ingredient-row,
  .step-row {
    grid-template-columns: 1fr;
  }
  .ingredient-row .app-field:first-child,
  .step-row button {
    grid-column: auto;
  }
  .ingredient-row,
  .step-row {
    padding: 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-input);
    background: #fffafb;
  }
  .editor-checks {
    gap: 10px;
  }
  .editor-checks label {
    padding: 7px 9px;
    border-radius: 9px;
    background: #fff5f7;
  }
}
</style>
