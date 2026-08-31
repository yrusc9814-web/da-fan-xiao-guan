<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import CookingView from '../components/CookingView.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import { apiRequest } from '../services/api';
import { displayLabel } from '../utils/display';

interface RecipeDetail {
  id: string;
  name: string;
  imagePath: string | null;
  cookingTimeMinutes: number | null;
  difficulty: string | null;
  servings: number | null;
  favorite: boolean;
  ingredientsText: string | null;
  ingredients: Array<{
    id: string;
    ingredientNameSnapshot: string;
    quantity: number | null;
    unit: string | null;
    optional: boolean;
  }>;
  steps: Array<{ id: string; stepNo: number; content: string }>;
  tags: Array<{ tag: { id: string; name: string } }>;
  tools: Array<{ id: string; toolNameSnapshot: string; required: boolean }>;
}

const route = useRoute();
const recipe = ref<RecipeDetail | null>(null);
const loading = ref(true);
const error = ref('');
const cookingOpen = ref(false);

function openCooking(): void {
  cookingOpen.value = true;
}

function imageUrl(path: string | null): string | null {
  if (!path || path.includes('://') || path.includes('\0')) return null;
  const normalized = path
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/^uploads\//, '');
  if (!normalized || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..'))
    return null;
  return `/uploads/${normalized.split('/').map(encodeURIComponent).join('/')}`;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    recipe.value = await apiRequest(`/recipes/${String(route.params.id)}`);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '菜谱读取失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="business-page recipe-detail-page">
    <AppSkeleton v-if="loading" :lines="8" />
    <AppErrorState v-else-if="error" title="菜谱暂时无法读取" :description="error" @retry="load" />
    <template v-else-if="recipe">
      <header class="business-hero">
        <div>
          <p class="business-eyebrow">Recipe detail</p>
          <h1>{{ recipe.name }}</h1>
          <p>
            {{ recipe.cookingTimeMinutes ?? '—' }} 分钟 · {{ recipe.servings ?? '—' }} 份 ·
            {{ recipe.favorite ? '已收藏' : '未收藏' }}
          </p>
        </div>
        <div class="business-hero__actions">
          <button type="button" class="app-button app-button--primary app-button--md" @click="openCooking">
            开始制作
          </button>
          <RouterLink :to="`/recipes/${recipe.id}/edit`" class="app-button app-button--secondary app-button--md"
            >编辑菜谱</RouterLink
          >
        </div>
      </header>
      <img
        v-if="imageUrl(recipe.imagePath)"
        class="recipe-detail-page__image"
        :src="imageUrl(recipe.imagePath)!"
        :alt="recipe.name"
        loading="lazy"
        decoding="async"
      />
      <div class="business-grid">
        <article class="app-card business-card">
          <h2>食材</h2>
          <ul v-if="recipe.ingredients.length">
            <li v-for="item in recipe.ingredients" :key="item.id">
              {{ item.ingredientNameSnapshot }} {{ item.quantity ?? '' }} {{ item.unit ? displayLabel(item.unit) : ''
              }}{{ item.optional ? '（可选）' : '' }}
            </li>
          </ul>
          <p v-else>{{ recipe.ingredientsText || '暂未填写食材' }}</p>
        </article>
        <article class="app-card business-card">
          <h2>制作步骤</h2>
          <ol v-if="recipe.steps.length">
            <li v-for="step in recipe.steps" :key="step.id">{{ step.content }}</li>
          </ol>
          <AppEmptyState v-else title="暂未填写步骤" description="可从编辑入口补充制作步骤。" />
        </article>
        <article class="app-card business-card">
          <h2>标签与工具</h2>
          <p>标签：{{ recipe.tags.map((item) => item.tag.name).join('、') || '暂无' }}</p>
          <p>工具：{{ recipe.tools.map((item) => item.toolNameSnapshot).join('、') || '暂无' }}</p>
        </article>
      </div>
      <CookingView v-model="cookingOpen" :recipe="recipe" />
    </template>
  </section>
</template>

<style scoped>
.recipe-detail-page__image {
  width: min(100%, 720px);
  aspect-ratio: 16/9;
  object-fit: cover;
  border-radius: var(--radius-card-large);
}
.business-hero__actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 0 0 auto;
}
.recipe-detail-page ul,
.recipe-detail-page ol {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  padding-left: 22px;
}
.recipe-detail-page h2,
.recipe-detail-page p {
  margin-top: 0;
}
</style>
