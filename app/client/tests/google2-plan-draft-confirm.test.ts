// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const adapter = readFileSync(resolve(process.cwd(), 'public/google2-adapter.js'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');
const markup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
const date = '2026-09-11';
const payload = { year: 2026, month: 9, day: 11 };
const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 100, totalPages: 1 });
const ok = (data: unknown, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data })
});

type Plan = ReturnType<typeof planFixture>;
type RecordDto = ReturnType<typeof recordFixture>;
type State = { plans: Plan[]; records: RecordDto[] };

function planFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    planDate: date,
    mealType: 'LUNCH',
    title: '计划午餐',
    subtext: '自烹午餐',
    icon: '午',
    status: 'COMPLETED',
    version: 2,
    items: [{ itemType: 'RECIPE', recipeId: 'recipe-1', recipe: { id: 'recipe-1', name: '番茄鸡蛋' } }],
    ...overrides
  };
}

function recordFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'record-1',
    recordDate: date,
    mealType: 'LUNCH',
    sourceType: 'HOMEMADE',
    title: '计划午餐',
    notes: '确认后再计入统计',
    calories: 640,
    cost: 12,
    satiety: 8,
    rating: 4,
    photos: [] as string[],
    status: 'DRAFT',
    sourceMealPlanId: 'plan-1',
    relatedPlanId: 'plan-1',
    confirmedAt: null as string | null,
    deletedAt: null as string | null,
    version: 1,
    items: [{ itemType: 'CUSTOM', customName: '计划午餐' }],
    ...overrides
  };
}

function stateFixture(): State {
  return { plans: [planFixture()], records: [recordFixture()] };
}

function confirmed(state: State) {
  return state.records.filter((record) => record.deletedAt == null && record.status === 'CONFIRMED');
}

function dashboard(state: State) {
  const records = confirmed(state);
  return {
    branding: { appName: '搭饭小馆' },
    currentDate: date,
    recommendedRecipes: [],
    todayRecords: records.map((record) => ({ title: record.title, recorded: true })),
    weeklyStats: { totalMeals: records.length, recordedDays: records.length ? 1 : 0 },
    inventory: {},
    calendarDays: []
  };
}

function statistics(state: State) {
  const records = confirmed(state);
  return {
    costSummary: {
      totalCost: records.reduce((sum, record) => sum + record.cost, 0),
      homemadeCost: records.reduce((sum, record) => sum + record.cost, 0),
      homemadeRecordCount: records.length,
      takeoutCost: 0,
      takeoutRecordCount: 0,
      dineInCost: 0,
      dineInRecordCount: 0
    },
    calorieTrend: records.length ? [{ date, calories: records.reduce((sum, record) => sum + record.calories, 0) }] : [],
    sourceBreakdown: { HOMEMADE: records.length },
    satietySummary: { recordedCount: 0 }
  };
}

function router(state: State) {
  return async (url: string, init?: RequestInit) => {
    const parsed = new URL(String(url), 'http://localhost');
    const path = parsed.pathname.replace('/api/v1', '');
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === '/settings/pin/session') return ok({ valid: true });
    if (path === '/settings') return ok({ pinEnabled: false });
    if (path === '/dashboard') return ok(dashboard(state));
    if (path === '/statistics') return ok(statistics(state));
    if (path === '/plans') return ok(state.plans);
    if (path === '/records') {
      if (method === 'POST') {
        expect(body).not.toHaveProperty('status');
        const created = recordFixture({
          ...body,
          id: `manual-${state.records.length + 1}`,
          status: 'CONFIRMED',
          sourceMealPlanId: null,
          relatedPlanId: null,
          confirmedAt: '2026-09-11T04:05:00.000Z'
        });
        state.records.push(created);
        return ok(created, 201);
      }
      const filter = parsed.searchParams.get('status');
      return ok(
        page(state.records.filter((record) => record.deletedAt == null && (!filter || record.status === filter)))
      );
    }
    if (path.startsWith('/plans/') && path.endsWith('/complete') && method === 'POST') {
      const plan = state.plans.find((item) => item.id === decodeURIComponent(path.slice(7, -9)));
      if (!plan) throw new Error(`Missing plan: ${path}`);
      expect(Object.keys(body)).toEqual(['version']);
      const idempotent = plan.status === 'COMPLETED';
      if (!idempotent) {
        plan.status = 'COMPLETED';
        plan.version += 1;
      }
      let record = state.records.find((item) => item.sourceMealPlanId === plan.id || item.relatedPlanId === plan.id);
      if (!record) {
        record = recordFixture({ sourceMealPlanId: plan.id, relatedPlanId: plan.id });
        state.records.push(record);
      }
      record.deletedAt = null;
      return ok({ plan, record, idempotent, inventoryDeductionPromptEnabled: false });
    }
    if (path.startsWith('/plans/') && path.endsWith('/uncomplete') && method === 'POST') {
      const plan = state.plans.find((item) => item.id === decodeURIComponent(path.slice(7, -11)));
      if (!plan) throw new Error(`Missing plan: ${path}`);
      expect(Object.keys(body)).toEqual(['version']);
      const record = state.records.find((item) => item.sourceMealPlanId === plan.id && item.deletedAt == null);
      if (record && (record.status === 'CONFIRMED' || record.version > 1))
        return ok({ code: 'CONFLICT', message: '关联记录已确认或已编辑，不能撤销打卡' }, 409);
      plan.status = 'PLANNED';
      plan.version += 1;
      if (record) record.deletedAt = '2026-09-11T04:00:00.000Z';
      return ok({ plan, removedRecord: record, idempotent: false });
    }
    if (path.startsWith('/records/')) {
      const isConfirm = path.endsWith('/confirm');
      const id = decodeURIComponent(path.slice(9, isConfirm ? -8 : undefined));
      const record = state.records.find((item) => item.id === id);
      if (!record) throw new Error(`Missing record: ${path}`);
      if (isConfirm && method === 'POST') {
        expect(Object.keys(body)).toEqual(['version']);
        if (record.status === 'DRAFT') {
          if (body.version !== record.version)
            return ok({ code: 'VERSION_CONFLICT', message: '版本冲突，请读取最新记录' }, 409);
          record.status = 'CONFIRMED';
          record.confirmedAt = '2026-09-11T04:01:00.000Z';
          record.version += 1;
        }
      } else if (method === 'PUT') {
        expect(body).not.toHaveProperty('status');
        Object.assign(record, body, { version: record.version + 1 });
      }
      return ok(record);
    }
    return ok(page([]));
  };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

async function boot(
  state: State,
  intercept?: (url: string, init?: RequestInit) => Promise<ReturnType<typeof ok> | undefined>
) {
  document.body.innerHTML = markup;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(Element.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent || '';
    },
    set(value) {
      this.textContent = value;
    }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const respond = router(state);
  const fetchMock = vi.fn(
    async (url: string, init?: RequestInit) => (await intercept?.(url, init)) ?? respond(url, init)
  );
  vi.stubGlobal('fetch', fetchMock);
  window.eval(`(() => { ${inline}\n })()`);
  window.eval('var BentoService = window.BentoService; var BentoModal = window.BentoModal;');
  window.eval(adapter);
  await settle();
  return fetchMock;
}

function services() {
  return (window as any).BentoService;
}
function modal() {
  return (window as any).BentoModal;
}
function text(selector: string) {
  return document.querySelector(selector)?.textContent || '';
}
function buttons(selector: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(`${selector} button`)).filter(
    (button) => button.textContent?.trim() === '确认已用餐'
  );
}
function calls(fetchMock: ReturnType<typeof vi.fn>, part: string, method = 'GET') {
  return fetchMock.mock.calls.filter(([url, init]) => String(url).includes(part) && (init?.method || 'GET') === method);
}
function activePage(name: string) {
  document.querySelectorAll('.view-panel').forEach((panel) => panel.classList.remove('active'));
  document.getElementById(`page-${name}`)?.classList.add('active');
}
function formSubmitEvent() {
  return {
    preventDefault: vi.fn(),
    currentTarget: document.querySelector('#modalRecordForm form'),
    submitter: document.querySelector('#modalRecordForm button[type="submit"]')
  };
}

function fillManualRecord(title: string) {
  (document.getElementById('formRecordTitle') as HTMLInputElement).value = title;
  (document.getElementById('formRecordSlot') as HTMLSelectElement).value = '午餐';
  (document.getElementById('formRecordType') as HTMLSelectElement).value = '自烹';
  for (const id of ['formRecordCalories', 'formRecordCost', 'formRecordSatiety', 'formRecordRating'])
    (document.getElementById(id) as HTMLInputElement).value = '';
  (document.getElementById('formRecordNotes') as HTMLTextAreaElement).value = '';
}

function expectDraftViews(count: number) {
  for (const selector of ['#recordsListContainer', '#dailyDiaryMealsList', '#plansListContainer']) {
    expect(buttons(selector)).toHaveLength(count);
    if (count) expect(text(selector)).toContain('待确认草稿');
    else expect(text(selector)).not.toContain('待确认草稿');
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 11, 12));
});
afterEach(() => {
  (window as any).PlanReminderScheduler?.stop?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('T-003 真实 HTML + 适配器计划草稿确认', () => {
  it.each([null, 'record-1'])('日记上方编辑弹窗 payload=%s 时确认并补记始终使用日记自己的日期', async (formPayload) => {
    const diaryDate = '2026-08-23';
    const state: State = {
      plans: [planFixture({ planDate: diaryDate })],
      records: [recordFixture({ recordDate: diaryDate })]
    };
    const fetchMock = await boot(state);
    await modal().open('dailyDiary', { year: 2026, month: 8, day: 23 });
    await modal().open('recordForm', formPayload);
    expect(modal().getTop().name).toBe('recordForm');
    await services().records.confirm('record-1');
    await settle();
    expect(text('#dailyDiaryDateTitle')).toContain('2026年8月23日');
    expect(text('#dailyDiarySubtitle')).toContain('已确认 1 餐');
    expect(text('#dailyDiarySubtitle')).toContain('640');
    expect(modal().getTop().name).toBe('recordForm');
    modal().close(true);
    expect(modal().getTop().name).toBe('dailyDiary');
    await modal().open('recordForm');
    fillManualRecord('8月23日补记');
    await modal().handleRecordFormSubmit(formSubmitEvent());
    await settle();
    const createdCalls = calls(fetchMock, '/api/v1/records', 'POST').filter(
      ([url]) => new URL(String(url), 'http://localhost').pathname === '/api/v1/records'
    );
    expect(createdCalls).toHaveLength(1);
    expect(JSON.parse(String(createdCalls[0][1]?.body)).recordDate).toBe(diaryDate);
    expect(text('#dailyDiaryDateTitle')).toContain('2026年8月23日');
    expect(text('#dailyDiarySubtitle')).toContain('已确认 2 餐');
    expect(modal().getTop().name).toBe('dailyDiary');
    await modal().open('recordForm');
    fillManualRecord('同日第二次补记');
    await modal().handleRecordFormSubmit(formSubmitEvent());
    await settle();
    expect(state.records.map((record) => record.recordDate)).toEqual([diaryDate, diaryDate, diaryDate]);
    expect(text('#dailyDiarySubtitle')).toContain('已确认 3 餐');
  });

  it.each(['missing', 'planned'])('计划缓存为 %s 不隐藏后端真实活跃记录，软删除记录始终排除', async (cacheState) => {
    const state = stateFixture();
    state.records.push(recordFixture({ id: 'deleted-2', title: '已删除不可见', deletedAt: '2026-09-11T03:00:00Z' }));
    if (cacheState === 'missing') state.plans = [];
    else state.plans[0].status = 'PLANNED';
    await boot(state);
    services().records.data.unshift((window as any).DafanDomainAdapter.mapRecord(state.records[1]));
    (window as any).renderRecords();
    await modal().open('dailyDiary', payload);
    expect(text('#recordsListContainer')).toContain('计划午餐');
    expect(text('#dailyDiaryMealsList')).toContain('计划午餐');
    expect(text('#recordsListContainer')).not.toContain('已删除不可见');
    expect(text('#dailyDiaryMealsList')).not.toContain('已删除不可见');
    expect(buttons('#recordsListContainer')).toHaveLength(1);
    expect(buttons('#dailyDiaryMealsList')).toHaveLength(1);
  });

  it('混合空字段草稿不清除已确认记录的热量、饱腹度及字面 null 文本', async () => {
    const state = stateFixture();
    state.records[0] = recordFixture({
      status: 'CONFIRMED',
      title: '字面 null 标题',
      notes: '保留 null 原文',
      calories: 310,
      satiety: 7
    });
    state.records.push(
      recordFixture({
        id: 'empty-draft',
        sourceMealPlanId: null,
        relatedPlanId: null,
        calories: null,
        notes: null,
        satiety: null
      })
    );
    await boot(state);
    await modal().open('dailyDiary', payload);
    const diaryCard = Array.from(document.querySelectorAll<HTMLElement>('#dailyDiaryMealsList > div')).find((node) =>
      node.textContent?.includes('字面 null 标题')
    );
    expect(diaryCard?.textContent).toContain('保留 null 原文');
    expect(diaryCard?.textContent).toContain('310 kcal');
    expect(diaryCard?.textContent).toContain('饱腹感：★★★★★★★');
    expect(text('#dailyDiaryMealsList')).toContain('【实际就餐打卡】');
    (window as any).renderRecords();
    expect(text('#recordsListContainer')).toContain('字面 null 标题');
    expect(text('#recordsListContainer')).toContain('保留 null 原文');
  });

  it('真实计划打卡按钮失败显示错误并保留计划状态', async () => {
    const state: State = { plans: [planFixture({ status: 'PLANNED', version: 1 })], records: [] };
    const fetchMock = await boot(state, async (url, init) => {
      if (String(url).endsWith('/complete') && init?.method === 'POST')
        return ok({ code: 'VERSION_CONFLICT', message: '计划已被修改，请刷新后重试' }, 409);
      return undefined;
    });
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('#plansListContainer button')).find((node) =>
      ['打卡', '补打卡'].includes(node.textContent?.trim() || '')
    );
    expect(button).toBeTruthy();
    button!.click();
    await settle();
    expect(text('#toastText')).toContain('计划已被修改，请刷新后重试');
    expect(services().plans.data[0]).toMatchObject({ isCompleted: false, version: 1 });
    expect(services().records.data).toHaveLength(0);
    expect(calls(fetchMock, '/complete', 'POST')).toHaveLength(1);
  });

  it('计划完成只生成草稿，三视图可见，刷新后保持关联且统计排除', async () => {
    const state: State = { plans: [planFixture({ status: 'PLANNED', version: 1 })], records: [] };
    const fetchMock = await boot(state);
    expect(calls(fetchMock, '/records?from=')).toHaveLength(0);
    expect(calls(fetchMock, '/statistics?')).toHaveLength(0);
    await services().plans.checkin('plan-1');
    await modal().open('dailyDiary', payload);
    expectDraftViews(1);
    expect(text('#toastText')).toContain('待确认就餐草稿');
    expect(text('#toastText')).toContain('确认后计入统计');
    expect(text('#recordsListContainer')).toContain('确认后计入');
    expect(text('#dailyDiarySubtitle')).toContain('暂无已确认就餐记录');
    expect(text('#dailyDiarySubtitle')).toContain('待确认草稿 1 餐');
    expect(text('#dailyDiarySubtitle')).not.toContain('640');
    await (window as any).renderCalendar();
    await (window as any).renderStatistics();
    expect(text('#calendarDaysGrid')).not.toContain('已打卡');
    expect(text('#statCookCount')).toContain('自烹 0 顿');
    expect(text('[data-binding="weeklyStat-totalMeals"]')).toBe('0');
    expect(state.records).toHaveLength(1);
    expect(state.records[0].status).toBe('DRAFT');
    await boot(state);
    expect(services().plans.data[0].linkedRecordId).toBeFalsy();
    expect(services().records.data[0]).toMatchObject({
      status: 'DRAFT',
      sourceMealPlanId: 'plan-1',
      relatedPlanId: 'plan-1',
      confirmedAt: null
    });
    await modal().open('dailyDiary', payload);
    expectDraftViews(1);
  });

  it.each(['#recordsListContainer', '#dailyDiaryMealsList', '#plansListContainer'])(
    '%s 确认持久化并同步所有视图，重复点击只发送一次',
    async (entry) => {
      const state = stateFixture();
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolvePromise) => {
        release = resolvePromise;
      });
      const fetchMock = await boot(state, async (url, init) => {
        if (String(url).endsWith('/confirm') && init?.method === 'POST') await gate;
        return undefined;
      });
      await modal().open('dailyDiary', payload);
      activePage('calendar');
      await (window as any).renderCalendar();
      const calendar = vi.spyOn(window as any, 'renderCalendar');
      const stats = vi.spyOn(window as any, 'renderStatistics');
      const dashboardBefore = calls(fetchMock, '/dashboard').length;
      const button = buttons(entry)[0];
      expect(button).toBeTruthy();
      button.click();
      button.click();
      const other = ['#recordsListContainer', '#dailyDiaryMealsList', '#plansListContainer'].find(
        (item) => item !== entry
      )!;
      buttons(other)[0].click();
      expect(calls(fetchMock, '/confirm', 'POST')).toHaveLength(1);
      expect(JSON.parse(String(calls(fetchMock, '/confirm', 'POST')[0][1]?.body))).toEqual({ version: 1 });
      release?.();
      await settle();
      expectDraftViews(0);
      expect(text('#plansListContainer')).toContain('已确认用餐');
      expect(text('#dailyDiarySubtitle')).toContain('已确认 1 餐');
      expect(text('#dailyDiarySubtitle')).toContain('640');
      expect(calendar).toHaveBeenCalled();
      expect(stats).not.toHaveBeenCalled();
      expect(text('#calendarDaysGrid')).toContain('已打卡');
      expect(calls(fetchMock, '/dashboard')).toHaveLength(dashboardBefore);
      expect(state.records[0]).toMatchObject({
        status: 'CONFIRMED',
        version: 2,
        confirmedAt: '2026-09-11T04:01:00.000Z'
      });
      (window as any).switchPage('home');
      await settle();
      expect(text('[data-binding="weeklyStat-totalMeals"]')).toBe('1');
      (window as any).switchPage('statistics');
      await settle();
      expect(text('#statCookCount')).toContain('自烹 1 顿');
      expect(document.querySelector('#chartCalorieTrendWrap [data-calories="640"]')).toBeTruthy();
      calendar.mockRestore();
      stats.mockRestore();
      await boot(state);
      await modal().open('dailyDiary', payload);
      await (window as any).renderCalendar();
      await (window as any).renderStatistics();
      expectDraftViews(0);
      expect(text('#plansListContainer')).toContain('已确认用餐');
      expect(text('#dailyDiarySubtitle')).toContain('已确认 1 餐');
      expect(text('#calendarDaysGrid')).toContain('已打卡');
      expect(text('#statCookCount')).toContain('自烹 1 顿');
      expect(text('[data-binding="weeklyStat-totalMeals"]')).toBe('1');
    }
  );

  it('真实默认草稿的空热量/备注/饱腹度不隐藏草稿标识或确认入口', async () => {
    const state = stateFixture();
    state.records[0] = recordFixture({ calories: null, satiety: null, notes: null, cost: null, rating: null });
    await boot(state);
    await modal().open('dailyDiary', payload);
    expectDraftViews(1);
    expect(text('#dailyDiarySubtitle')).toContain('暂无已确认就餐记录');
    expect(text('#dailyDiarySubtitle')).toContain('待确认草稿 1 餐');
    expect(text('#recordsListContainer')).not.toContain('null');
    expect(text('#dailyDiaryMealsList')).not.toContain('null');
    buttons('#dailyDiaryMealsList')[0].click();
    await settle();
    expectDraftViews(0);
    expect(text('#dailyDiarySubtitle')).toContain('已确认 1 餐');
    expect(text('#dailyDiaryMealsList')).not.toContain('待确认草稿');
  });

  it('日记副标题只累加已确认记录，草稿热量不混入', async () => {
    const state = stateFixture();
    state.records.push(
      recordFixture({
        id: 'confirmed-2',
        status: 'CONFIRMED',
        sourceMealPlanId: null,
        relatedPlanId: null,
        calories: 310
      })
    );
    await boot(state);
    await modal().open('dailyDiary', payload);
    expect(text('#dailyDiarySubtitle')).toContain('已确认 1 餐');
    expect(text('#dailyDiarySubtitle')).toContain('待确认草稿 1 餐');
    expect(text('#dailyDiarySubtitle')).toContain('310');
    expect(text('#dailyDiarySubtitle')).not.toContain('950');
    expect(buttons('#recordsListContainer')).toHaveLength(1);
    expect(buttons('#dailyDiaryMealsList')).toHaveLength(1);
  });

  it('relatedPlanId 与旧 linkedRecordId 均可关联，软删除记录不抢占活跃草稿', async () => {
    const state = stateFixture();
    state.records[0] = recordFixture({ sourceMealPlanId: null });
    state.records.unshift(
      recordFixture({ id: 'deleted-record', status: 'CONFIRMED', deletedAt: '2026-09-10T01:00:00Z' })
    );
    await boot(state);
    await modal().open('dailyDiary', payload);
    expectDraftViews(1);
    services().plans.data[0].linkedRecordId = 'record-1';
    services().records.data[0].relatedPlanId = null;
    (window as any).renderPlans();
    expect(buttons('#plansListContainer')).toHaveLength(1);
    services().records.data[0].relatedPlanId = 'plan-1';
    services().records.data.unshift((window as any).DafanDomainAdapter.mapRecord(state.records[0]));
    (window as any).renderRecords();
    (window as any).renderPlans();
    modal().setupDailyDiary(payload);
    expectDraftViews(1);
  });

  it('激活统计页时记录确认刷新真实统计，未激活月历不发请求', async () => {
    const state = stateFixture();
    const fetchMock = await boot(state);
    (window as any).switchPage('statistics');
    await settle();
    const beforeStats = calls(fetchMock, '/statistics?').length;
    const beforeCalendar = calls(fetchMock, '/records?from=').length;
    await services().records.confirm('record-1');
    await settle();
    expect(calls(fetchMock, '/statistics?').length).toBeGreaterThan(beforeStats);
    expect(calls(fetchMock, '/records?from=')).toHaveLength(beforeCalendar);
    expect(text('#statCookCount')).toContain('自烹 1 顿');
  });

  it('停留首页时确认立即刷新概览，纯 reload 不触发 dashboard 写刷新', async () => {
    const state = stateFixture();
    const fetchMock = await boot(state);
    const before = calls(fetchMock, '/dashboard').length;
    await services().records.reload();
    await settle();
    expect(calls(fetchMock, '/dashboard')).toHaveLength(before);
    await services().records.confirm('record-1');
    await settle();
    expect(calls(fetchMock, '/dashboard').length).toBeGreaterThan(before);
    expect(text('[data-binding="weeklyStat-totalMeals"]')).toBe('1');
  });

  // 显式注入冲突以覆盖并发竞争的恢复分支；已 CONFIRMED 路由通常直接幂等返回当前实体。
  it('确认 409 拉取最新单条已确认实体，自愈三视图并明确提示', async () => {
    const state = stateFixture();
    let conflict = false;
    const fetchMock = await boot(state, async (url, init) => {
      if (conflict && String(url).endsWith('/confirm') && init?.method === 'POST')
        return ok({ code: 'VERSION_CONFLICT', message: '版本冲突，请读取最新记录' }, 409);
      return undefined;
    });
    await modal().open('dailyDiary', payload);
    state.records[0].status = 'CONFIRMED';
    state.records[0].version = 3;
    state.records[0].confirmedAt = '2026-09-11T03:00:00Z';
    conflict = true;
    buttons('#plansListContainer')[0].click();
    await settle();
    expect(calls(fetchMock, '/confirm', 'POST')).toHaveLength(1);
    expect(calls(fetchMock, '/records/record-1').filter(([url]) => !String(url).endsWith('/confirm'))).toHaveLength(1);
    expect(services().records.data[0]).toMatchObject({ status: 'CONFIRMED', version: 3 });
    expectDraftViews(0);
    expect(text('#plansListContainer')).toContain('已确认用餐');
    expect(text('#dailyDiarySubtitle')).toContain('已确认 1 餐');
    expect(text('#toastText')).toMatch(/冲突|已被.*修改|最新/);
  });

  it('409 返回新版 DRAFT 后可按新版重试，异常兜底响应不覆盖已有缓存', async () => {
    const state = stateFixture();
    const fetchMock = await boot(state);
    state.records[0].version = 4;
    await expect(services().records.confirm('record-1')).rejects.toMatchObject({ status: 409 });
    expect(services().records.data[0].version).toBe(4);
    await services().records.confirm('record-1');
    expect(JSON.parse(String(calls(fetchMock, '/confirm', 'POST')[1][1]?.body))).toEqual({ version: 4 });
    expect(services().records.data[0].status).toBe('CONFIRMED');
    const invalidState = stateFixture();
    await boot(invalidState, async (url, init) => {
      if (String(url).endsWith('/records/record-1') && (!init?.method || init.method === 'GET'))
        return ok({ items: [], total: 0 });
      return undefined;
    });
    const cached = services().records.data[0];
    invalidState.records[0].version = 9;
    await expect(services().records.confirm('record-1')).rejects.toMatchObject({ status: 409 });
    expect(services().records.data[0]).toBe(cached);
  });

  it('记录编辑弹窗保存草稿仍为 DRAFT，撤销 409 不清空计划和记录', async () => {
    const state = stateFixture();
    const fetchMock = await boot(state);
    await (window as any).openEditRecord('record-1');
    (document.getElementById('formRecordNotes') as HTMLTextAreaElement).value = '我修改过的草稿';
    const event = {
      preventDefault: vi.fn(),
      currentTarget: document.querySelector('#modalRecordForm form'),
      submitter: document.querySelector('#modalRecordForm button[type="submit"]')
    };
    await modal().handleRecordFormSubmit(event);
    expect(services().records.data[0]).toMatchObject({ status: 'DRAFT', notes: '我修改过的草稿', version: 2 });
    expect(calls(fetchMock, '/records/record-1', 'PUT')).toHaveLength(1);
    await expect(services().plans.uncheckin('plan-1')).rejects.toMatchObject({ status: 409 });
    expect(services().plans.data[0]).toMatchObject({ id: 'plan-1', isCompleted: true });
    expect(services().records.data).toHaveLength(1);
    expect(text('#toastText')).toContain('不能撤销');
  });

  it('未编辑草稿撤销后移除，再打卡恢复同一条且日记即时刷新', async () => {
    const state = stateFixture();
    const fetchMock = await boot(state);
    await modal().open('dailyDiary', payload);
    activePage('calendar');
    const calendar = vi.spyOn(window as any, 'renderCalendar');
    await services().plans.uncheckin('plan-1');
    await settle();
    expect(services().records.data).toHaveLength(0);
    expect(services().plans.data[0].isCompleted).toBe(false);
    expect(buttons('#dailyDiaryMealsList')).toHaveLength(0);
    expect(text('#dailyDiarySubtitle')).not.toContain('待确认草稿');
    expect(calendar).toHaveBeenCalled();
    await services().plans.checkin('plan-1');
    await settle();
    expect(state.records).toHaveLength(1);
    expect(services().records.data[0]).toMatchObject({ id: 'record-1', status: 'DRAFT' });
    expectDraftViews(1);
    expect(calls(fetchMock, '/uncomplete', 'POST')).toHaveLength(1);
  });

  it('恶意标题备注与特殊字符 ID 保持纯文本，三个入口仍绑定原始 ID', async () => {
    const recordId = `rec'"/><svg onload=window.__draftXss=1>`;
    const planId = `plan'"/><img src=x onerror=window.__draftXss=2>`;
    const title = '<img src=x onerror="window.__draftXss=3"> & <script>window.__draftXss=4</script>';
    const notes = '<svg onload="window.__draftXss=5">备注</svg>';
    const state: State = {
      plans: [planFixture({ id: planId, title, subtext: notes })],
      records: [recordFixture({ id: recordId, sourceMealPlanId: planId, relatedPlanId: planId, title, notes })]
    };
    (window as any).__draftXss = 0;
    const fetchMock = await boot(state);
    await modal().open('dailyDiary', payload);
    expectDraftViews(1);
    for (const selector of ['#recordsListContainer', '#dailyDiaryMealsList', '#plansListContainer']) {
      const container = document.querySelector(selector)!;
      expect(container.textContent).toContain(title);
      expect(container.textContent).toContain(notes);
      expect(container.querySelector('svg, script, img, [onclick], [onerror], [onload]')).toBeNull();
    }
    const confirmSpy = vi.spyOn(services().records, 'confirm').mockResolvedValue(false);
    for (const selector of ['#recordsListContainer', '#dailyDiaryMealsList', '#plansListContainer']) {
      buttons(selector)[0].click();
      await settle();
    }
    expect(confirmSpy.mock.calls).toEqual([[recordId], [recordId], [recordId]]);
    confirmSpy.mockRestore();
    buttons('#plansListContainer')[0].click();
    await settle();
    expect(calls(fetchMock, `/records/${encodeURIComponent(recordId)}/confirm`, 'POST')).toHaveLength(1);
    expect((window as any).__draftXss).toBe(0);
    const uncheckin = vi.spyOn(services().plans, 'uncheckin').mockResolvedValue(false);
    document.querySelector<HTMLButtonElement>('#plansListContainer button[title="点击取消打卡"]')?.click();
    await settle();
    expect(uncheckin).toHaveBeenCalledWith(planId);
  });
});
