<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ConsumptionPreviewDto } from '../../../shared/types';
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
  servings: number | null;
  ingredients: Array<{
    id: string;
    ingredientNameSnapshot: string;
    quantity: number | null;
    unit: string | null;
    optional: boolean;
    ingredientId: string | null;
  }>;
}

type PageState = 'prompt' | 'loading' | 'error' | 'preview' | 'success';

const route = useRoute();
const router = useRouter();
const recipeId = computed(() => String(route.query.recipeId ?? ''));
const recipe = ref<RecipeBrief | null>(null);
const pageState = ref<PageState>('prompt');
const loading = ref(false);
const pageError = ref('');
const preview = ref<ConsumptionPreviewDto | null>(null);
const successMessage = ref('');

// Form fields with auto-detected defaults
const mealType = ref(inferMealType());
const sourceType = ref('HOMEMADE');
const notes = ref('');

// Track the created record for confirm step
const createdRecord = ref<{ id: string; version: number } | null>(null);
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

async function startEat(): Promise<void> {
  if (!recipe.value) return;
  pageState.value = 'loading';
  pageError.value = '';

  try {
    const recordPayload: Record<string, unknown> = {
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
    };

    if (hasStructuredIngredients()) {
      // Path A: structured ingredients → DRAFT → preview → confirm
      recordPayload.status = 'DRAFT';
      const record = await apiRequest<{ id: string; version: number }>('/records', {
        method: 'POST',
        body: JSON.stringify(recordPayload)
      });
      createdRecord.value = { id: record.id, version: record.version };

      // Get consumption preview
      const consumptionPreview = await apiRequest<ConsumptionPreviewDto>(`/records/${record.id}/consumption-preview`, {
        method: 'POST',
        body: JSON.stringify({ recordVersion: record.version })
      });
      preview.value = consumptionPreview;
      pageState.value = 'preview';
    } else {
      // Path B: no structured ingredients → CONFIRMED directly
      await apiRequest('/records', {
        method: 'POST',
        body: JSON.stringify(recordPayload)
      });
      successMessage.value = '记录成功！';
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
  if (!createdRecord.value || !preview.value) return;
  pageState.value = 'loading';
  try {
    preview.value = await apiRequest<ConsumptionPreviewDto>(`/records/${createdRecord.value.id}/consumption-preview`, {
      method: 'POST',
      body: JSON.stringify({
        recordVersion: createdRecord.value.version,
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

async function confirmConsumption(): Promise<void> {
  if (!preview.value || !createdRecord.value) return;
  pageState.value = 'loading';
  try {
    await apiRequest(`/records/${createdRecord.value.id}/confirm-consumption`, {
      method: 'POST',
      body: JSON.stringify({
        recordVersion: createdRecord.value.version,
        previewToken: preview.value.previewToken,
        operationId: crypto.randomUUID(),
        selections: usedSelections.value
      })
    });
    successMessage.value = '记录成功！';
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
          <p class="business-eyebrow">完成这一餐</p>
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
          <AppButton variant="ghost" @click="goBack">返回</AppButton>
          <AppButton @click="startEat">就吃这个</AppButton>
        </div>
      </div>
    </template>

    <!-- Loading: creating record / confirming -->
    <div v-if="pageState === 'loading'" class="app-card complete-meal-loading">
      <p>处理中…</p>
      <AppSkeleton :lines="3" />
    </div>

    <!-- Step 3: Consumption preview -->
    <template v-if="recipe && pageState === 'preview' && preview">
      <header class="business-hero">
        <div>
          <p class="business-eyebrow">完成这一餐</p>
          <h1>{{ recipe.name }}</h1>
        </div>
      </header>

      <div class="app-card">
        <h2 class="section-title">将扣减的食材</h2>
        <p class="preview-hint">以下食材将从库存中扣减，预览不会修改库存。</p>

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
              <span class="preview-item__required"> 需要 {{ row.requiredQuantity }} {{ displayLabel(row.unit) }} </span>
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
              <span v-if="!row.ingredientId" class="preview-item__note">（未关联库存食材，无法自动扣减）</span>
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
          <AppButton v-if="!preview.items.some((x) => x.requiresManualSelection)" @click="confirmConsumption">
            确认扣减并完成
          </AppButton>
        </div>
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
        <AppButton @click="goBack">返回菜谱</AppButton>
        <AppButton variant="secondary" @click="router.push({ name: 'home' })">回首页</AppButton>
      </div>
    </div>
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
