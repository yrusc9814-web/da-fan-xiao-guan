<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppButton from '../components/ui/AppButton.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppInput from '../components/ui/AppInput.vue';
import { apiRequest } from '../services/api';
import { displayLabel } from '../utils/display';
interface Result {
  resultType: string;
  resultId: string;
  title: string;
  reason: string;
  missingIngredients: string[];
  mealRole?: string;
}
type RecommendationMode = 'random' | 'meal-set' | 'inventory';
const route = useRoute(),
  mode = ref<RecommendationMode>('random'),
  mealType = ref('DINNER'),
  results = ref<Result[]>([]),
  historyId = ref(''),
  loading = ref(false),
  error = ref(''),
  message = ref('');
const planDate = ref(new Date().toLocaleDateString('sv-SE')),
  dinerCount = ref('1');
function validMode(value: unknown): value is RecommendationMode {
  return typeof value === 'string' && ['random', 'meal-set', 'inventory'].includes(value);
}
watch(
  () => route.query.mode,
  (value) => {
    mode.value = validMode(value) ? value : 'random';
  },
  { immediate: true }
);
async function generate() {
  loading.value = true;
  error.value = '';
  message.value = '';
  try {
    if (mode.value === 'inventory') {
      const data = await apiRequest<{
        items: Array<{
          recipe: { id: string; name: string };
          reason: string;
          missingIngredients: Array<{ name: string }>;
        }>;
      }>('/kitchen/recommend', { method: 'POST', body: JSON.stringify({ mode: 'ALLOW_PURCHASE', limit: 8 }) });
      results.value = data.items.map((x) => ({
        resultType: 'RECIPE',
        resultId: x.recipe.id,
        title: x.recipe.name,
        reason: x.reason,
        missingIngredients: (x.missingIngredients ?? []).map((item) => item.name)
      }));
      historyId.value = '';
    } else {
      const data = await apiRequest<{ historyId: string; results: Result[] }>(`/recommendations/${mode.value}`, {
        method: 'POST',
        body: JSON.stringify({ mealType: mealType.value })
      });
      results.value = data.results;
      historyId.value = data.historyId;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '推荐失败';
  } finally {
    loading.value = false;
  }
}
async function accept() {
  if (historyId.value) {
    await apiRequest(`/recommendations/${historyId.value}/accept`, { method: 'POST' });
    message.value = '已记录你的偏好';
  }
}
async function addToPlan() {
  if (!results.value.length) return;
  loading.value = true;
  error.value = '';
  try {
    if (historyId.value)
      await apiRequest(`/recommendations/${historyId.value}/add-to-plan`, {
        method: 'POST',
        body: JSON.stringify({
          planDate: planDate.value,
          mealType: mealType.value,
          dinerCount: Number(dinerCount.value),
          dinerIds: []
        })
      });
    else
      await apiRequest('/plans', {
        method: 'POST',
        body: JSON.stringify({
          planDate: planDate.value,
          mealType: mealType.value,
          dinerCount: Number(dinerCount.value),
          items: results.value.map((result, index) => ({
            itemType: result.resultType === 'STORE' ? 'STORE' : 'RECIPE',
            recipeId: result.resultType === 'STORE' ? undefined : result.resultId,
            storeId: result.resultType === 'STORE' ? result.resultId : undefined,
            mealRole: result.mealRole ?? (index === 0 ? 'MAIN' : 'SIDE'),
            sortOrder: index
          })),
          dinerIds: []
        })
      });
    message.value = `已加入 ${planDate.value} 的计划`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加入计划失败';
  } finally {
    loading.value = false;
  }
}
async function addMissingToShopping() {
  const missing = [...new Set(results.value.flatMap((result) => result.missingIngredients))];
  if (!missing.length) return;
  loading.value = true;
  error.value = '';
  try {
    let list = await apiRequest<{ id: string; version: number }>('/shopping-lists', {
      method: 'POST',
      body: JSON.stringify({ name: `推荐缺料 ${planDate.value}`, items: [] })
    });
    for (const ingredientName of missing) {
      list = await apiRequest(`/shopping-lists/${list.id}/items`, {
        method: 'POST',
        body: JSON.stringify({
          version: list.version,
          ingredientName,
          quantity: 1,
          unit: 'OTHER',
          sourceType: 'RECOMMENDATION',
          sourceId: historyId.value || null
        })
      });
    }
    message.value = `${missing.length} 项缺料已加入购物清单`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '生成购物清单失败';
  } finally {
    loading.value = false;
  }
}
</script>
<template>
  <section class="business-page recommendations-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">Decision helper</p>
        <h1>今天吃什么</h1>
        <p>结果来自真实菜谱、店铺、库存、工具与食用者偏好；忌口和过敏始终硬过滤。</p>
      </div>
      <AppButton :loading="loading" @click="generate">生成推荐</AppButton>
    </header>
    <div class="business-form app-card">
      <label class="app-field"
        ><span class="app-field__label">推荐方式</span
        ><select v-model="mode">
          <option value="random">随机决定</option>
          <option value="meal-set">搭配一顿饭</option>
          <option value="inventory">库存推荐</option>
        </select></label
      ><label class="app-field"
        ><span class="app-field__label">餐次</span
        ><select v-model="mealType">
          <option value="BREAKFAST">早餐</option>
          <option value="LUNCH">午餐</option>
          <option value="DINNER">晚餐</option>
          <option value="AFTERNOON_TEA">下午茶</option>
        </select></label
      ><AppInput v-model="planDate" type="date" label="加入计划日期" /><AppInput v-model="dinerCount" label="人数" />
    </div>
    <p v-if="message" class="business-success">{{ message }}</p>
    <AppErrorState v-if="error" title="暂时无法推荐" :description="error" @retry="generate" /><AppEmptyState
      v-else-if="!results.length && !loading"
      title="准备好摇一摇了吗"
      description="选择推荐方式，系统会解释每个结果为什么适合。"
    /><template v-else
      ><div class="business-card__actions">
        <AppButton v-if="historyId" variant="secondary" @click="accept">喜欢这组结果</AppButton
        ><AppButton
          v-if="results.some((result) => result.missingIngredients.length)"
          variant="secondary"
          :loading="loading"
          @click="addMissingToShopping"
          >缺料加入购物清单</AppButton
        ><AppButton :loading="loading" @click="addToPlan">整组加入计划</AppButton>
      </div>
      <div class="business-grid">
        <article v-for="result in results" :key="result.resultId" class="business-card app-card recommendation-result">
          <div>
            <div class="business-card__head">
              <div>
                <p>
                  {{ displayLabel(result.resultType) }}
                  {{ result.mealRole ? `· ${displayLabel(result.mealRole)}` : '' }}
                </p>
                <h2>{{ result.title }}</h2>
              </div>
              <span class="recommendation-result__state">{{
                result.missingIngredients.length ? '需补购' : '库存可做'
              }}</span>
            </div>
            <p>{{ result.reason }}</p>
            <p v-if="result.missingIngredients.length">缺少：{{ result.missingIngredients.join('、') }}</p>
          </div>
          <RouterLink
            class="text-button"
            :to="
              result.resultType === 'RECIPE'
                ? `/recipes/${result.resultId}`
                : { path: '/discovery', query: { focus: result.resultId } }
            "
            >查看详情 →</RouterLink
          >
        </article>
      </div></template
    >
  </section>
</template>
<style scoped>
.recommendation-result {
  border-top: 4px solid #f3bdcb;
}
.recommendation-result__state {
  padding: 5px 9px;
  border-radius: 999px;
  color: #9a5c70;
  background: #fff0f4;
  font-size: 12px;
}
.recommendation-result > a {
  color: var(--color-primary-hover);
  font-weight: 750;
}
</style>
