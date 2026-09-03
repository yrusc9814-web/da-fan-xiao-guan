<script lang="ts">
export interface SpinCandidate {
  id: string;
  name: string;
  enabledForRecommendation: boolean;
  version: number;
  mealTypes?: string[];
}
export interface SpinResultLike {
  resultType: string;
  resultId: string;
  title: string;
}
/**
 * 「换一个」确定性兜底：从参与随机的候选池中选取一个与当前结果不同的候选。
 * - 传入 mealType 时（UXA-002）只在「当前餐次 + enabledForRecommendation」的候选集合中选择，不跨餐次。
 * - 候选池存在 != currentId 的合法候选时，保证返回不同的候选（不依赖概率）。
 * - 当前餐次没有其他合法候选时返回 null，由调用方给出「暂时没有其他候选」语义。
 */
export function pickDifferentCandidate(
  candidates: SpinCandidate[],
  currentId: string | undefined,
  mealType?: string
): SpinResultLike | null {
  const enabled = candidates.filter(
    (r) => r.enabledForRecommendation && (!mealType || (r.mealTypes ?? []).includes(mealType))
  );
  const other = enabled.find((r) => r.id !== currentId);
  if (!other) return null;
  return { resultType: 'RECIPE', resultId: other.id, title: other.name };
}
</script>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppButton from '../components/ui/AppButton.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppInput from '../components/ui/AppInput.vue';
import { apiRequest } from '../services/api';
import { debounce } from '../utils/debounce';
import { displayLabel } from '../utils/display';
import { createRequestSequence } from '../utils/request-sequence';
import { itemsFrom, withSelected } from '../utils/selector-options';
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
  router = useRouter(),
  mode = ref<RecommendationMode>('random'),
  mealType = ref('DINNER'),
  results = ref<Result[]>([]),
  historyId = ref(''),
  loading = ref(false),
  error = ref(''),
  message = ref('');
const shoppingBusy = ref(false);
const planDate = ref(new Date().toLocaleDateString('sv-SE')),
  dinerCount = ref('1'),
  diners = ref<Array<{ id: string; name: string }>>([]),
  dinerCache = ref<Array<{ id: string; name: string }>>([]),
  dinerSearch = ref(''),
  selectedDinerIds = ref<string[]>([]);
const visibleDiners = computed(() => withSelected(diners.value, selectedDinerIds.value, dinerCache.value));
const dinerSequence = createRequestSequence();

// 候选池（UXA-001：候选池按当前餐次过滤，与服务端随机候选 mealTypes.some(mealType) 同语义）
const candidateRecipes = ref<
  Array<{ id: string; name: string; enabledForRecommendation: boolean; version: number; mealTypes: string[] }>
>([]);
const candidateLoading = ref(false);
const showCandidatePanel = ref(false);
const candidateCount = computed(() => candidateRecipes.value.filter((r) => r.enabledForRecommendation).length);

// 转盘
const spinning = ref(false);
const resultReady = ref(false);
const spinResult = ref<{ resultType: string; resultId: string; title: string } | null>(null);
const spinHistoryId = ref('');
const cyclingName = ref('');
const spinSequence = createRequestSequence();
let spinTimer: ReturnType<typeof setTimeout> | null = null;

function validMode(value: unknown): value is RecommendationMode {
  return typeof value === 'string' && ['random', 'meal-set', 'inventory'].includes(value);
}
async function loadDiners(search = dinerSearch.value) {
  const sequence = dinerSequence.next();
  try {
    const dinerData = await apiRequest<unknown>('/diners', {
      query: { search: search.trim() || undefined, pageSize: 20, active: true }
    });
    if (!dinerSequence.isCurrent(sequence)) return;
    const items = itemsFrom<{ id: string; name: string }>(dinerData);
    diners.value = items;
    dinerCache.value = withSelected(items, selectedDinerIds.value, dinerCache.value);
  } catch {
    // 食用者列表加载失败不阻塞推荐页主体功能
  }
}
function toggleDiner(id: string) {
  const adding = !selectedDinerIds.value.includes(id);
  selectedDinerIds.value = adding
    ? [...selectedDinerIds.value, id]
    : selectedDinerIds.value.filter((value) => value !== id);
  if (adding) {
    const item = diners.value.find((diner) => diner.id === id);
    if (item && !dinerCache.value.some((entry) => entry.id === id)) dinerCache.value = [...dinerCache.value, item];
  }
}
const searchDiners = debounce(() => {
  void loadDiners(dinerSearch.value);
}, 250);

// 候选池
async function loadCandidates() {
  candidateLoading.value = true;
  try {
    // UXA-001：服务端 GET /recipes 本身支持 mealType 过滤（mealTypes.some），
    // 候选池请求按当前餐次过滤，保证 UI 候选数量/列表与真正参与 spin 的候选同语义。
    const data = await apiRequest<unknown>('/recipes', { query: { pageSize: 100, mealType: mealType.value } });
    const items = itemsFrom<{
      id: string;
      name: string;
      enabledForRecommendation: boolean;
      version: number;
      mealTypes?: Array<{ mealType: string } | string>;
    }>(data);
    candidateRecipes.value = items.map((item) => ({
      id: item.id,
      name: item.name,
      enabledForRecommendation: item.enabledForRecommendation,
      version: item.version,
      mealTypes: (item.mealTypes ?? []).map((m) => (typeof m === 'string' ? m : m.mealType))
    }));
  } catch {
    // 候选池加载失败不影响主体功能
  } finally {
    candidateLoading.value = false;
  }
}
async function toggleCandidateEnabled(recipe: {
  id: string;
  name: string;
  enabledForRecommendation: boolean;
  version: number;
}) {
  const newValue = !recipe.enabledForRecommendation;
  try {
    // 服务端菜谱更新（PUT /recipes/:id）会整体替换并重建所有关联（食材/步骤/标签/餐次/角色/工具），
    // 因此这里必须先取完整菜谱再回传全量载荷，只改 enabledForRecommendation，避免丢失结构化数据。
    const x = await apiRequest<any>(`/recipes/${recipe.id}`);
    await apiRequest(`/recipes/${recipe.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: x.name,
        imagePath: x.imagePath,
        cookingTimeMinutes: x.cookingTimeMinutes,
        difficulty: x.difficulty,
        spicyLevel: x.spicyLevel,
        servings: x.servings,
        sourceNote: x.sourceNote,
        notes: x.notes,
        favorite: x.favorite,
        enabledForRecommendation: newValue,
        mealTypes: (x.mealTypes ?? []).map((m: any) => (typeof m === 'string' ? m : m.mealType)),
        mealRoles: (x.mealRoles ?? []).map((r: any) => (typeof r === 'string' ? r : r.mealRole)),
        tags: (x.tags ?? []).map((t: any) => (typeof t === 'string' ? t : (t.tag?.name ?? t.name))).filter(Boolean),
        ingredients: (x.ingredients ?? []).map((i: any) => ({
          ingredientId: i.ingredientId,
          ingredientName: i.ingredientNameSnapshot ?? i.ingredientName,
          quantity: i.quantity,
          unit: i.unit,
          optional: i.optional,
          isPrimary: i.isPrimary,
          sortOrder: i.sortOrder
        })),
        steps: (x.steps ?? []).map((s: any) => ({ stepNo: s.stepNo, content: s.content, imagePath: s.imagePath })),
        toolIds: (x.tools ?? []).map((t: any) => ({
          toolId: t.toolId,
          name: t.toolNameSnapshot ?? t.toolName,
          required: t.required
        })),
        version: x.version
      })
    });
    const found = candidateRecipes.value.find((r) => r.id === recipe.id);
    if (found) {
      found.enabledForRecommendation = newValue;
      found.version += 1;
    }
  } catch {
    await loadCandidates();
  }
}

// 转盘
async function spin(excludeId?: string) {
  if (spinning.value) return;
  spinning.value = true;
  resultReady.value = false;
  spinResult.value = null;
  spinHistoryId.value = '';
  error.value = '';
  message.value = '';
  const sequence = spinSequence.next();
  // UXA-002：fallback 只能在发起 spin 时的当前餐次候选集合内选择
  const spinMealType = mealType.value;
  try {
    // 「换一个」重试：不超过 4 次 API 请求
    const maxRetries = excludeId ? 4 : 1;
    let result: { resultType: string; resultId: string; title: string } | undefined;
    let lastHistoryId = '';
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const data = await apiRequest<{
        historyId: string;
        results: Array<{ resultType: string; resultId: string; title: string }>;
      }>('/recommendations/random', {
        method: 'POST',
        body: JSON.stringify({ mealType: spinMealType, dinerIds: [...selectedDinerIds.value] })
      });
      // 餐次已切换或页面已卸载：丢弃过期请求结果
      if (!spinSequence.isCurrent(sequence)) return;
      // UXA-006：转盘只接受 RECIPE 结果（服务端已强制 RECIPE，这里防御性过滤 STORE）
      const candidate = data.results.find((item) => item.resultType === 'RECIPE');
      if (!candidate) {
        spinning.value = false;
        error.value = '候选池暂无可用结果，请先调整候选菜或餐次。';
        return;
      }
      lastHistoryId = data.historyId;
      // 跳过与当前结果相同的候选（仅前 3 次重试）
      if (excludeId && candidate.resultId === excludeId && attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200 + attempt * 100));
        if (!spinSequence.isCurrent(sequence)) return;
        continue;
      }
      result = candidate;
      break;
    }
    // 确定性 fallback：API 重试全部返回相同结果时，从当前餐次候选池取一个不同的候选
    let usedFallback = false;
    if (result && excludeId && result.resultId === excludeId) {
      const fallback = pickDifferentCandidate(candidateRecipes.value, excludeId, spinMealType);
      if (!fallback) {
        spinning.value = false;
        error.value = '这个餐次暂时没有其他候选菜。可以更换餐次，或在候选管理中为当前餐次增加候选菜谱。';
        return;
      }
      // fallback 结果来自候选池而非本次服务端推荐，无对应 historyId，清空以防「加入计划」误加当前结果
      result = fallback;
      usedFallback = true;
    }
    if (!result) {
      spinning.value = false;
      error.value = '这个餐次暂时没有其他候选菜。可以更换餐次，或在候选管理中为当前餐次增加候选菜谱。';
      return;
    }
    spinHistoryId.value = usedFallback ? '' : lastHistoryId;
    const names = candidateRecipes.value.filter((r) => r.enabledForRecommendation).map((r) => r.name);
    if (names.length <= 1) {
      spinning.value = false;
      resultReady.value = true;
      spinResult.value = result;
      return;
    }
    const startTime = Date.now();
    const duration = 600;
    function animate() {
      const elapsed = Date.now() - startTime;
      if (elapsed >= duration) {
        if (!result) return; // 完成时动画结束但没有结果——防御
        cyclingName.value = result.title;
        spinning.value = false;
        resultReady.value = true;
        spinResult.value = result;
        return;
      }
      cyclingName.value = names[Math.floor(Math.random() * names.length)];
      const progress = elapsed / duration;
      spinTimer = setTimeout(animate, 40 + progress * 160);
    }
    animate();
  } catch (e) {
    if (!spinSequence.isCurrent(sequence)) return;
    spinning.value = false;
    error.value = e instanceof Error ? e.message : '转盘失败，请重试';
  }
}
async function reroll() {
  const excluded = spinResult.value?.resultId;
  if (candidateRecipes.value.filter((r) => r.enabledForRecommendation).length <= 1) {
    // UXA-002：当前餐次没有其他候选时不跨餐次补位，给出明确提示
    error.value = '这个餐次暂时没有其他候选菜。可以更换餐次，或在候选管理中为当前餐次增加候选菜谱。';
    return;
  }
  await spin(excluded);
}
function eatThis(recipeId: string) {
  router.push({ name: 'complete-meal', query: { recipeId } });
}
async function addToPlanFromSpin() {
  if (!spinResult.value) {
    // 防御：没有结果时给出明确提示，禁止任何「点按钮无反应」
    error.value = '还没有转盘结果，请先点「转一下」。';
    return;
  }
  loading.value = true;
  error.value = '';
  message.value = '';
  try {
    if (spinHistoryId.value) {
      // 正常 spin：结果已存入 RecommendationHistory，按服务端存储加入计划
      await apiRequest(`/recommendations/${spinHistoryId.value}/add-to-plan`, {
        method: 'POST',
        body: JSON.stringify({
          planDate: planDate.value,
          mealType: mealType.value,
          dinerCount: Number(dinerCount.value),
          dinerIds: [...selectedDinerIds.value]
        })
      });
    } else {
      // UXA-003：fallback 结果没有 RecommendationHistory，不能伪造 historyId；
      // 走标准的「直接创建计划」数据链（POST /plans，与「整组加入计划」无 history 时同一条合法链路）。
      await apiRequest('/plans', {
        method: 'POST',
        body: JSON.stringify({
          planDate: planDate.value,
          mealType: mealType.value,
          dinerCount: Number(dinerCount.value),
          items: [{ itemType: 'RECIPE', recipeId: spinResult.value.resultId, mealRole: 'MAIN', sortOrder: 0 }],
          dinerIds: [...selectedDinerIds.value]
        })
      });
    }
    message.value = `已加入 ${planDate.value} 的计划`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加入计划失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadDiners();
  void loadCandidates();
});
onUnmounted(() => {
  dinerSequence.next();
  searchDiners.cancel();
  spinSequence.next();
  if (spinTimer) clearTimeout(spinTimer);
});
watch(
  () => route.query.mode,
  (value) => {
    mode.value = validMode(value) ? value : 'random';
  },
  { immediate: true }
);
// UXA-001：餐次变化时候选池同步刷新；同时清空旧餐次的转盘结果与 historyId，
// 避免「旧餐次的结果」被加入新餐次计划。进行中的 spin 请求一并作废。
watch(mealType, () => {
  spinSequence.next();
  if (spinTimer) {
    clearTimeout(spinTimer);
    spinTimer = null;
  }
  spinning.value = false;
  resultReady.value = false;
  spinResult.value = null;
  spinHistoryId.value = '';
  void loadCandidates();
});
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
      }>('/kitchen/recommend', {
        method: 'POST',
        body: JSON.stringify({ mode: 'ALLOW_PURCHASE', limit: 8, dinerIds: selectedDinerIds.value })
      });
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
        body: JSON.stringify({ mealType: mealType.value, dinerIds: selectedDinerIds.value })
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
          dinerIds: [...selectedDinerIds.value]
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
          dinerIds: [...selectedDinerIds.value]
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
  if (!missing.length || shoppingBusy.value) return;
  shoppingBusy.value = true;
  loading.value = true;
  error.value = '';
  try {
    await apiRequest('/shopping-lists', {
      method: 'POST',
      body: JSON.stringify({
        name: `推荐缺料 ${planDate.value}`,
        items: missing.map((ingredientName) => ({
          ingredientName,
          quantity: 1,
          unit: 'OTHER',
          sourceType: 'RECOMMENDATION',
          sourceId: historyId.value || null
        }))
      })
    });
    message.value = `${missing.length} 项缺料已加入购物清单`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '生成购物清单失败';
  } finally {
    loading.value = false;
    shoppingBusy.value = false;
  }
}
</script>
<template>
  <section class="business-page recommendations-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">Decision helper</p>
        <h1>今天吃什么</h1>
        <p v-if="selectedDinerIds.length">结果来自真实菜谱、店铺、库存、工具与食用者偏好；忌口和过敏始终硬过滤。</p>
        <p v-else>未选择食用者：本次推荐结果不会应用忌口与过敏过滤。</p>
      </div>
      <AppButton :loading="loading" @click="generate">生成推荐</AppButton>
    </header>

    <!-- 候选池 -->
    <div class="app-card candidate-pool">
      <div class="candidate-pool__header">
        <span class="candidate-pool__count">
          当前餐次（{{ displayLabel(mealType) }}）参与随机的候选数量：
          <strong>{{ candidateLoading ? '…' : candidateCount }}</strong> 道菜参与随机
        </span>
        <AppButton variant="secondary" size="sm" @click="showCandidatePanel = !showCandidatePanel">
          {{ showCandidatePanel ? '收起候选菜' : '管理候选菜' }}
        </AppButton>
      </div>
      <div v-if="showCandidatePanel" class="candidate-pool__body">
        <p v-if="candidateLoading" class="candidate-pool__hint">加载中…</p>
        <template v-else-if="candidateRecipes.length">
          <p class="candidate-pool__hint">
            仅显示适用于「{{ displayLabel(mealType) }}」的菜谱；参与随机还需勾选「参与推荐」。
          </p>
          <div v-for="recipe in candidateRecipes" :key="recipe.id" class="candidate-item">
            <label class="candidate-item__label">
              <input
                type="checkbox"
                :checked="recipe.enabledForRecommendation"
                @change="toggleCandidateEnabled(recipe)"
              />
              <span :class="{ 'candidate-item--disabled': !recipe.enabledForRecommendation }">{{ recipe.name }}</span>
            </label>
          </div>
        </template>
        <p v-else class="candidate-pool__hint">
          当前餐次暂无候选菜谱。可为已有菜谱在编辑页补充「{{ displayLabel(mealType) }}」餐次，或新增菜谱。
        </p>
        <div class="candidate-pool__actions">
          <RouterLink class="text-button" to="/recipes/new">新增菜谱 →</RouterLink>
        </div>
      </div>
    </div>

    <!-- 转盘决策 -->
    <div class="app-card spin-section" :class="{ 'spin-section--result': resultReady }">
      <div class="spin-wheel__area">
        <div class="spin-wheel__display">
          <template v-if="!resultReady && !spinning">
            <span class="spin-wheel__placeholder">点击「转一下」从候选池随机决定</span>
          </template>
          <template v-else-if="spinning">
            <span class="spin-wheel__item spin-wheel__item--cycling">{{ cyclingName }}</span>
          </template>
          <template v-else>
            <span class="spin-wheel__item spin-wheel__item--result">{{ spinResult?.title }}</span>
          </template>
        </div>
        <AppButton :loading="spinning" :disabled="candidateCount === 0 || spinning" @click="spin">
          {{ spinning ? '转动中…' : resultReady ? '再转一次' : '转一下' }}
        </AppButton>
      </div>

      <div v-if="resultReady && spinResult" class="spin-result__actions">
        <AppButton variant="secondary" size="sm" @click="reroll">换一个</AppButton>
        <AppButton size="sm" @click="eatThis(spinResult.resultId)">就吃这个</AppButton>
        <AppButton variant="secondary" size="sm" :loading="loading" @click="addToPlanFromSpin">加入计划</AppButton>
        <RouterLink class="text-button" :to="`/recipes/${spinResult.resultId}`">查看详情 →</RouterLink>
      </div>

      <p v-if="candidateCount === 0 && !candidateLoading && !spinning" class="spin-section__hint">
        当前餐次候选池为空，请先
        <RouterLink to="/recipes/new">新增菜谱</RouterLink>
        或在候选管理中启用已有菜谱的「参与推荐」。
      </p>
      <p v-if="candidateCount === 1 && !resultReady && !spinning" class="spin-section__hint">
        当前餐次仅 1 道候选菜，转盘结果将直接是该菜谱。
      </p>
    </div>

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
      <div class="recommendation-diners">
        <fieldset>
          <legend>食用者（可多选）</legend>
          <p class="recommendation-diners__hint">勾选后将按其忌口、过敏硬过滤推荐结果</p>
          <AppInput v-model="dinerSearch" label="搜索食用者" @update:model-value="searchDiners" />
          <label v-for="diner in visibleDiners" :key="diner.id"
            ><input type="checkbox" :checked="selectedDinerIds.includes(diner.id)" @change="toggleDiner(diner.id)" />{{
              diner.name
            }}</label
          >
        </fieldset>
      </div>
    </div>
    <p v-if="message" class="business-success">{{ message }}</p>
    <AppErrorState v-if="error" title="暂时无法推荐" :description="error" @retry="generate" /><AppEmptyState
      v-else-if="!results.length && !loading"
      title="今天吃什么？"
      description="点「转一下」随机决定，或选择推荐方式，系统会解释每个结果为什么适合。"
    /><template v-else
      ><div class="business-card__actions">
        <AppButton v-if="historyId" variant="secondary" @click="accept">喜欢这组结果</AppButton
        ><AppButton
          v-if="results.some((result) => result.missingIngredients.length)"
          variant="secondary"
          :loading="loading || shoppingBusy"
          :disabled="shoppingBusy"
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
  border-radius: var(--radius-tag);
  color: #9a5c70;
  background: #fff0f4;
  font-size: 12px;
}
.recommendation-result > a {
  color: var(--color-primary-hover);
  font-weight: var(--font-weight-bold);
}
.recommendation-diners fieldset {
  display: grid;
  align-content: start;
  gap: 6px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
}
.recommendation-diners label {
  font-size: 13px;
}
.recommendation-diners__hint {
  font-size: 12px;
  color: var(--color-text-muted);
}

/* 候选池 */
.candidate-pool {
  display: grid;
  gap: var(--space-3);
}
.candidate-pool__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.candidate-pool__count {
  font-size: 14px;
  color: var(--color-text-secondary);
}
.candidate-pool__count strong {
  color: var(--color-primary);
  font-size: 18px;
}
.candidate-pool__body {
  display: grid;
  gap: 4px;
  max-height: 300px;
  overflow-y: auto;
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-3);
}
.candidate-item__label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
  cursor: pointer;
}
.candidate-item--disabled {
  color: var(--color-text-muted);
  text-decoration: line-through;
}
.candidate-pool__hint {
  font-size: 12px;
  color: var(--color-text-muted);
  margin: 0;
}
.candidate-pool__actions {
  padding-top: var(--space-2);
}
.candidate-pool__actions .text-button {
  color: var(--color-primary-hover);
  font-weight: var(--font-weight-bold);
}

/* 转盘 */
.spin-section {
  display: grid;
  gap: var(--space-4);
  text-align: center;
  border-top: 4px solid #f3bdcb;
  transition: border-color var(--motion-fast) ease;
}
.spin-section--result {
  border-top-color: var(--color-primary);
}
.spin-wheel__area {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
}
.spin-wheel__display {
  width: 100%;
  min-height: 80px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-dialog);
  background: linear-gradient(135deg, #fff5f8 0%, #fff0f4 100%);
  border: 1px solid #f3d8e0;
  overflow: hidden;
}
.spin-wheel__placeholder {
  color: var(--color-text-muted);
  font-size: 14px;
}
.spin-wheel__item {
  font-size: 22px;
  font-weight: var(--font-weight-bold);
  padding: var(--space-4);
}
.spin-wheel__item--cycling {
  color: var(--color-text-muted);
  animation: spin-flicker 0.1s ease-in-out;
}
.spin-wheel__item--result {
  color: var(--color-primary);
  font-size: 26px;
  animation: spin-land 0.3s ease-out;
}
.spin-result__actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.spin-result__actions .text-button {
  color: var(--color-primary-hover);
  font-weight: var(--font-weight-bold);
}
.spin-section__hint {
  font-size: 12px;
  color: var(--color-text-muted);
  margin: 0;
}
.spin-section__hint a {
  color: var(--color-primary-hover);
  font-weight: var(--font-weight-bold);
}
@keyframes spin-flicker {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}
@keyframes spin-land {
  0% {
    transform: scale(0.8);
    opacity: 0.5;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}
@media (max-width: 680px) {
  .candidate-pool__header {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-2);
  }
  .spin-result__actions {
    flex-direction: column;
  }
  .spin-result__actions .app-button {
    width: 100%;
  }
}
</style>
