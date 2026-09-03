import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import CalendarPage from '../src/pages/CalendarPage.vue';
import MealPlansPage from '../src/pages/MealPlansPage.vue';
import CompleteMealPage from '../src/pages/CompleteMealPage.vue';
import { buildMonthGrid, monthRange, parseLocalIsoDate, toLocalIsoDate } from '../src/utils/calendar';

function weekdayIndex(date: string): number {
  const cells = buildMonthGrid(...yearMonth(date));
  return cells.findIndex((cell) => cell.date === date && cell.inCurrentMonth);
}

function yearMonth(date: string): [number, number] {
  const parsed = parseLocalIsoDate(date);
  if (!parsed) throw new Error(date);
  return [parsed.getFullYear(), parsed.getMonth()];
}

function createRouterWithPlans() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/calendar', component: CalendarPage },
      { path: '/plans', component: MealPlansPage }
    ]
  });
}

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: async () => ({ success: true, data, error: null }) });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('calendar month grid', () => {
  it('A：月初星期一落在第一列，月初星期日落在第七列', () => {
    expect(weekdayIndex('2026-06-01')).toBe(0);
    expect(weekdayIndex('2026-02-01') % 7).toBe(6);
  });

  it('B：上月与下月补位日期正确', () => {
    const cells = buildMonthGrid(2026, 7);
    expect(cells[0]).toMatchObject({ date: '2026-07-27', inCurrentMonth: false });
    expect(cells.at(-1)).toMatchObject({ date: '2026-09-06', inCurrentMonth: false });
    expect(
      cells
        .filter((cell) => cell.inCurrentMonth)
        .map((cell) => cell.date)
        .at(0)
    ).toBe('2026-08-01');
  });

  it('C：闰年二月包含 29 日，平年二月没有', () => {
    expect(buildMonthGrid(2024, 1).some((cell) => cell.date === '2024-02-29' && cell.inCurrentMonth)).toBe(true);
    expect(buildMonthGrid(2025, 1).some((cell) => cell.date === '2025-02-29')).toBe(false);
    expect(monthRange(2024, 1)).toEqual({ start: '2024-02-01', end: '2024-02-29' });
    expect(monthRange(2025, 1)).toEqual({ start: '2025-02-01', end: '2025-02-28' });
  });

  it('覆盖 28/30/31 天月份长度', () => {
    expect(buildMonthGrid(2026, 1).filter((cell) => cell.inCurrentMonth)).toHaveLength(28);
    expect(buildMonthGrid(2026, 3).filter((cell) => cell.inCurrentMonth)).toHaveLength(30);
    expect(buildMonthGrid(2026, 6).filter((cell) => cell.inCurrentMonth)).toHaveLength(31);
  });

  it('D：当天格子标记 isToday', () => {
    const today = parseLocalIsoDate('2026-08-29')!;
    const cells = buildMonthGrid(2026, 7, today);
    expect(cells.find((cell) => cell.date === '2026-08-29')?.isToday).toBe(true);
    expect(cells.filter((cell) => cell.isToday)).toHaveLength(1);
  });

  it('parseLocalIsoDate 拒绝非法日期，不走 UTC 解析', () => {
    expect(parseLocalIsoDate('2026-02-30')).toBeNull();
    expect(toLocalIsoDate(parseLocalIsoDate('2026-08-29')!)).toBe('2026-08-29');
  });
});

describe('CalendarPage 月历与导航', () => {
  it('E/F：有数据 marker 只出现在对应日期，点击写入 date query', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 29));
    const router = createRouterWithPlans();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/calendar')) {
          return jsonOk({
            start: '2026-08-01',
            end: '2026-08-31',
            days: [
              {
                date: '2026-08-15',
                hasPlans: true,
                hasRecords: false,
                hasDrafts: false,
                plans: [{ id: 'plan-1', mealType: 'DINNER', status: 'PLANNED' }],
                records: []
              }
            ]
          });
        }
        return jsonOk([]);
      })
    );
    await router.push('/calendar');
    const wrapper = mount(CalendarPage, { global: { plugins: [router] } });
    await flushPromises();
    const marked = wrapper.get('[data-date="2026-08-15"]');
    expect(marked.text()).toContain('计划 1');
    expect(wrapper.get('[data-date="2026-08-16"]').text()).not.toContain('计划');
    expect(wrapper.get('[data-date="2026-08-29"]').attributes('data-today')).toBe('true');
    expect(marked.attributes('href')).toBe('/plans?date=2026-08-15');
    await router.push(marked.attributes('href') ?? '/plans');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/plans?date=2026-08-15');
  });
});

describe('MealPlansPage date query', () => {
  async function mountPlans(path: string) {
    const router = createRouterWithPlans();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/plans')) {
        const from = new URL(url, 'http://local.test').searchParams.get('from');
        return jsonOk(
          from === '2026-08-01'
            ? [
                {
                  id: 'plan-aug',
                  planDate: '2026-08-29',
                  mealType: 'DINNER',
                  dinerCount: 1,
                  status: 'PLANNED',
                  notes: null,
                  version: 1,
                  items: []
                }
              ]
            : [
                {
                  id: 'plan-sep',
                  planDate: '2026-09-02',
                  mealType: 'DINNER',
                  dinerCount: 1,
                  status: 'PLANNED',
                  notes: null,
                  version: 1,
                  items: []
                }
              ]
        );
      }
      if (url.includes('/recipes') || url.includes('/stores') || url.includes('/diners')) {
        return jsonOk({ items: [] });
      }
      return jsonOk([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    await router.push(path);
    const wrapper = mount(MealPlansPage, { global: { plugins: [router] } });
    await flushPromises();
    return { wrapper, router, fetchMock };
  }

  function planUrls(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('/plans'));
  }

  it('G/I：初次进入带 date 使用该日期并请求当月范围', async () => {
    const { wrapper, fetchMock } = await mountPlans('/plans?date=2026-08-29');
    expect(wrapper.get('[data-selected-date]').attributes('data-selected-date')).toBe('2026-08-29');
    await wrapper.get('button').trigger('click');
    expect((wrapper.get('input[type="date"]').element as HTMLInputElement).value).toBe('2026-08-29');
    expect(wrapper.get('[data-plan-date="2026-08-29"]').classes()).toContain('business-card--selected');
    expect(planUrls(fetchMock).some((url) => url.includes('from=2026-08-01') && url.includes('to=2026-08-31'))).toBe(
      true
    );
    expect(planUrls(fetchMock).join(' ')).not.toContain('2000-01-01');
    expect(planUrls(fetchMock).join(' ')).not.toContain('2100-12-31');
  });

  it('H：同页 query 改变时跟随；同月不重复请求，跨月才重新请求', async () => {
    const { wrapper, router, fetchMock } = await mountPlans('/plans?date=2026-08-29');
    const before = planUrls(fetchMock).length;
    await router.push('/plans?date=2026-08-10');
    await flushPromises();
    expect(wrapper.get('[data-selected-date]').attributes('data-selected-date')).toBe('2026-08-10');
    expect(planUrls(fetchMock)).toHaveLength(before);
    await router.push('/plans?date=2026-09-02');
    await flushPromises();
    expect(wrapper.get('[data-selected-date]').attributes('data-selected-date')).toBe('2026-09-02');
    expect(planUrls(fetchMock).some((url) => url.includes('from=2026-09-01') && url.includes('to=2026-09-30'))).toBe(
      true
    );
  });

  it('跨月快速切换时旧月份响应不会覆盖新月份', async () => {
    const router = createRouterWithPlans();
    const deferred: { resolve?: (value: unknown) => void } = {};
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/plans')) {
        const from = new URL(url, 'http://local.test').searchParams.get('from');
        if (from === '2026-08-01') {
          return new Promise((resolve) => {
            deferred.resolve = resolve;
          });
        }
        return jsonOk([
          {
            id: 'plan-sep',
            planDate: '2026-09-02',
            mealType: 'DINNER',
            dinerCount: 1,
            status: 'PLANNED',
            notes: null,
            version: 1,
            items: []
          }
        ]);
      }
      if (url.includes('/recipes') || url.includes('/stores') || url.includes('/diners')) {
        return jsonOk({ items: [] });
      }
      return jsonOk([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    await router.push('/plans?date=2026-08-29');
    const wrapper = mount(MealPlansPage, { global: { plugins: [router] } });
    await router.push('/plans?date=2026-09-02');
    await flushPromises();
    deferred.resolve?.({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            id: 'plan-aug',
            planDate: '2026-08-29',
            mealType: 'DINNER',
            dinerCount: 1,
            status: 'PLANNED',
            notes: null,
            version: 1,
            items: []
          }
        ],
        error: null
      })
    });
    await flushPromises();
    expect(wrapper.get('[data-selected-date]').attributes('data-selected-date')).toBe('2026-09-02');
    expect(wrapper.find('[data-plan-date="2026-08-29"]').exists()).toBe(false);
    expect(wrapper.get('[data-plan-date="2026-09-02"]').exists()).toBe(true);
  });

  it('J：非法 date query 不崩溃并回退今天', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 29));
    const { wrapper } = await mountPlans('/plans?date=not-a-date');
    expect(wrapper.get('[data-selected-date]').attributes('data-selected-date')).toBe('2026-08-29');
    await wrapper.get('button').trigger('click');
    expect((wrapper.get('input[type="date"]').element as HTMLInputElement).value).toBe('2026-08-29');
  });

  it('K：用户界面使用普通用户语言，完成动作仍然可用', async () => {
    const planned = {
      id: 'plan-aug',
      planDate: '2026-08-29',
      mealType: 'DINNER',
      dinerCount: 2,
      status: 'PLANNED',
      notes: null,
      version: 1,
      items: []
    };
    let completed = false;
    const router = createRouterWithPlans();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.includes('/plans/plan-aug/complete')) {
        completed = true;
        return jsonOk({ ...planned, status: 'COMPLETED', version: 2 });
      }
      if (url.includes('/plans')) {
        return jsonOk([
          completed ? { ...planned, status: 'COMPLETED', version: 2 } : planned,
          { ...planned, id: 'plan-draft', planDate: '2026-08-30', status: 'DRAFT' }
        ]);
      }
      if (url.includes('/recipes') || url.includes('/stores') || url.includes('/diners')) {
        return jsonOk({ items: [] });
      }
      return jsonOk([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    await router.push('/plans?date=2026-08-29');
    const wrapper = mount(MealPlansPage, { global: { plugins: [router] } });
    await flushPromises();

    const visibleText = wrapper.text();
    expect(visibleText).not.toMatch(/草稿|已确认|原子生成/);
    expect(visibleText).not.toMatch(/DRAFT|CONFIRMED/);
    // 后端返回的 DRAFT 计划在界面上仍以用户语言呈现
    expect(wrapper.get('[data-plan-date="2026-08-30"]').text()).toContain('待完成');

    const completeButton = wrapper.findAll('button').find((button) => button.text() === '完成这一餐');
    expect(completeButton).toBeDefined();
    await completeButton!.trigger('click');
    await flushPromises();
    const completeCalls = fetchMock.mock.calls.filter(
      ([input, init]) => init?.method === 'POST' && String(input).includes('/plans/plan-aug/complete')
    );
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0]![1]!.body).toBe(JSON.stringify({ version: 1 }));
    // 完成后回到列表，该计划不再展示完成/取消动作
    expect(wrapper.findAll('button').find((button) => button.text() === '完成这一餐')).toBeUndefined();
  });
});

function recipeBrief(id = 'recipe-1') {
  return {
    id,
    name: 'UXB完成页测试菜',
    imagePath: null,
    cookingTimeMinutes: 20,
    difficulty: null,
    servings: 2,
    ingredients: [],
    steps: [{ id: `${id}-s1`, stepNo: 1, content: '做' }],
    tools: []
  };
}

function createCompleteRouter(routeQuery: Record<string, string>) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/complete-meal', component: CompleteMealPage }]
  });
  const query = new URLSearchParams(routeQuery).toString();
  return router.push(`/complete-meal?${query}`).then(() => router);
}

describe('CompleteMealPage 完成上下文继承（UXB-003）', () => {
  it('无结构化食材的菜谱：direct 记录保留入口 mealType，计划入口携带 relatedPlanId', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
        return jsonOk({ id: 'record-1', version: 1 });
      }
      if (url.includes('/recipes/')) return jsonOk(recipeBrief());
      return jsonOk([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = await createCompleteRouter({ recipeId: 'recipe-1', mealType: 'DINNER' });
    const wrapper = mount(CompleteMealPage, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('UXB完成页测试菜');

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '确认并完成')!
      .trigger('click');
    await flushPromises();
    const create = posts.find((p) => p.url.includes('/records'));
    expect(create).toBeTruthy();
    // mealType 继承自推荐入口，未按时间推断漂移
    expect(create!.body.mealType).toBe('DINNER');
    expect(create!.body.relatedPlanId).toBeUndefined();
    expect(wrapper.text()).toContain('这餐已记录');
  });

  it('计划入口（planId）：preview 与 confirm 都携带 relatedPlanId，锁定餐次/日期', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/plans/plan-1') && !String(init?.method).includes('POST')) {
        return jsonOk({
          id: 'plan-1',
          planDate: '2046-08-20',
          mealType: 'DINNER',
          dinerCount: 1,
          status: 'PLANNED',
          version: 1,
          items: [{ id: 'pi-1', recipe: { id: 'recipe-1', name: 'UXB完成页测试菜' } }]
        });
      }
      if (url.includes('/recipes/recipe-1')) return jsonOk(recipeBrief());
      if (url.includes('/consumption/preview-from-recipe')) {
        return jsonOk({ recipeId: 'recipe-1', dinerCount: 1, previewToken: 'tok-1', items: [] });
      }
      if (url.includes('/consumption/confirm-from-recipe')) {
        posts.push({ url, body: JSON.parse(init!.body as string) as Record<string, unknown> });
        return jsonOk({ recordId: 'record-1', recordVersion: 1 });
      }
      return jsonOk([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = await createCompleteRouter({ recipeId: 'recipe-1', planId: 'plan-1' });
    const wrapper = mount(CompleteMealPage, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('饮食计划');

    // 餐次/日期被计划锁定
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('DINNER');
    expect((wrapper.get('input[type="date"]').element as HTMLInputElement).value).toBe('2046-08-20');

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '确认并完成')!
      .trigger('click');
    await flushPromises();
    // 计划入口 + 无结构化食材 → 走库存核对 preview，确认按钮在核对页
    expect(wrapper.text()).toContain('库存核对');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '确认并完成')!
      .trigger('click');
    await flushPromises();
    const confirm = posts.find((p) => p.url.includes('/confirm-from-recipe'));
    expect(confirm).toBeTruthy();
    expect(confirm!.body.relatedPlanId).toBe('plan-1');
    expect(confirm!.body.mealType).toBe('DINNER');
    expect(wrapper.text()).toContain('计划已完成，这餐已记录');
  });

  it('计划不可完成（已取消/已完成）时展示返回计划页，不进入完成流程', async () => {
    const fetchMock = vi.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/plans/plan-x')) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            success: false,
            data: null,
            error: { code: 'PLAN_NOT_ACTIONABLE', message: '该计划已经完成，无需重复记录' }
          })
        });
      }
      if (url.includes('/recipes/recipe-x')) return jsonOk(recipeBrief('recipe-x'));
      return jsonOk([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = await createCompleteRouter({ recipeId: 'recipe-x', planId: 'plan-x' });
    const wrapper = mount(CompleteMealPage, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('无法完成这一餐');
    expect(wrapper.text()).toContain('该计划已经完成');
    expect(wrapper.findAll('button').find((b) => b.text() === '确认并完成')).toBeUndefined();
    expect(wrapper.findAll('button').find((b) => b.text() === '返回饮食计划')).toBeDefined();
  });
});
