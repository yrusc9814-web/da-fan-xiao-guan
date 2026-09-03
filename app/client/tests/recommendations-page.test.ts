import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import RecommendationsPage, {
  pickDifferentCandidate,
  sectorCenterDeg,
  sectorIndexAtPointer,
  sectorSpanDeg,
  wheelRotationForTarget,
  type SpinCandidate
} from '../src/pages/RecommendationsPage.vue';

const diners = [
  { id: 'diner-1', name: '验收-张三' },
  { id: 'diner-2', name: '验收-李四' }
];

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data, error: null })
  };
}

function buildFetch() {
  return vi.fn().mockImplementation((input: unknown, _init?: { method?: string; body?: string }) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/diners')) return Promise.resolve(jsonResponse({ items: diners }));
    if (path.endsWith('/recommendations/random') || path.endsWith('/recommendations/meal-set'))
      return Promise.resolve(
        jsonResponse({
          historyId: 'history-1',
          results: [
            {
              resultType: 'RECIPE',
              resultId: 'recipe-1',
              title: '验收-测试菜',
              reason: '测试',
              missingIngredients: []
            }
          ]
        })
      );
    if (path.endsWith('/kitchen/recommend'))
      return Promise.resolve(jsonResponse({ mode: 'ALLOW_PURCHASE', candidateCount: 0, items: [] }));
    if (path.includes('/add-to-plan'))
      return Promise.resolve(jsonResponse({ plan: { id: 'plan-1' }, historyId: 'history-1' }));
    if (path.endsWith('/shopping-lists') && (_init?.method ?? 'GET') === 'POST')
      return Promise.resolve(jsonResponse({ id: 'list-1', version: 1, items: [] }));
    return Promise.resolve(jsonResponse({ items: [] }));
  });
}

async function mountAt(mode: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/recommendations', component: RecommendationsPage }]
  });
  await router.push(`/recommendations?mode=${mode}`);
  const fetchMock = buildFetch();
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(RecommendationsPage, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router, fetchMock };
}

function postBody(fetchMock: ReturnType<typeof vi.fn>, predicate: (path: string) => boolean) {
  const call = fetchMock.mock.calls.find(([input, init]) => {
    const url = new URL(String(input));
    return (init?.method ?? 'GET') === 'POST' && predicate(url.pathname);
  });
  expect(call, '未找到匹配的 POST 请求').toBeTruthy();
  return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function candidate(id: string, name: string, enabled = true, mealTypes: string[] = []): SpinCandidate {
  return { id, name, enabledForRecommendation: enabled, version: 1, mealTypes };
}

describe('「换一个」确定性兜底 pickDifferentCandidate', () => {
  it('2 候选（当前=A）：必返回 B，与概率无关', () => {
    const result = pickDifferentCandidate([candidate('a', '菜A'), candidate('b', '菜B')], 'a');
    expect(result).toEqual({ resultType: 'RECIPE', resultId: 'b', title: '菜B' });
  });

  it('多候选（当前=A）+ A 权重极高：仍保证返回非 A 候选', () => {
    // 候选池顺序模拟 A 优先（如带权排序），兜底逻辑必须无视顺序挑选非 A
    const pool = [candidate('a', '菜A'), candidate('b', '菜B'), candidate('c', '菜C'), candidate('d', '菜D')];
    const result = pickDifferentCandidate(pool, 'a');
    expect(result).toBeTruthy();
    expect(result!.resultId).not.toBe('a');
  });

  it('候选池只有 1 个（当前=A）：返回 null，语义为暂时没有别的候选', () => {
    expect(pickDifferentCandidate([candidate('a', '菜A')], 'a')).toBeNull();
  });

  it('当前结果不在候选池：任意启用候选都是不同结果，直接返回', () => {
    expect(pickDifferentCandidate([candidate('a', '菜A')], 'x')).toEqual({
      resultType: 'RECIPE',
      resultId: 'a',
      title: '菜A'
    });
  });

  it('停用（不参与推荐）的候选不计入可选池', () => {
    const pool = [candidate('a', '菜A'), candidate('b', '菜B', false)];
    expect(pickDifferentCandidate(pool, 'a')).toBeNull();
  });

  it('候选池为空：返回 null', () => {
    expect(pickDifferentCandidate([], 'a')).toBeNull();
  });

  // UXA-002 / Case A1（单元层）：fallback 只能在当前餐次候选集合内选择
  it('Case A1：mealType 过滤——BREAKFAST-only 候选不参与 DINNER 兜底', () => {
    const pool = [candidate('a', '菜A', true, ['BREAKFAST']), candidate('b', '菜B', true, ['DINNER'])];
    // 当前结果是 B（DINNER 唯一合法候选）：不得返回早餐菜 A，返回 null
    expect(pickDifferentCandidate(pool, 'b', 'DINNER')).toBeNull();
    // 当前结果是 A：DINNER 内唯一合法候选是 B，正常返回
    expect(pickDifferentCandidate(pool, 'a', 'DINNER')).toEqual({ resultType: 'RECIPE', resultId: 'b', title: '菜B' });
  });

  // UXA-002 / Case A4：极端权重/任意候选顺序下，兜底永不返回当前结果本身，也不跨餐次
  it('Case A4：任意顺序/极端池下，fallback 都不返回当前结果本身且不跨餐次', () => {
    const pool = [
      candidate('a', '菜A', true, ['DINNER']),
      candidate('b', '菜B', true, ['DINNER']),
      candidate('c', '菜C', true, ['DINNER']),
      candidate('x', '早餐菜X', true, ['BREAKFAST'])
    ];
    for (let round = 0; round < 200; round += 1) {
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      const result = pickDifferentCandidate(shuffled, 'a', 'DINNER');
      expect(result).toBeTruthy();
      expect(result!.resultId).not.toBe('a');
      expect(result!.resultId).not.toBe('x');
    }
    // 当前餐次只剩当前结果 1 个合法候选：必须返回 null，而不是拿 BREAKFAST 菜顶替
    const onlyCurrent = [pool[0]!, pool[3]!];
    expect(pickDifferentCandidate(onlyCurrent, 'a', 'DINNER')).toBeNull();
  });
});

describe('真圆形转盘几何（UXB-004 单元）', () => {
  it('扇区等分：2 个候选每扇 180°，4 个候选每扇 90°', () => {
    expect(sectorSpanDeg(2)).toBe(180);
    expect(sectorSpanDeg(4)).toBe(90);
    expect(sectorSpanDeg(6)).toBe(60);
  });

  it('扇区中心角从正上方顺时针排列', () => {
    // index0 中心在扇区前 1/2 处；4 扇区时中心依次为 45/135/225/315
    expect(sectorCenterDeg(0, 4)).toBe(45);
    expect(sectorCenterDeg(1, 4)).toBe(135);
    expect(sectorCenterDeg(2, 4)).toBe(225);
    expect(sectorCenterDeg(3, 4)).toBe(315);
    expect(sectorCenterDeg(1, 2)).toBe(270);
  });

  it('wheelRotationForTarget 把目标扇区中心转到指针（顶部，0°）', () => {
    // 2 扇区 index0 中心 90°：盘面顺时针转 270° 后中心到顶部
    expect(wheelRotationForTarget(0, 2, 0)).toBe(270);
    expect(sectorIndexAtPointer(270, 2)).toBe(0);
    // 2 扇区 index1 中心 270°：顺时针转 90°
    expect(wheelRotationForTarget(1, 2, 0)).toBe(90);
    expect(sectorIndexAtPointer(90, 2)).toBe(1);
  });

  it('minTravel 保证每次至少前进指定角度，且只叠加整圈不影响落点', () => {
    // index1(2扇区) 基础 90°；minTravel 720 → 90+720=810，落点仍是 index1
    expect(wheelRotationForTarget(1, 2, 720)).toBe(810);
    expect(sectorIndexAtPointer(810, 2)).toBe(1);
    // index0(4扇区) 基础 315°；minTravel 1000 → 315+720=1035
    expect(wheelRotationForTarget(0, 4, 1000)).toBe(1035);
    expect(sectorIndexAtPointer(1035, 4)).toBe(0);
  });

  it('性质检验：任意候选数与目标下，落点扇区与目标一一对应', () => {
    for (let count = 1; count <= 12; count += 1) {
      for (let index = 0; index < count; index += 1) {
        for (const minTravel of [0, 90, 360, 720, 1333]) {
          const rotation = wheelRotationForTarget(index, count, minTravel);
          expect(rotation).toBeGreaterThanOrEqual(minTravel);
          expect(sectorIndexAtPointer(rotation, count)).toBe(index);
        }
      }
    }
  });

  it('扇区下标读回与几何定义一致（多整圈等价性）', () => {
    for (let count = 2; count <= 8; count += 1) {
      for (let turns = 0; turns < 6; turns += 1) {
        const rotation = turns * 360;
        // 旋转整圈后指针正对的扇区与初始一致
        const landed = sectorIndexAtPointer(rotation, count);
        expect(landed).toBe(sectorIndexAtPointer(0, count));
      }
    }
  });
});

/**
 * 构造「餐次感知」的 fetch mock：/recipes 按 mealType 查询参数过滤（模拟服务端
 * GET /recipes?mealType=... 的 mealTypes.some 过滤），/recommendations/random 恒定返回指定结果。
 */
function buildCandidateAwareFetch(options: {
  recipes: SpinCandidate[];
  randomResult: { resultId: string; title: string };
  randomHistoryId?: string;
}) {
  return vi.fn().mockImplementation((input: unknown) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith('/diners')) return Promise.resolve(jsonResponse({ items: diners }));
    if (path.endsWith('/recipes')) {
      const mealType = url.searchParams.get('mealType');
      const filtered = mealType
        ? options.recipes.filter((r) => (r.mealTypes ?? []).includes(mealType))
        : options.recipes;
      return Promise.resolve(jsonResponse({ items: filtered, total: filtered.length }));
    }
    if (path.endsWith('/recommendations/random'))
      return Promise.resolve(
        jsonResponse({
          historyId: options.randomHistoryId ?? 'history-x',
          results: [
            {
              resultType: 'RECIPE',
              resultId: options.randomResult.resultId,
              title: options.randomResult.title,
              reason: '测试',
              missingIngredients: []
            }
          ]
        })
      );
    return Promise.resolve(jsonResponse({ items: [] }));
  });
}

type MountWheelReturn = Awaited<ReturnType<typeof mountSpinPage>>['wrapper'];

async function mountSpinPage(fetchMock: ReturnType<typeof vi.fn>, options: { reducedMotion?: boolean } = {}) {
  vi.stubGlobal('fetch', fetchMock);
  if (options.reducedMotion) {
    const media = (query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    });
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(media));
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/recommendations', component: RecommendationsPage }]
  });
  await router.push('/recommendations?mode=random');
  const wrapper = mount(RecommendationsPage, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router, fetchMock };
}

async function clickButton(wrapper: MountWheelReturn, text: string) {
  const btn = wrapper.findAll('button').find((b) => b.text().includes(text));
  expect(btn, `未找到按钮 ${text}`).toBeTruthy();
  await btn!.trigger('click');
}

function countRandomPosts(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    ([input, init]) => (init?.method ?? 'GET') === 'POST' && String(input).includes('/recommendations/random')
  );
}

/** 读取盘面当前 transform 旋转角（度） */
function discRotationDeg(wrapper: MountWheelReturn): number {
  const disc = wrapper.find('.spin-wheel__disc');
  const style = disc.attributes('style') ?? '';
  const match = style.match(/rotate\((-?[\d.]+)deg\)/);
  expect(match, `盘面 style 未含 rotate: ${style}`).toBeTruthy();
  return Number(match![1]);
}

function resultPillText(wrapper: MountWheelReturn): string {
  const pill = wrapper.find('.spin-wheel__result-pill');
  expect(pill.exists(), '未找到结果胶囊').toBe(true);
  return pill.text();
}

async function settleSpin(wrapper: MountWheelReturn) {
  await flushPromises();
  if (!wrapper.find('.spin-wheel__result-pill').exists()) {
    // 正常动效路径需等待旋转过渡完成
    await new Promise((resolve) => setTimeout(resolve, 2600));
    await flushPromises();
  }
  expect(wrapper.find('.spin-wheel__result-pill').exists(), '旋转后应呈现结果').toBe(true);
}

// Case A1：候选池（数量 + 管理列表）按当前餐次过滤
describe('候选池按当前餐次过滤（UXA-001）', () => {
  it('Case A1：DINNER 候选只计/只显示 DINNER 菜谱，切换餐次后候选同步刷新', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [candidate('a', '早餐菜A', true, ['BREAKFAST']), candidate('b', '晚餐菜B', true, ['DINNER'])],
      randomResult: { resultId: 'b', title: '晚餐菜B' }
    });
    const { wrapper } = await mountSpinPage(fetchMock, { reducedMotion: true });

    // 候选池请求必须带当前餐次 mealType=DINNER
    const recipeCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/recipes'));
    expect(recipeCalls.length).toBeGreaterThan(0);
    expect(new URL(String(recipeCalls[0]![0])).searchParams.get('mealType')).toBe('DINNER');

    // 候选数量只计 DINNER 候选（B），早餐菜A 不计入
    expect(wrapper.find('.candidate-pool__count strong').text()).toBe('1');
    expect(wrapper.text()).toContain('晚餐');

    // 管理面板只显示当前餐次有效候选
    await clickButton(wrapper, '管理候选菜');
    await flushPromises();
    const panelItems = wrapper.findAll('.candidate-item').map((item) => item.text());
    expect(panelItems).toHaveLength(1);
    expect(panelItems[0]).toContain('晚餐菜B');

    // 切换餐次为早餐：候选池重新加载并只显示早餐菜A
    const mealSelect = wrapper.findAll('select')[1]!;
    await mealSelect.setValue('BREAKFAST');
    await flushPromises();
    const breakfastCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('mealType=BREAKFAST'));
    expect(breakfastCalls.length).toBeGreaterThan(0);
    expect(wrapper.find('.candidate-pool__count strong').text()).toBe('1');
    const panelItemsAfter = wrapper.findAll('.candidate-item').map((item) => item.text());
    expect(panelItemsAfter).toHaveLength(1);
    expect(panelItemsAfter[0]).toContain('早餐菜A');
  });

  it('餐次切换时清空旧餐次的转盘结果，不把旧结果带入新餐次', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [candidate('a', '菜A', true, ['DINNER']), candidate('b', '菜B', true, ['DINNER'])],
      randomResult: { resultId: 'a', title: '菜A' }
    });
    const { wrapper } = await mountSpinPage(fetchMock, { reducedMotion: true });
    await clickButton(wrapper, '转一下');
    await settleSpin(wrapper);
    expect(resultPillText(wrapper)).toContain('菜A');

    const mealSelect = wrapper.findAll('select')[1]!;
    await mealSelect.setValue('LUNCH');
    await flushPromises();
    // 结果清空、盘面移除（LUNCH 无候选 → 空态），绝不残留旧结果
    expect(wrapper.find('.spin-wheel__result-pill').exists()).toBe(false);
    expect(wrapper.find('.spin-wheel__disc').exists()).toBe(false);
    expect(wrapper.text()).toContain('候选池为空');
  });
});

describe('真圆形转盘展示与业务对齐（UXB-004）', () => {
  it('多候选：盘面渲染 N 个清晰扇区与可识别菜名，扇区顺序=候选顺序', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [
        candidate('a', '番茄炒蛋', true, ['DINNER']),
        candidate('b', '青椒肉丝', true, ['DINNER']),
        candidate('c', '红烧排骨', true, ['DINNER'])
      ],
      randomResult: { resultId: 'b', title: '青椒肉丝' }
    });
    const { wrapper } = await mountSpinPage(fetchMock, { reducedMotion: true });

    // 3 个扇区、固定指针、扇区顺序与候选列表一致（aria 按序描述）
    expect(wrapper.findAll('.wheel-sector')).toHaveLength(3);
    expect(wrapper.find('.spin-wheel__pointer').exists()).toBe(true);
    expect(wrapper.find('.spin-wheel').attributes('aria-label')).toContain('番茄炒蛋、青椒肉丝、红烧排骨');
    const labels = wrapper.findAll('.wheel-sector__label-inner').map((el) => el.text());
    expect(labels).toEqual(['番茄炒蛋', '青椒肉丝', '红烧排骨']);
  });

  it('转一下：旋转终点精确落在业务结果所在扇区中心（视觉==业务），结果后不再显示空状态', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [candidate('a', '菜A', true, ['DINNER']), candidate('b', '菜B', true, ['DINNER'])],
      randomResult: { resultId: 'b', title: '菜B' }
    });
    const { wrapper } = await mountSpinPage(fetchMock, { reducedMotion: true });

    await clickButton(wrapper, '转一下');
    await settleSpin(wrapper);

    // 业务结果 = 服务端返回的菜B
    expect(resultPillText(wrapper)).toContain('菜B');
    // 视觉结果 = 盘面停在菜B 扇区中心：2 扇区 index1 需转 90°，minTravel 两整圈 → 810°
    expect(discRotationDeg(wrapper)).toBe(wheelRotationForTarget(1, 2, 720));
    expect(discRotationDeg(wrapper)).toBe(810);
    expect(sectorIndexAtPointer(discRotationDeg(wrapper), 2)).toBe(1);
    // 结果态不残留「空状态」提示
    expect(wrapper.text()).not.toContain('候选池为空');
  });

  it('再转一次：在既有盘面角度上累计旋转，仍精确停在新的业务结果扇区', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [candidate('a', '菜A', true, ['DINNER']), candidate('b', '菜B', true, ['DINNER'])],
      randomResult: { resultId: 'b', title: '菜B' }
    });
    const { wrapper } = await mountSpinPage(fetchMock, { reducedMotion: true });
    // 第一次停在菜B（810°）
    await clickButton(wrapper, '转一下');
    await settleSpin(wrapper);
    expect(resultPillText(wrapper)).toContain('菜B');

    // 第二次服务端返回菜A
    fetchMock.mockImplementation((input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/diners')) return Promise.resolve(jsonResponse({ items: diners }));
      if (url.pathname.endsWith('/recommendations/random'))
        return Promise.resolve(
          jsonResponse({
            historyId: 'history-2',
            results: [{ resultType: 'RECIPE', resultId: 'a', title: '菜A', reason: '测试', missingIngredients: [] }]
          })
        );
      return Promise.resolve(jsonResponse({ items: [] }));
    });
    await clickButton(wrapper, '再转一次');
    await settleSpin(wrapper);
    expect(resultPillText(wrapper)).toContain('菜A');
    // 2 扇区 index0 基础 270°，相对上次 810° 至少再进 720° → 270+1440=1710°
    expect(discRotationDeg(wrapper)).toBe(wheelRotationForTarget(0, 2, 810 + 720));
    expect(discRotationDeg(wrapper)).toBe(1710);
    expect(sectorIndexAtPointer(discRotationDeg(wrapper), 2)).toBe(0);
  });

  it('仅 1 个候选：完整圆盘展示该候选，点转一下直接得到该结果（合理单候选语义）', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [candidate('a', '唯一好菜', true, ['DINNER'])],
      randomResult: { resultId: 'a', title: '唯一好菜' }
    });
    const { wrapper } = await mountSpinPage(fetchMock, { reducedMotion: true });
    // 转盘展示 1 个扇区并提示唯一候选
    expect(wrapper.findAll('.wheel-sector')).toHaveLength(1);
    expect(wrapper.text()).toContain('唯一候选');
    expect(wrapper.text()).toContain('唯一好菜');

    await clickButton(wrapper, '转一下');
    await settleSpin(wrapper);
    expect(resultPillText(wrapper)).toContain('唯一好菜');
  });

  it('0 候选：显示正确空态且不可转（不会发起随机请求）', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [candidate('a', '早餐菜A', true, ['BREAKFAST'])], // 当前 DINNER 无候选
      randomResult: { resultId: 'x', title: 'x' }
    });
    const { wrapper } = await mountSpinPage(fetchMock, { reducedMotion: true });
    expect(wrapper.text()).toContain('候选池为空');
    const spinButtons = wrapper.findAll('button').filter((b) => b.text().includes('转一下'));
    expect(spinButtons.length).toBeGreaterThan(0);
    for (const btn of spinButtons) expect(btn.attributes('disabled')).toBeDefined();
    expect(countRandomPosts(fetchMock)).toHaveLength(0);
  });
});

describe('「换一个」确定性接入转盘（不依赖随机）', () => {
  // Case A3：当前餐次有 2 个合法候选时，换一个后 After != Before
  it('Case A3：候选池 2 道菜、API 恒返回当前结果：点「换一个」必得另一道菜且同样停在对应扇区', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [candidate('a', '菜A', true, ['DINNER']), candidate('b', '菜B', true, ['DINNER'])],
      randomResult: { resultId: 'a', title: '菜A' }
    });
    const { wrapper } = await mountSpinPage(fetchMock, { reducedMotion: true });

    // 1. 转一下：得到菜A（API 恒返回菜A）
    await clickButton(wrapper, '转一下');
    await settleSpin(wrapper);
    expect(resultPillText(wrapper)).toContain('菜A');

    // 2. 换一个：API 4 次重试都返回菜A，必须走确定性兜底换成菜B
    await clickButton(wrapper, '换一个');
    await settleSpin(wrapper);
    expect(resultPillText(wrapper)).toContain('菜B');
    // 换一个同样走几何对齐：第一次停菜A(index0, 990°)；换到菜B(index1, 基础90°)
    // 需相对上次至少再进 720° → 90 + 5×360 = 1890°
    expect(discRotationDeg(wrapper)).toBe(1890);
    expect(sectorIndexAtPointer(discRotationDeg(wrapper), 2)).toBe(1);

    // 3. 随机 API 调用计数：初次 1 次 + 换一个 4 次 = 5 次，全部返回菜A
    expect(countRandomPosts(fetchMock)).toHaveLength(5);
  });

  // Case A2：当前餐次只剩 1 个合法候选时，不得跨餐次补位，给出明确提示
  it('Case A2：DINNER 仅剩 1 个候选时「换一个」不跨餐次拿 BREAKFAST 菜，得到明确提示', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [candidate('a', '早餐菜A', true, ['BREAKFAST']), candidate('b', '晚餐菜B', true, ['DINNER'])],
      randomResult: { resultId: 'b', title: '晚餐菜B' }
    });
    const { wrapper } = await mountSpinPage(fetchMock, { reducedMotion: true });

    await clickButton(wrapper, '转一下');
    await settleSpin(wrapper);
    expect(resultPillText(wrapper)).toContain('晚餐菜B');

    await clickButton(wrapper, '换一个');
    await flushPromises();
    // 明确提示「这个餐次暂时没有其他候选菜」，而不是静默换菜
    expect(wrapper.text()).toContain('这个餐次暂时没有其他候选菜');
    // 结果保持原样，绝没有变成早餐菜A
    expect(resultPillText(wrapper)).toContain('晚餐菜B');
    // guard 直接拦截：没有为「换一个」发起额外的随机请求
    expect(countRandomPosts(fetchMock)).toHaveLength(1);
  });
});

describe('正常动效与 reduced-motion（UXB-004）', () => {
  it('尊重 prefers-reduced-motion：结果即时呈现，不等旋转过渡', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [candidate('a', '菜A', true, ['DINNER']), candidate('b', '菜B', true, ['DINNER'])],
      randomResult: { resultId: 'b', title: '菜B' }
    });
    const { wrapper } = await mountSpinPage(fetchMock, { reducedMotion: true });
    await clickButton(wrapper, '转一下');
    await flushPromises();
    // 无 2.4s 等待：flush 后结果已呈现
    expect(resultPillText(wrapper)).toContain('菜B');
  });

  it('正常动效：旋转期间不揭示结果，自然减速结束后才呈现', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [candidate('a', '菜A', true, ['DINNER']), candidate('b', '菜B', true, ['DINNER'])],
      randomResult: { resultId: 'b', title: '菜B' }
    });
    // 不 stub matchMedia：jsdom 无 matchMedia → 走完整旋转过渡
    const { wrapper } = await mountSpinPage(fetchMock);
    await clickButton(wrapper, '转一下');
    await flushPromises();
    // 旋转中：按钮提示转动中，尚未出现结果胶囊
    expect(wrapper.find('.spin-wheel__result-pill').exists()).toBe(false);
    expect(wrapper.findAll('button').some((b) => b.text().includes('转动中'))).toBe(true);

    // 旋转过渡结束后揭示结果，且按钮回到「再转一次」
    await new Promise((resolve) => setTimeout(resolve, 2600));
    await flushPromises();
    expect(resultPillText(wrapper)).toContain('菜B');
    expect(wrapper.findAll('button').some((b) => b.text().includes('再转一次'))).toBe(true);
  });
});

// Case A5：fallback 结果无 historyId 时，「加入计划」不能静默失败
describe('转盘结果加入计划（UXA-003）', () => {
  it('Case A5：fallback 结果没有 historyId，点「加入计划」走 POST /plans 且给出成功反馈', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [candidate('b1', '菜B1', true, ['DINNER']), candidate('b2', '菜B2', true, ['DINNER'])],
      randomResult: { resultId: 'b1', title: '菜B1' }
    });
    const { wrapper } = await mountSpinPage(fetchMock, { reducedMotion: true });

    await clickButton(wrapper, '转一下');
    await settleSpin(wrapper);
    await clickButton(wrapper, '换一个');
    await settleSpin(wrapper);
    expect(resultPillText(wrapper)).toContain('菜B2'); // fallback 结果

    await clickButton(wrapper, '加入计划');
    await flushPromises();

    // 没有伪造 historyId、没有调用 add-to-plan
    const addToPlanCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/add-to-plan'));
    expect(addToPlanCalls).toHaveLength(0);
    // 走标准的「直接创建计划」数据链
    const planPosts = fetchMock.mock.calls.filter(
      ([input, init]) => (init?.method ?? 'GET') === 'POST' && new URL(String(input)).pathname.endsWith('/plans')
    );
    expect(planPosts).toHaveLength(1);
    const body = JSON.parse((planPosts[0]![1] as RequestInit).body as string) as {
      planDate: string;
      mealType: string;
      items: Array<{ itemType: string; recipeId?: string; mealRole?: string; sortOrder?: number }>;
    };
    expect(body.mealType).toBe('DINNER');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ itemType: 'RECIPE', recipeId: 'b2', mealRole: 'MAIN', sortOrder: 0 });
    // 明确成功反馈，不是静默无反应
    expect(wrapper.text()).toContain('已加入');
    expect(wrapper.text()).not.toContain('暂时无法推荐');
  });

  it('正常 spin 结果（有 historyId）仍走 RecommendationHistory 的 add-to-plan 链路', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [candidate('b1', '菜B1', true, ['DINNER']), candidate('b2', '菜B2', true, ['DINNER'])],
      randomResult: { resultId: 'b2', title: '菜B2' },
      randomHistoryId: 'history-spin'
    });
    const { wrapper } = await mountSpinPage(fetchMock, { reducedMotion: true });

    await clickButton(wrapper, '转一下');
    await settleSpin(wrapper);
    expect(resultPillText(wrapper)).toContain('菜B2');

    await clickButton(wrapper, '加入计划');
    await flushPromises();

    const addCalls = fetchMock.mock.calls.filter(
      ([input, init]) =>
        (init?.method ?? 'GET') === 'POST' && String(input).includes('/recommendations/history-spin/add-to-plan')
    );
    expect(addCalls).toHaveLength(1);
    const body = JSON.parse((addCalls[0]![1] as RequestInit).body as string) as {
      mealType: string;
      dinerIds: string[];
    };
    expect(body.mealType).toBe('DINNER');
    expect(wrapper.text()).toContain('已加入');
  });
});

describe('推荐页首页入口与推荐方式', () => {
  it.each([
    ['random', 'random'],
    ['meal-set', 'meal-set'],
    ['inventory', 'inventory']
  ])('mode=%s 初始化为对应推荐方式', async (query, expected) => {
    const { wrapper } = await mountAt(query);
    expect(wrapper.findAll('select')[0]!.element.value).toBe(expected);
  });

  it('同组件 query 改变时同步模式，非法值回退 random', async () => {
    const { wrapper, router } = await mountAt('random');
    await router.push('/recommendations?mode=inventory');
    await flushPromises();
    expect(wrapper.findAll('select')[0]!.element.value).toBe('inventory');
    await router.push('/recommendations?mode=invalid');
    await flushPromises();
    expect(wrapper.findAll('select')[0]!.element.value).toBe('random');
  });

  it('random 模式收口到转盘：不再出现「生成推荐」按钮，转盘是唯一随机决策入口', async () => {
    const { wrapper } = await mountAt('random');
    expect(wrapper.findAll('button').some((b) => b.text().includes('生成推荐'))).toBe(false);
    expect(wrapper.findAll('button').some((b) => b.text().includes('转一下'))).toBe(true);
  });

  it('meal-set / inventory 模式保留「生成推荐」，结果区与购物清单操作可用', async () => {
    const { wrapper } = await mountAt('meal-set');
    const generateBtn = wrapper.findAll('button').find((b) => b.text().includes('生成推荐'));
    expect(generateBtn).toBeTruthy();
    await generateBtn!.trigger('click');
    await flushPromises();
    // meal-set mock 返回 1 条菜谱结果并展示其操作
    expect(wrapper.text()).toContain('验收-测试菜');
    expect(wrapper.findAll('button').some((b) => b.text().includes('整组加入计划'))).toBe(true);
  });
});

describe('推荐页食用者选择', () => {
  it('未选择食用者时如实提示不应用过滤，勾选后显示硬过滤文案', async () => {
    const { wrapper } = await mountAt('random');
    expect(wrapper.text()).toContain('验收-张三');
    expect(wrapper.text()).toContain('未选择食用者');
    expect(wrapper.text()).not.toContain('忌口和过敏始终硬过滤');
    await wrapper.findAll('input[type="checkbox"]')[0].setValue(true);
    await flushPromises();
    expect(wrapper.text()).toContain('忌口和过敏始终硬过滤');
    expect(wrapper.text()).not.toContain('未选择食用者');
  });

  it('转一下（random）把已勾选食用者传入请求 body', async () => {
    const fetchMock = buildCandidateAwareFetch({
      recipes: [candidate('a', '菜A', true, ['DINNER']), candidate('b', '菜B', true, ['DINNER'])],
      randomResult: { resultId: 'a', title: '菜A' }
    });
    const { wrapper } = await mountSpinPage(fetchMock, { reducedMotion: true });
    await wrapper.findAll('input[type="checkbox"]')[0].setValue(true);
    await clickButton(wrapper, '转一下');
    await settleSpin(wrapper);
    const body = postBody(fetchMock, (path) => path.endsWith('/recommendations/random'));
    expect(body.dinerIds).toEqual([diners[0].id]);
    expect(body.mealType).toBe('DINNER');
  });

  it('库存推荐同样把已勾选食用者传入请求 body', async () => {
    const { wrapper, fetchMock } = await mountAt('inventory');
    await wrapper.findAll('input[type="checkbox"]')[1].setValue(true);
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('生成推荐'))!
      .trigger('click');
    await flushPromises();
    const body = postBody(fetchMock, (path) => path.endsWith('/kitchen/recommend'));
    expect(body.dinerIds).toEqual([diners[1].id]);
    expect(body.mode).toBe('ALLOW_PURCHASE');
  });

  it('缺料加入购物清单一次 POST 全部 items，不循环逐条写入（inventory 结果通道）', async () => {
    const { wrapper, fetchMock } = await mountAt('inventory');
    fetchMock.mockImplementation((input: unknown, init?: { method?: string; body?: string }) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/diners')) return Promise.resolve(jsonResponse({ items: diners }));
      if (path.endsWith('/kitchen/recommend'))
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                recipe: { id: 'recipe-1', name: '验收-番茄炒蛋' },
                reason: '临期优先',
                missingIngredients: [{ name: '番茄' }, { name: '鸡蛋' }]
              }
            ]
          })
        );
      if (path.endsWith('/shopping-lists') && (init?.method ?? 'GET') === 'POST')
        return Promise.resolve(jsonResponse({ id: 'list-1', version: 1, items: [] }));
      return Promise.resolve(jsonResponse({ items: [] }));
    });
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('生成推荐'))!
      .trigger('click');
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('缺料加入购物清单'))!
      .trigger('click');
    await flushPromises();
    const shoppingPosts = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(String(input));
      return (init?.method ?? 'GET') === 'POST' && url.pathname.endsWith('/shopping-lists');
    });
    expect(shoppingPosts).toHaveLength(1);
    const body = JSON.parse((shoppingPosts[0][1] as RequestInit).body as string) as {
      items: Array<{ ingredientName: string }>;
    };
    expect(body.items.map((item) => item.ingredientName)).toEqual(['番茄', '鸡蛋']);
    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input).includes('/shopping-lists/') && String(input).includes('/items')
      )
    ).toBe(false);
  });

  it('加入计划时把已勾选食用者写入 add-to-plan 请求 body（meal-set 结果通道）', async () => {
    const { wrapper, fetchMock } = await mountAt('meal-set');
    await wrapper.findAll('input[type="checkbox"]')[0].setValue(true);
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('生成推荐'))!
      .trigger('click');
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('整组加入计划'))!
      .trigger('click');
    await flushPromises();
    const body = postBody(fetchMock, (path) => path.includes('/add-to-plan'));
    expect(body.dinerIds).toEqual([diners[0].id]);
  });
});

// UXA-005 / UXB-006：空态与文案清理——不再出现「摇一摇/Decision helper/店铺」，引导与转盘控件一致
describe('空态引导文案（UXA-005 / UXB-006）', () => {
  it('初始空态不包含「摇一摇」，引导用户点「转一下」', async () => {
    const { wrapper } = await mountAt('random');
    expect(wrapper.text()).not.toContain('摇一摇');
    expect(wrapper.text()).toContain('转一下');
    expect(wrapper.text()).toContain('今天吃什么');
  });

  it('随机通道转盘无结果时同样不出现「摇一摇」，且给出原因而不是静默空态', async () => {
    // 候选池非空（按钮可点），但服务端返回空 results → 必须给出原因
    const emptyResultFetch = vi.fn().mockImplementation((input: unknown) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/diners')) return Promise.resolve(jsonResponse({ items: diners }));
      if (path.endsWith('/recipes'))
        return Promise.resolve(jsonResponse({ items: [candidate('a', '菜A', true, ['DINNER'])], total: 1 }));
      if (path.endsWith('/recommendations/random'))
        return Promise.resolve(jsonResponse({ historyId: 'history-1', results: [] }));
      return Promise.resolve(jsonResponse({ items: [] }));
    });
    const { wrapper } = await mountSpinPage(emptyResultFetch, { reducedMotion: true });
    await clickButton(wrapper, '转一下');
    await flushPromises();
    expect(wrapper.text()).not.toContain('摇一摇');
    expect(wrapper.text()).toContain('候选池暂无可用结果');
  });

  it('页面不再残留英文 eyebrow 与工程术语（UXB-006 文案清理）', async () => {
    const { wrapper } = await mountAt('random');
    expect(wrapper.text()).not.toContain('Decision helper');
    expect(wrapper.text()).not.toContain('DRAFT');
    expect(wrapper.text()).not.toContain('CONFIRMED');
    // 用户语言：候选计数直接为「晚餐候选：N 道」
    expect(wrapper.text()).toContain('候选：');
  });
});
