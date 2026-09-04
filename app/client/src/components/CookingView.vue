<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';

import AppIcon from './AppIcon.vue';
import AppDialog from './ui/AppDialog.vue';
import AppEmptyState from './ui/AppEmptyState.vue';
import { displayLabel } from '../utils/display';

interface CookingIngredient {
  id: string;
  ingredientNameSnapshot: string;
  quantity: number | null;
  unit: string | null;
  optional: boolean;
}

interface CookingStep {
  id: string;
  stepNo: number;
  content: string;
}

interface CookingTool {
  id: string;
  toolNameSnapshot: string;
  required: boolean;
}

export interface CookingRecipe {
  id: string;
  name: string;
  cookingTimeMinutes: number | null;
  difficulty: string | null;
  servings: number | null;
  ingredients: CookingIngredient[];
  steps: CookingStep[];
  tools: CookingTool[];
}

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    recipe: CookingRecipe | null;
    /** 完成这一餐时随 recipeId 显式透传的正式上下文（如 mealType/planId），由宿主页面提供。 */
    completionQuery?: Record<string, string>;
  }>(),
  {
    modelValue: false,
    recipe: null,
    completionQuery: undefined
  }
);
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const router = useRouter();

const hasSteps = computed(() => Boolean(props.recipe?.steps?.length));
const hasTools = computed(() => Boolean(props.recipe?.tools?.length));

function updateOpen(value: boolean): void {
  emit('update:modelValue', value);
}

function finishMeal(): void {
  if (!props.recipe) return;
  updateOpen(false);
  // 透传宿主页面的正式完成上下文（mealType/planId），不凭 recipeId/日期反查计划
  void router.push({
    name: 'complete-meal',
    query: { recipeId: props.recipe.id, ...(props.completionQuery ?? {}) }
  });
}
</script>

<template>
  <AppDialog :model-value="modelValue" title="开始制作" dialog-class="cooking-panel" @update:model-value="updateOpen">
    <template v-if="recipe">
      <div class="cooking-summary">
        <span class="cooking-summary__item">
          <AppIcon name="clock" :size="16" />
          {{ recipe.cookingTimeMinutes ?? '—' }} 分钟
        </span>
        <span class="cooking-summary__item">
          <AppIcon name="ingredient" :size="16" />
          {{ recipe.servings ?? '—' }} 份
        </span>
        <span v-if="recipe.difficulty" class="cooking-summary__item">
          <AppIcon name="chef" :size="16" />
          难度 {{ recipe.difficulty }}
        </span>
      </div>

      <section v-if="recipe.ingredients.length" class="cooking-section">
        <h3>食材清单</h3>
        <ul class="cooking-ingredients">
          <li v-for="item in recipe.ingredients" :key="item.id">
            <span class="cooking-ingredients__name">{{ item.ingredientNameSnapshot }}</span>
            <span v-if="item.quantity != null || item.unit" class="cooking-ingredients__amount">
              {{ item.quantity ?? '' }} {{ item.unit ? displayLabel(item.unit) : '' }}
            </span>
            <span v-if="item.optional" class="cooking-ingredients__optional">可选</span>
          </li>
        </ul>
      </section>

      <section v-if="hasSteps" class="cooking-section">
        <h3>制作步骤</h3>
        <ol class="cooking-steps">
          <li v-for="step in recipe.steps" :key="step.id">
            <span class="cooking-steps__no">{{ step.stepNo }}</span>
            <span>{{ step.content }}</span>
          </li>
        </ol>
      </section>

      <section v-if="hasTools" class="cooking-section">
        <h3>所需工具</h3>
        <ul class="cooking-tools">
          <li v-for="tool in recipe.tools" :key="tool.id">{{ tool.toolNameSnapshot }}</li>
        </ul>
      </section>
    </template>
    <AppEmptyState v-else title="暂未读取到菜谱信息" description="请返回详情页后重试。" />

    <template #footer>
      <button type="button" class="app-button app-button--ghost app-button--md" @click="updateOpen(false)">返回</button>
      <button type="button" class="app-button app-button--primary app-button--md" @click="finishMeal">
        <AppIcon name="check" :size="18" />
        完成这一餐
      </button>
    </template>
  </AppDialog>
</template>

<style scoped>
:global(.app-dialog.cooking-panel) {
  width: min(100%, 760px);
}

.cooking-summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}

.cooking-summary__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--radius-tag);
  color: var(--color-primary-hover);
  background: var(--color-primary-soft);
  font-size: var(--font-size-sm);
  font-weight: 700;
  white-space: nowrap;
}

.cooking-section {
  margin-top: var(--space-6);
}

.cooking-section h3 {
  margin: 0 0 var(--space-3);
  color: var(--color-text-primary);
  font-size: var(--font-size-md);
  line-height: var(--line-height-tight);
}

.cooking-ingredients,
.cooking-tools {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.cooking-ingredients li {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px dashed var(--color-border);
}

.cooking-ingredients li:last-child {
  border-bottom: 0;
}

.cooking-ingredients__name {
  color: var(--color-text-primary);
  font-weight: 600;
}

.cooking-ingredients__amount {
  margin-left: auto;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

.cooking-ingredients__optional {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.cooking-steps {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.cooking-steps li {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  color: var(--color-text-secondary);
  line-height: var(--line-height-normal);
}

.cooking-steps__no {
  display: grid;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  place-items: center;
  border-radius: 50%;
  color: var(--color-card);
  background: var(--color-primary);
  font-size: var(--font-size-xs);
  font-weight: 800;
}

.cooking-tools li {
  width: fit-content;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-tag);
  color: #b06a2a;
  background: var(--color-orange-soft);
  font-size: var(--font-size-sm);
  font-weight: 600;
}
</style>
