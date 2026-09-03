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

/**
 * 真圆形转盘几何（UXB-004）：扇区按候选顺序顺时针均分，指针固定在 12 点方向，
 * 盘面每次旋转都保证目标扇区中心精确停在指针下——视觉结果 == 业务结果由纯几何函数保证。
 * 约定：角度单位为度，0° = 正上方（指针位置），顺时针为正。
 */
export interface WheelCandidateLike {
  id: string;
  enabledForRecommendation: boolean;
}
export function enabledWheelCandidates<T extends WheelCandidateLike>(candidates: T[]): T[] {
  return candidates.filter((c) => c.enabledForRecommendation);
}
export function sectorSpanDeg(count: number): number {
  return 360 / count;
}
/** 第 index 个扇区的中心角（从正上方顺时针）。count=0/负值时调用方应避免。 */
export function sectorCenterDeg(index: number, count: number): number {
  return ((((index + 0.5) * sectorSpanDeg(count)) % 360) + 360) % 360;
}
/**
 * 让「固定指针停在目标扇区中心」所需的盘面顺时针旋转角。
 * 返回 ≥ minTravel 且满足 (rotation + center) ≡ 0 (mod 360) 的最小值，
 * 因此落地结果唯一确定，多转整圈只影响视觉效果不影响落点。
 */
export function wheelRotationForTarget(index: number, count: number, minTravel = 0): number {
  const center = sectorCenterDeg(index, count);
  const aligned = (360 - (center % 360)) % 360;
  let rotation = aligned;
  while (rotation < minTravel) rotation += 360;
  return rotation;
}
/** 给定盘面旋转角，返回此时指针（正上方）正对的扇区下标——用于校验落点与几何反向一致。 */
export function sectorIndexAtPointer(rotation: number, count: number): number {
  const span = sectorSpanDeg(count);
  const normalized = ((rotation % 360) + 360) % 360;
  const originalAngle = (360 - normalized) % 360; // 顶部指针此时正对的原扇区角
  return Math.max(0, Math.min(count - 1, Math.floor(originalAngle / span)));
}

/** CompleteMealPage 表单实际接受的餐次集合（与接收端 option 一致）。 */
export const EAT_THIS_MEAL_TYPES = ['BREAKFAST', 'LUNCH', 'DINNER', 'AFTERNOON_TEA'];
/**
 * 「就吃这个」→ CompleteMeal 的导航 query：
 * 只在当前餐次是合法/明确值时附带 mealType，让接收端优先采用显式上下文；
 * 非法或缺失时不制造错误值——省略该字段，由接收端按当前时间 fallback。
 */
export function buildEatThisQuery(recipeId: string, mealType: string | null | undefined): Record<string, string> {
  const query: Record<string, string> = { recipeId };
  const normalized = mealType ?? '';
  if (EAT_THIS_MEAL_TYPES.includes(normalized)) query.mealType = normalized;
  return query;
}
</script>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import brandLogo from '../assets/mascot/brand-logo.png';
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
const modeLabels: Record<RecommendationMode, string> = {
  random: '随机决定',
  'meal-set': '搭配一顿饭',
  inventory: '库存推荐'
};

// 候选池（UXA-001：候选池按当前餐次过滤，与服务端随机候选 mealTypes.some(mealType) 同语义）
const candidateRecipes = ref<
  Array<{ id: string; name: string; enabledForRecommendation: boolean; version: number; mealTypes: string[] }>
>([]);
const candidateLoading = ref(false);
const showCandidatePanel = ref(false);
const candidateCount = computed(() => candidateRecipes.value.filter((r) => r.enabledForRecommendation).length);

// 转盘（UXB-004：真圆形转盘）
// 扇区/指针几何常量与状态
const WHEEL_SPIN_MS = 2400; // 完整一次旋转（含自然减速）的过渡时长
const WHEEL_MIN_ADVANCE_DEG = 720; // 每次起转至少前进两整圈，保证「快速旋转→自然减速」的观感
// 扇区配色：取自设计系统主/辅色的中明度档，保证白色菜名文字可读
const WHEEL_SECTOR_COLORS = ['#e76f92', '#e79a56', '#79b98f', '#7f9fe0', '#b091e0', '#e0815d', '#9dbb52', '#55a9c4'];
const spinning = ref(false);
const resultReady = ref(false);
const spinResult = ref<{ resultType: string; resultId: string; title: string } | null>(null);
const spinHistoryId = ref('');
const rotation = ref(0);
const lastRotation = ref(0);
const spinSequence = createRequestSequence();
let spinTimer: ReturnType<typeof setTimeout> | null = null;

/** 参与随机（enabled）的候选——即转盘扇区集合；保持与候选池展示顺序一致 */
const wheelCandidates = computed(() => enabledWheelCandidates(candidateRecipes.value));
const sectorCount = computed(() => wheelCandidates.value.length);
/** 候选集合身份：成员变化（增删/启用切换）时盘面几何已失效，需重置 */
const wheelSignature = computed(() => wheelCandidates.value.map((r) => r.id).join('|'));
/** 目标结果在扇区中的下标；不在集合内时为 -1（罕见漂移时的防御态） */
const targetSectorIndex = computed(() =>
  spinResult.value ? wheelCandidates.value.findIndex((r) => r.id === spinResult.value!.resultId) : -1
);

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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

// —— 转盘视图几何 ——
// 视觉约定与几何函数一致：扇区从正上方（12 点，0°）开始顺时针排列。
// 第 index 个扇区占据 [index*span, (index+1)*span)，其中心角 = sectorCenterDeg(index)。
function sectorWedgeStyle(index: number) {
  const count = sectorCount.value;
  const span = sectorSpanDeg(count);
  const start = index * span;
  const seam = count > 2 ? Math.min(1.6, span * 0.05) : 0;
  const color = WHEEL_SECTOR_COLORS[index % WHEEL_SECTOR_COLORS.length];
  return {
    background: `conic-gradient(from ${start}deg, ${color} 0deg ${Math.max(span - seam, 0.5)}deg, #ffffff ${Math.max(span - seam, 0.5)}deg ${span}deg, transparent ${span}deg)`
  };
}
// 菜名标签「骑」在所属扇区的径向位置（跟随盘面旋转），但始终反向补偿到水平，
// 因此转盘过程中与停下后文字都保持可读（rotation 每帧更新驱动补偿）。
function sectorLabelStyle(index: number) {
  const count = sectorCount.value;
  // 唯一候选时没有扇区边界压力：不旋转、更宽、贴近中心，直接横排菜名
  if (count <= 1) {
    return { width: '180px', transform: 'translate(-50%, -50%) translateY(-64px)' };
  }
  const mid = sectorCenterDeg(index, count);
  const rotate = rotation.value + mid;
  const width = Math.min(140, Math.max(36, 2 * 78 * Math.sin((sectorSpanDeg(count) * Math.PI) / 360)));
  return {
    width: `${Math.round(width)}px`,
    transform: `translate(-50%, -50%) rotate(${rotate}deg) translateY(-78px) rotate(${-rotate}deg)`
  };
}
function sectorLabelClass(index: number) {
  return {
    'wheel-sector__label': true,
    'wheel-sector__label--landed': resultReady.value && index === targetSectorIndex.value
  };
}
const wheelLabelFontSize = computed(() => {
  const count = sectorCount.value;
  if (count <= 4) return '15px';
  if (count <= 6) return '13px';
  if (count <= 10) return '11px';
  return '10px';
});
const wheelAriaLabel = computed(() => {
  const names = wheelCandidates.value.map((r) => r.name).join('、');
  return `随机转盘，候选：${names || '暂无候选'}`;
});

function clearSpinTimers() {
  if (spinTimer) {
    clearTimeout(spinTimer);
    spinTimer = null;
  }
}
/** 几何不变时直接重置盘面：回到 12 点初始朝向并清除结果（餐次/候选切换后调用）。 */
function resetWheel() {
  clearSpinTimers();
  spinning.value = false;
  rotation.value = 0;
  lastRotation.value = 0;
}

// —— 转盘决策（业务结果先决定，动画只负责把盘面转到结果所在的扇区） ——
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
    const chosen = result;
    spinResult.value = chosen;
    const targetIndex = wheelCandidates.value.findIndex((r) => r.id === chosen.resultId);
    const count = sectorCount.value;

    // —— 让盘面转到业务结果所在扇区（确定性对齐；整圈数只影响观感） ——
    // 只有目标确实在当前扇区集合内才做几何对齐；防御态（集合与结果不同步）直接展示结果。
    if (targetIndex >= 0 && count > 1) {
      if (!spinSequence.isCurrent(sequence)) return;
      const from = lastRotation.value;
      const to = wheelRotationForTarget(targetIndex, count, from + WHEEL_MIN_ADVANCE_DEG);
      lastRotation.value = to;
      if (prefersReducedMotion()) {
        // 尊重系统减弱动效：直接到最终朝向，结果立即呈现
        rotation.value = to;
      } else {
        // 逐帧驱动盘面旋转并自然减速（easeOutCubic）：
        // 动画只负责把盘面带到业务结果所在扇区，落点由 wheelRotationForTarget 决定。
        const startTime = Date.now();
        const frameStep = () => {
          clearSpinTimers();
          if (!spinSequence.isCurrent(sequence)) return;
          const elapsed = Date.now() - startTime;
          const t = Math.min(elapsed / WHEEL_SPIN_MS, 1);
          const eased = 1 - Math.pow(1 - t, 3);
          rotation.value = from + (to - from) * eased;
          if (t < 1) {
            spinTimer = setTimeout(frameStep, 16);
            return;
          }
          rotation.value = to;
          spinning.value = false;
          resultReady.value = true;
        };
        spinTimer = setTimeout(frameStep, 16);
        return;
      }
    }
    // 唯一候选 / 防御态 / prefers-reduced-motion：跳过旋转等待，结果立即呈现
    spinning.value = false;
    resultReady.value = true;
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
// 「就吃这个」→ 完成这一餐：把推荐上下文显式传给 CompleteMealPage，
// 让它优先采用当前餐次，而不是按当前时间重新推断（避免「晚餐转盘选出 → 被推断成下午茶」）。
function eatThis(recipeId: string) {
  router.push({ name: 'complete-meal', query: buildEatThisQuery(recipeId, mealType.value) });
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
  clearSpinTimers();
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
  resetWheel();
  resultReady.value = false;
  spinResult.value = null;
  spinHistoryId.value = '';
  void loadCandidates();
});
// UXB-004：候选集合（增删/启用切换）变化会改变扇区角度，旧落点不再成立，
// 重置盘面与结果，并作废在途 spin（旧集合的旋转结果对当前盘面无效）。
watch(wheelSignature, () => {
  spinSequence.next();
  resetWheel();
  resultReady.value = false;
  spinResult.value = null;
  spinHistoryId.value = '';
});
async function generate() {
  if (mode.value === 'random') return; // 随机决策统一走转盘，避免「生成推荐/转一下」双重入口
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
function retryDecision() {
  if (mode.value === 'random') void spin();
  else void generate();
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
        <p class="business-eyebrow">{{ modeLabels[mode] }}</p>
        <h1>今天吃什么</h1>
        <p v-if="selectedDinerIds.length">结果来自真实菜谱与食用者偏好；忌口和过敏始终硬过滤。</p>
        <p v-else>未选择食用者：本次推荐结果不会应用忌口与过敏过滤。</p>
      </div>
      <AppButton v-if="mode !== 'random'" :loading="loading" @click="generate">生成推荐</AppButton>
    </header>

    <!-- 候选池 -->
    <div class="app-card candidate-pool">
      <div class="candidate-pool__header">
        <span class="candidate-pool__count">
          {{ displayLabel(mealType) }}候选：<strong>{{ candidateLoading ? '…' : candidateCount }}</strong> 道
        </span>
        <AppButton variant="secondary" size="sm" @click="showCandidatePanel = !showCandidatePanel">
          {{ showCandidatePanel ? '收起候选菜' : '管理候选菜' }}
        </AppButton>
      </div>
      <div v-if="showCandidatePanel" class="candidate-pool__body">
        <p v-if="candidateLoading" class="candidate-pool__hint">加载中…</p>
        <template v-else-if="candidateRecipes.length">
          <p class="candidate-pool__hint">勾选「参与随机」的菜谱才会进入转盘。</p>
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
      <template v-if="sectorCount > 0">
        <div class="spin-wheel" role="img" :aria-label="wheelAriaLabel">
          <div class="spin-wheel__pointer" aria-hidden="true"></div>
          <div class="spin-wheel__disc" :style="{ transform: `rotate(${rotation}deg)` }">
            <div
              v-for="(recipe, index) in wheelCandidates"
              :key="recipe.id"
              class="wheel-sector"
              :class="{ 'wheel-sector--landed': resultReady && index === targetSectorIndex }"
              :style="sectorWedgeStyle(index)"
            ></div>
            <span
              v-for="(recipe, index) in wheelCandidates"
              :key="`label-${recipe.id}`"
              :class="sectorLabelClass(index)"
              :style="sectorLabelStyle(index)"
              :title="recipe.name"
            >
              <span
                class="wheel-sector__label-inner"
                :style="{ fontSize: wheelLabelFontSize }"
                :class="{ 'wheel-sector__label-inner--landed': resultReady && index === targetSectorIndex }"
                >{{ recipe.name }}</span
              >
            </span>
          </div>
          <div class="spin-wheel__hub" aria-hidden="true">
            <img :src="brandLogo" alt="" />
          </div>
        </div>

        <div class="spin-wheel__status" role="status" aria-live="polite">
          <span v-if="spinning" class="spin-wheel__status-text">正在转动，指针停下就知道答案…</span>
          <span v-else-if="resultReady && spinResult" class="spin-wheel__result-pill">
            <span class="spin-wheel__result-pill-mark" aria-hidden="true">✓</span>{{ spinResult.title }}
          </span>
          <span v-else-if="sectorCount === 1" class="spin-wheel__status-hint"
            >当前餐次唯一候选：{{ wheelCandidates[0]?.name }}</span
          >
          <span v-else class="spin-wheel__status-hint"
            >点「转一下」，让指针替你从 {{ sectorCount }} 道菜里随机决定</span
          >
        </div>

        <AppButton :loading="spinning" :disabled="candidateCount === 0 || spinning" @click="spin()">
          {{ spinning ? '转动中…' : resultReady ? '再转一次' : '转一下' }}
        </AppButton>
        <div v-if="resultReady && spinResult" class="spin-result__actions">
          <AppButton variant="secondary" size="sm" @click="reroll">换一个</AppButton>
          <AppButton size="sm" @click="eatThis(spinResult.resultId)">就吃这个</AppButton>
          <AppButton variant="secondary" size="sm" :loading="loading" @click="addToPlanFromSpin">加入计划</AppButton>
          <RouterLink class="text-button" :to="`/recipes/${spinResult.resultId}`">查看详情 →</RouterLink>
        </div>
      </template>

      <template v-else>
        <div class="spin-wheel__empty">
          <p class="spin-section__hint" v-if="!candidateLoading">
            当前餐次候选池为空，请先
            <RouterLink to="/recipes/new">新增菜谱</RouterLink>
            或在候选管理中勾选已有菜谱的「参与随机」。
          </p>
          <p v-else class="spin-section__hint">加载候选菜谱中…</p>
          <AppButton :disabled="true">转一下</AppButton>
        </div>
      </template>
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
    <template v-if="mode !== 'random'">
      <AppErrorState v-if="error" title="暂时无法推荐" :description="error" @retry="retryDecision" />
      <AppEmptyState
        v-else-if="!results.length && !loading"
        title="今天吃什么？"
        description="选择推荐方式后点「生成推荐」，系统会解释每个结果为什么适合。"
      />
      <template v-else>
        <div class="business-card__actions">
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
          <article
            v-for="result in results"
            :key="result.resultId"
            class="business-card app-card recommendation-result"
          >
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
        </div>
      </template>
    </template>
    <template v-else>
      <AppErrorState v-if="error" title="暂时无法推荐" :description="error" @retry="retryDecision" />
    </template>
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

/* 转盘（UXB-004 真圆形转盘） */
.spin-section {
  display: grid;
  gap: var(--space-4);
  text-align: center;
  border-top: 4px solid #f3bdcb;
  transition: border-color var(--motion-fast) ease;
  justify-items: center;
}
.spin-section--result {
  border-top-color: var(--color-primary);
}
.spin-wheel {
  --wheel-size: 272px;
  position: relative;
  width: var(--wheel-size);
  height: var(--wheel-size);
  margin-top: var(--space-5);
}
.spin-wheel__disc {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  overflow: hidden;
  border: 1px solid rgba(120, 70, 90, 0.16);
  box-shadow:
    0 10px 26px rgba(122, 70, 90, 0.16),
    inset 0 0 0 6px #fff;
  will-change: transform; /* 逐帧旋转避免重排 */
}
.spin-wheel__pointer {
  position: absolute;
  top: -10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 4;
  width: 0;
  height: 0;
  border-left: 11px solid transparent;
  border-right: 11px solid transparent;
  border-top: 18px solid var(--color-primary-hover);
  filter: drop-shadow(0 2px 3px rgba(122, 70, 90, 0.25));
}
.spin-wheel__pointer::after {
  content: '';
  position: absolute;
  top: -18px;
  left: -6px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(122, 70, 90, 0.28);
}
.wheel-sector {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  transition: filter 300ms ease;
}
.wheel-sector--landed {
  filter: brightness(1.14) saturate(1.12);
}
.wheel-sector__label {
  position: absolute;
  left: 50%;
  top: 50%;
  display: block;
  text-align: center;
  pointer-events: none;
  line-height: 1.25;
}
.wheel-sector__label-inner {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #fff;
  font-weight: var(--font-weight-bold);
  text-shadow: 0 1px 2px rgba(90, 40, 60, 0.32);
}
.wheel-sector__label-inner--landed {
  animation: wheel-label-pop 480ms cubic-bezier(0.2, 0.8, 0.3, 1.4);
}
.spin-wheel__hub {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 84px;
  height: 84px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 4px 14px rgba(122, 70, 90, 0.22);
  z-index: 2;
  display: grid;
  place-items: center;
  overflow: hidden;
  pointer-events: none;
}
.spin-wheel__hub img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}
.spin-wheel__status {
  min-height: 30px;
  display: grid;
  place-items: center;
  padding: 0 var(--space-4);
}
.spin-wheel__status-text {
  color: var(--color-text-secondary);
  font-size: 14px;
}
.spin-wheel__status-hint {
  color: var(--color-text-muted);
  font-size: 13px;
}
.spin-wheel__result-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: var(--radius-tag);
  background: var(--color-primary-soft);
  color: var(--color-primary-hover);
  font-size: 17px;
  font-weight: var(--font-weight-bold);
  animation: wheel-pill-pop 420ms cubic-bezier(0.2, 0.8, 0.3, 1.35);
}
.spin-wheel__result-pill-mark {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--color-primary);
  color: #fff;
  font-size: 12px;
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
.spin-wheel__empty {
  display: grid;
  justify-items: center;
  gap: var(--space-4);
  padding: var(--space-6) 0;
}
@keyframes wheel-pill-pop {
  0% {
    transform: scale(0.72);
    opacity: 0.4;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}
@keyframes wheel-label-pop {
  0% {
    transform: scale(0.8);
  }
  100% {
    transform: scale(1);
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
  .spin-wheel {
    --wheel-size: 236px;
    transform: scale(0.94);
    margin-top: var(--space-2);
  }
}
@media (max-width: 400px) {
  .spin-wheel {
    --wheel-size: 210px;
    transform: scale(0.92);
  }
}
</style>
