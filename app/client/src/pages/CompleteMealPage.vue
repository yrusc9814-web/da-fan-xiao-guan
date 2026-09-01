<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ConsumptionPreviewItemDto, ImmediateMealPreviewDto } from '../../../shared/types';
import CookingView from '../components/CookingView.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import { apiRequest, ApiRequestError } from '../services/api';
import { displayLabel } from '../utils/display';

interface RecipeBrief {
  id: string;
  name: string;
  imagePath: string | null;
  cookingTimeMinutes: number | null;
  difficulty: string | null;
  servings: number | null;
  ingredients: Array<{
    id: string;
    ingredientNameSnapshot: string;
    quantity: number | null;
    unit: string | null;
    optional: boolean;
    ingredientId: string | null;
  }>;
  steps: Array<{ id: string; stepNo: number; content: string }>;
  tools: Array<{ id: string; toolNameSnapshot: string; required: boolean }>;
}

type PageState = 'prompt' | 'loading' | 'error' | 'preview' | 'success';

const route = useRoute();
const router = useRouter();
const recipeId = computed(() => String(route.query.recipeId ?? ''));
const recipe = ref<RecipeBrief | null>(null);
const pageState = ref<PageState>('prompt');
const loading = ref(false);
const pageError = ref('');
const preview = ref<ImmediateMealPreviewDto | null>(null);
const successMessage = ref('');
const cookingOpen = ref(false);

// Form fields with auto-detected defaults
const mealType = ref(inferMealType());
const sourceType = ref('HOMEMADE');
const notes = ref('');
const usedSelections = ref<Record<string, string[]>>({});

function inferMealType(): string {
  const hour = new Date().getHours();
  if (hour < 11) return 'BREAKFAST';
  if (hour < 14) return 'LUNCH';
  if (hour < 17) return 'AFTERNOON_TEA';
  return 'DINNER';
}

function hasStructuredIngredients(): boolean {
  if (!recipe.value) return false;
  return recipe.value.ingredients.some((ing) => ing.quantity != null && ing.unit != null);
}

async function loadRecipe(): Promise<void> {
  if (!recipeId.value) {
    pageError.value = '请从菜谱详情页进入';
    pageState.value = 'error';
    return;
  }
  loading.value = true;
  try {
    recipe.value = await apiRequest<RecipeBrief>(`/recipes/${recipeId.value}`);
  } catch (e) {
    pageError.value = e instanceof Error ? e.message : '菜谱读取失败';
    pageState.value = 'error';
  } finally {
    loading.value = false;
  }
}

/**
 * 获取库存预览：直接在服务端内存计算，不创建任何记录。
 * 用户取消或离开页面都不会留下未完成的记录。
 */
async function startEat(): Promise<void> {
  if (!recipe.value) return;
  pageState.value = 'loading';
  pageError.value = '';

  try {
    if (hasStructuredIngredients()) {
      // Path A: structured ingredients → in-memory preview → 确认时才创建记录
      preview.value = await apiRequest<ImmediateMealPreviewDto>('/consumption/preview-from-recipe', {
        method: 'POST',
        body: JSON.stringify({
          recipeId: recipe.value.id,
          mealType: mealType.value,
          sourceType: sourceType.value,
          recordDate: new Date().toLocaleDateString('sv-SE'),
          notes: notes.value || null
        })
      });
      usedSelections.value = {};
      pageState.value = 'preview';
    } else {
      // Path B: no structured ingredients → 直接创建正式记录
      await apiRequest('/records', {
        method: 'POST',
        body: JSON.stringify({
          recordDate: new Date().toLocaleDateString('sv-SE'),
          mealType: mealType.value,
          sourceType: sourceType.value,
          notes: notes.value || null,
          items: [
            {
              itemType: 'RECIPE',
              recipeId: recipe.value.id,
              mealRole: 'MAIN',
              sortOrder: 0
            }
          ]
        })
      });
      successMessage.value = '这餐已记录';
      pageState.value = 'success';
    }
  } catch (e) {
    pageError.value = e instanceof Error ? e.message : '操作失败';
    pageState.value = 'error';
  }
}

function toggleBatch(recipeIngredientId: string, batchId: string): void {
  const current = usedSelections.value[recipeIngredientId] ?? [];
  usedSelections.value = {
    ...usedSelections.value,
    [recipeIngredientId]: current.includes(batchId) ? current.filter((id) => id !== batchId) : [...current, batchId]
  };
}

async function refreshPreview(): Promise<void> {
  if (!recipe.value || !preview.value) return;
  pageState.value = 'loading';
  try {
    preview.value = await apiRequest<ImmediateMealPreviewDto>('/consumption/preview-from-recipe', {
      method: 'POST',
      body: JSON.stringify({
        recipeId: recipe.value.id,
        mealType: mealType.value,
        sourceType: sourceType.value,
        recordDate: new Date().toLocaleDateString('sv-SE'),
        notes: notes.value || null,
        selections: usedSelections.value
      })
    });
    pageState.value = 'preview';
  } catch (e) {
    pageError.value = e instanceof Error ? e.message : '预览失败，请重试';
    pageState.value = 'error';
  }
}

async function useSuggestedBatches(): Promise<void> {
  if (!preview.value) return;
  const chosen = Object.fromEntries(
    preview.value.items
      .filter((x) => x.requiresManualSelection)
      .map((x) => [x.recipeIngredientId, x.allocations.map((a) => a.batchId)])
  );
  usedSelections.value = chosen;
  await refreshPreview();
}

/** 是否有库存缺口（缺料或未关联库存食材） */
function hasShortage(): boolean {
  return preview.value?.items.some((item) => item.shortageQuantity > 0) ?? false;
}

async function confirmConsumption(): Promise<void> {
  if (!recipe.value || !preview.value) return;
  pageState.value = 'loading';
  try {
    await apiRequest('/consumption/confirm-from-recipe', {
      method: 'POST',
      body: JSON.stringify({
        recipeId: recipe.value.id,
        mealType: mealType.value,
        sourceType: sourceType.value,
        recordDate: new Date().toLocaleDateString('sv-SE'),
        notes: notes.value || null,
        previewToken: preview.value.previewToken,
        operationId: crypto.randomUUID(),
        selections: usedSelections.value
      })
    });
    successMessage.value = '这餐已记录';
    pageState.value = 'success';
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 409) {
      pageError.value = '库存已变化，请重新预览';
    } else {
      pageError.value = e instanceof Error ? e.message : '确认失败';
    }
    pageState.value = 'error';
  }
}

function goBack(): void {
  if (recipe.value) {
    router.push({ name: 'recipe-detail', params: { id: recipe.value.id } });
  } else {
    router.push({ name: 'home' });
  }
}

function formatPreviewAmount(item: ConsumptionPreviewItemDto): string {
  const allocated = item.allocations.reduce((sum, a) => sum + (a.quantity ?? 0), 0);
  if (allocated > 0) {
    return `可从库存扣减 ${allocated} ${displayLabel(item.unit)}${item.shortageQuantity > 0 ? `，缺 ${item.shortageQuantity}` : ''}`;
  }
  if (!item.ingredientId && item.shortageQuantity > 0) {
    return `未关联库存食材（需要 ${item.requiredQuantity} ${displayLabel(item.unit)}，不会自动扣减）`;
  }
  return `需要 ${item.requiredQuantity} ${displayLabel(item.unit)}`;
}

onMounted(() => {
  void loadRecipe();
});
</script>

<template>
  <section class="business-page complete-meal-page">
    <!-- Loading: recipe fetch -->
    <AppSkeleton v-if="loading && !recipe" :lines="6" />

    <!-- Error state -->
    <AppErrorState
      v-if="pageState === 'error' && !recipe"
      title="出错了"
      :description="pageError"
      @retry="loadRecipe"
    />

    <!-- Step 1: Prompt / Confirm the meal -->
    <template v-if="recipe && pageState === 'prompt'">
      <header class="business-hero">
        <div>
          <p class="business-eyebrow">还差一步</p>
          <h1>{{ recipe.name }}</h1>
          <p v-if="recipe.servings">{{ recipe.servings }} 份</p>
        </div>
      </header>

      <div class="app-card complete-meal-form">
        <label class="app-field">
          <span class="app-field__label">餐次</span>
          <select v-model="mealType">
            <option value="BREAKFAST">早餐</option>
            <option value="LUNCH">午餐</option>
            <option value="DINNER">晚餐</option>
            <option value="AFTERNOON_TEA">下午茶</option>
          </select>
        </label>

        <label class="app-field">
          <span class="app-field__label">来源</span>
          <select v-model="sourceType">
            <option value="HOMEMADE">在家做</option>
            <option value="DINE_IN">堂食</option>
            <option value="TAKEOUT">外卖</option>
          </select>
        </label>

        <label class="app-field">
          <span class="app-field__label">备注（可选）</span>
          <input v-model="notes" type="text" placeholder="记录一下这餐的感受…" />
        </label>

        <div class="complete-meal-actions">
          <AppButton variant="ghost" @click="goBack">取消</AppButton>
          <AppButton @click="startEat">确认并完成</AppButton>
        </div>

        <div v-if="hasStructuredIngredients()" class="complete-meal-cooking-link">
          <AppButton variant="secondary" @click="cookingOpen = true">开始制作这个菜谱</AppButton>
          <span class="complete-meal-cooking-link__hint">可查看食材、步骤与所需工具</span>
        </div>
      </div>
    </template>

    <!-- Loading: preview / confirming -->
    <div v-if="pageState === 'loading'" class="app-card complete-meal-loading">
      <p>处理中…</p>
      <AppSkeleton :lines="3" />
    </div>

    <!-- Step 3: Consumption preview -->
    <template v-if="recipe && pageState === 'preview' && preview">
      <header class="business-hero">
        <div>
          <p class="business-eyebrow">还差一步</p>
          <h1>{{ recipe.name }}</h1>
        </div>
      </header>

      <div class="app-card">
        <h2 class="section-title">库存核对</h2>
        <p class="preview-hint">确认前不会扣减任何库存；有缺料时会明确提示，不会静默扣减。</p>

        <div class="preview-items">
          <article
            v-for="row in preview.items"
            :key="row.recipeIngredientId"
            class="preview-item"
            :class="{
              'preview-item--shortage': row.shortageQuantity > 0,
              'preview-item--unlinked': !row.ingredientId && row.shortageQuantity > 0
            }"
          >
            <div class="preview-item__head">
              <strong>{{ row.ingredientName }}</strong>
              <span class="preview-item__required"> {{ formatPreviewAmount(row) }} </span>
            </div>

            <!-- Allocations -->
            <div v-if="row.allocations.length > 0" class="preview-item__allocations">
              <span class="preview-item__label">将扣减：</span>
              <span v-for="alloc in row.allocations" :key="alloc.batchId" class="preview-item__alloc">
                {{ alloc.quantity }} {{ displayLabel(alloc.unit) }}
              </span>
            </div>

            <!-- Shortage -->
            <div v-if="row.shortageQuantity > 0" class="preview-item__shortage">
              <span class="preview-item__label">库存不足：</span>
              <span>缺少 {{ row.shortageQuantity }} {{ displayLabel(row.unit) }}</span>
              <span v-if="!row.ingredientId" class="preview-item__note">（未关联库存食材，不会自动扣减）</span>
            </div>

            <!-- Manual batch selection -->
            <div v-if="row.requiresManualSelection" class="preview-item__manual">
              <em>有多个可用批次，请选择后重新预览</em>
            </div>

            <!-- Available batches -->
            <div v-if="row.availableBatches.length > 0" class="batch-choices">
              <label v-for="batch in row.availableBatches" :key="batch.batchId" class="batch-choice">
                <input
                  type="checkbox"
                  :checked="(usedSelections[row.recipeIngredientId] ?? []).includes(batch.batchId)"
                  @change="toggleBatch(row.recipeIngredientId, batch.batchId)"
                />
                <span>
                  {{ batch.availableQuantity }} {{ displayLabel(batch.unit) }}
                  <template v-if="batch.expiryDate">· 到期 {{ batch.expiryDate }}</template>
                  <template v-if="batch.location">· {{ batch.location }}</template>
                </span>
              </label>
            </div>
          </article>
        </div>

        <div class="complete-meal-actions">
          <AppButton variant="ghost" @click="goBack">取消</AppButton>
          <AppButton
            v-if="preview.items.some((x) => x.requiresManualSelection)"
            variant="secondary"
            @click="useSuggestedBatches"
          >
            采用建议批次
          </AppButton>
          <AppButton
            v-if="preview.items.some((x) => x.availableBatches.length > 1)"
            variant="secondary"
            @click="refreshPreview"
          >
            按选择重新预览
          </AppButton>
          <AppButton
            v-if="!preview.items.some((x) => x.requiresManualSelection)"
            @click="confirmConsumption"
          >
            {{ hasShortage() ? '按缺少食材完成' : '确认并完成' }}
          </AppButton>
        </div>
        <p v-if="hasShortage()" class="preview-note">
          本次不会扣减缺少的食材，仅记录这一餐；缺料会加入购物清单。
        </p>
      </div>
    </template>

    <!-- Error in flow (with retry) -->
    <AppErrorState v-if="pageState === 'error' && recipe" title="操作未完成" :description="pageError">
      <div class="complete-meal-actions">
        <AppButton variant="ghost" @click="goBack">返回</AppButton>
        <AppButton @click="startEat">重试</AppButton>
      </div>
    </AppErrorState>

    <!-- Step 4: Success -->
    <div v-if="pageState === 'success'" class="app-card complete-meal-success">
      <div class="success-icon">✓</div>
      <h2>{{ successMessage }}</h2>
      <p>这餐已经记下来了，可以去首页或日历查看。</p>
      <div class="complete-meal-actions">
        <AppButton @click="goBack">回到菜谱</AppButton>
        <AppButton variant="secondary" @click="router.push({ name: 'home' })">回首页</AppButton>
      </div>
    </div>

    <CookingView v-model="cookingOpen" :recipe="recipe" />
  </section>
</template>

<style scoped>
.complete-meal-form {
  display: grid;
  gap: var(--space-4);
  max-width: 480px;
}

.complete-meal-actions {
  display: flex;
  gap: var(--space-3);
  justify-content: flex-end;
  margin-top: var(--space-4);
}

.complete-meal-cooking-link {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-top: var(--space-2);
  border-top: 1px dashed var(--color-border);
}

.complete-meal-cooking-link__hint {
  color: var(--color-text-muted);
  font-size: 12px;
}

.complete-meal-loading {
  max-width: 480px;
}

.complete-meal-success {
  text-align: center;
  max-width: 480px;
  padding: var(--space-8) var(--space-4);
}

.success-icon {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--color-primary, #4caf50);
  color: #fff;
  font-size: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto var(--space-4);
}

.section-title {
  margin: 0 0 var(--space-2);
  font-size: 18px;
}

.preview-hint {
  color: var(--color-text-secondary, #666);
  font-size: 13px;
  margin: 0 0 var(--space-4);
}

.preview-note {
  margin: var(--space-4) 0 0;
  padding: var(--space-3);
  border-radius: var(--radius-tag);
  background: #fff7f0;
  border: 1px solid #ffd6a5;
  color: #e65100;
  font-size: 13px;
}

.preview-items {
  display: grid;
  gap: var(--space-3);
}

.preview-item {
  padding: var(--space-3);
  border-radius: 12px;
  background: #f8f9fa;
  display: grid;
  gap: var(--space-2);
}

.preview-item--shortage {
  background: #fff7f0;
  border: 1px solid #ffd6a5;
}

.preview-item--unlinked {
  background: #f0f4ff;
  border: 1px solid #b3d4ff;
}

.preview-item__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.preview-item__required {
  font-size: 13px;
  color: var(--color-text-secondary, #666);
}

.preview-item__label {
  font-size: 12px;
  color: var(--color-text-secondary, #666);
  margin-right: var(--space-2);
}

.preview-item__allocations,
.preview-item__shortage {
  font-size: 13px;
}

.preview-item__alloc {
  display: inline-block;
  padding: 2px 8px;
  background: #e8f5e9;
  border-radius: 4px;
  margin-right: var(--space-1);
}

.preview-item__shortage {
  color: #e65100;
}

.preview-item__note {
  display: block;
  font-size: 12px;
  color: #1976d2;
  margin-top: 2px;
}

.preview-item__manual em {
  color: #d32f2f;
  font-size: 12px;
}

.batch-choices {
  display: grid;
  gap: 6px;
  padding-top: 4px;
}

.batch-choice {
  font-size: 13px;
  display: flex;
  gap: var(--space-2);
  align-items: baseline;
}

.batch-choice input {
  margin-top: 2px;
}
</style>
