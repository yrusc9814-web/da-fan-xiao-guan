import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapter = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// VAN-33/35 的测试必须用正式 SoT（index.html）里的真实标记，禁止手写近似 fixture 掩盖接线错误
const sourceSection = (selector: string) =>
  new DOMParser().parseFromString(html, 'text/html').querySelector(selector)?.outerHTML || '';
const weekCalendarMarkup = () =>
  `${sourceSection('[data-binding="calendarDays"]')}${sourceSection('.mobile-week-calendar-list')}`;
const settingsButton = (title: string) => {
  const row = Array.from(document.querySelectorAll('#page-settings h4')).find(
    (node) => node.textContent?.trim() === title
  )?.parentElement?.parentElement;
  return (row?.querySelector('button') as HTMLButtonElement) || null;
};

const jsonOk = (data: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  text: async () => JSON.stringify({ success: true, data })
});
const jsonFail = (status: number, code: string, message = code, headers = new Headers()) => ({
  ok: false,
  status,
  headers,
  text: async () => JSON.stringify({ success: false, error: { code, message } })
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('condition not met');
};
const storedValues = () =>
  Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index)!));
const pinMarkup = () => sourceSection('#modalPinUnlock');
const restoreMarkup = () =>
  `${sourceSection('#page-settings')}${sourceSection('#modalBackupRestore')}<section id="page-home" class="active"></section>`;

// 模拟真实文件输入的 value='' 语义（jsdom 不会联动清空 files），以便验证取消/关闭是否真正丢弃已选文件
const setRestoreFile = (file: File) => {
  const input = document.getElementById('google2RestoreFile') as HTMLInputElement;
  let files: File[] = [file];
  let value = `C:\\fakepath\\${file.name}`;
  Object.defineProperty(input, 'files', { configurable: true, get: () => files });
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => value,
    set: (next: string) => {
      value = next;
      if (next === '') files = [];
    }
  });
  return input;
};

const openRestoreDialogWith = async (file: File) => {
  const input = setRestoreFile(file);
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
};

async function mountBackupRestore(options: { pinEnabled: boolean; settingsFailure?: boolean; deferSession?: boolean }) {
  document.body.innerHTML = restoreMarkup();
  const order: string[] = [];
  const reloadSpies = {
    stores: vi.fn(() => order.push('stores')),
    recipes: vi.fn(() => order.push('recipes')),
    pantry: vi.fn(() => order.push('pantry')),
    shopping: vi.fn(() => order.push('shopping')),
    plans: vi.fn(() => order.push('plans')),
    records: vi.fn(() => order.push('records')),
    tools: vi.fn(() => order.push('tools'))
  };
  const service: any = {};
  Object.keys(reloadSpies).forEach((key) => {
    service[key] = { data: [], reload: (reloadSpies as any)[key] };
  });
  (window as any).BentoService = service;
  (window as any).showToast = vi.fn();
  const sessionToken = '{{SECRET_fsm3vb9q}}';
  const riskToken = '{{SECRET_9xqk2mna}}';
  const challengeToken = 'restore-challenge-1';
  const sessionResponse = jsonOk(
    options.pinEnabled ? { valid: true, required: true, token: sessionToken } : { valid: true }
  );
  let settingsFailure = false;
  let resolveSession: (() => void) | null = null;
  const fetchMock = vi.fn(async (url: any, init?: any) => {
    const target = String(url);
    if (target.endsWith('/settings/pin/session')) {
      if (!options.deferSession) return sessionResponse;
      return new Promise((resolve) => {
        resolveSession = () => resolve(sessionResponse);
      });
    }
    if (target.endsWith('/settings/high-risk/authorize')) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.pin || body.confirmation === 'RESTORE_LOCAL_DATA') return jsonOk({ token: riskToken });
      return jsonOk({ challenge: challengeToken });
    }
    if (target.endsWith('/backups/restore')) return jsonOk({ restored: true });
    if (target.endsWith('/settings')) {
      if (settingsFailure) return jsonFail(500, 'SETTINGS_READ_FAILED', '设置读取失败');
      return jsonOk({ pinEnabled: options.pinEnabled });
    }
    return jsonOk({});
  });
  vi.stubGlobal('fetch', fetchMock);
  window.eval(adapter);
  await flush();
  await flush();
  Object.keys(reloadSpies).forEach((key) => {
    service[key].reload = (reloadSpies as any)[key];
  });
  const dashboard = vi.fn();
  (window as any).DafanDashboardAdapter.refreshDashboard = dashboard;
  document.getElementById('page-home')?.classList.add('active');
  await (window as any).DafanSettingsAdapter.wireSettings().catch(() => undefined);
  settingsFailure = options.settingsFailure === true;
  fetchMock.mockClear();
  return {
    fetchMock,
    reloadSpies,
    dashboard,
    order,
    sessionToken,
    riskToken,
    challengeToken,
    setSettingsFailure: (value: boolean) => {
      settingsFailure = value;
    },
    resolveSession: () => resolveSession?.()
  };
}

describe('Google2 legacy entry adapter', () => {
  it('正式入口引用 adapter，DOMContentLoaded 后清除 legacy mock state', async () => {
    expect(html).toContain('<script src="/google2-adapter.js"></script>');
    expect(html).not.toContain('`r`n');
    document.body.innerHTML =
      '<div id="storeCardGrid"><div>mock</div></div><div id="inventoryCardGrid"><div>mock</div></div>';
    (window as any).BentoService = { stores: { data: [{ id: 'mock' }] }, recipes: { data: [{ id: 'mock' }] } };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            success: true,
            data: {
              branding: {},
              todayRecords: [],
              recommendedRecipes: [],
              inventory: {},
              weeklyStats: {},
              calendarDays: [],
              tip: ''
            }
          })
      })
    );
    window.eval(adapter);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await Promise.resolve();
    expect((window as any).BentoService.stores.data).toEqual([]);
    expect((window as any).BentoService.recipes.data).toEqual([]);
  });

  it('Dashboard 全字段来自 DTO，空值不会残留首页业务 mock', () => {
    document.body.innerHTML = `
      <section id="page-home">
        <span data-binding="currentDate" class="greeting-weather">晴 24°C</span><span data-binding="greetingTitle" class="greeting-title">mock</span><span data-binding="tip" class="greeting-bubble-text">mock</span>
        <div data-binding="recommendedRecipes" class="recipe-scroller-track"><div><h5 data-business-value="name">mock</h5><span>mock</span><span>mock</span></div></div>
        <div data-binding="dashboardCards" class="dashboard-info-grid-responsive"><div data-binding="todayRecords"><div data-binding="todayRecord-0"><div class="flex flex-col gap-2"><div><div class="text-xs">早餐</div><div data-business-value="title" class="text-[11px]">mock</div><span data-business-value="status">已完成</span></div></div><span data-binding="todayRecordsCount" class="text-[#FF6B57]">2/3 餐</span></div><div data-binding="weeklyStats"><span data-binding="weeklyStat-recordedDays" class="text-xl">5/7 天</span><span data-binding="weeklyStat-totalMeals" class="text-xl">14</span><span data-binding="weeklyStat-averageRating" class="text-xl">4.8</span><span data-binding="weeklyStat-consumedIngredientCount" class="text-xl">28</span></div><div data-binding="inventory"><span data-binding="inventory-totalIngredients" class="text-lg">32</span><span data-binding="inventory-expiringSoon" class="text-lg">3</span><span data-binding="inventory-insufficient" class="text-lg">2</span></div></div>
      </section>`;
    window.eval(adapter);
    const dto = {
      branding: { appName: '真实应用' },
      userNickname: null,
      greetingPeriod: 'morning',
      greetingText: '真实提示',
      recommendedRecipes: [],
      todayRecords: [],
      inventory: { totalIngredients: 0, expiringSoon: 0, insufficient: 0, expiringIngredients: [] },
      weeklyStats: { recordedDays: 0, totalMeals: 0, averageRating: null, consumedIngredientCount: 0 },
      calendarDays: [],
      tip: ''
    };
    (window as any).DafanDashboardAdapter.mapDashboard(dto);
    expect(document.querySelector('.greeting-weather')?.textContent).toBe('');
    expect(document.querySelector('.greeting-bubble-text')?.textContent).toBe('真实提示');
    expect(document.querySelector('.recipe-scroller-track > div')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('.dashboard-info-grid-responsive')?.textContent).not.toContain('mock');
  });

  it('Dashboard 非空 DTO 精确映射推荐/统计/日历/临期，随后空 DTO 全清理', () => {
    document.body.innerHTML = `<div data-binding="recommendedRecipes"><div><b data-business-value="name"></b><i data-business-value="tags"></i><i data-business-value="time"></i><i data-business-value="rating"></i></div></div><div data-binding="todayRecords"><div data-binding="todayRecord-0"><span data-business-value="title"></span><span data-business-value="status"></span></div></div><span data-binding="todayRecordsCount"></span><span data-binding="inventory-totalIngredients"></span><span data-binding="weeklyStat-totalMeals"></span><div data-binding="calendarDays">${Array.from({ length: 3 }, (_, i) => `<div data-binding="calendarDay-${i}"><span data-business-value="weekday"></span><span data-business-value="dayOfMonth"></span><span data-business-value="label"></span></div>`).join('')}</div><div data-binding="expiringIngredients"><div data-binding="expiringIngredient-0"><span data-business-value="name"></span><span data-business-value="expiry"></span></div></div>`;
    window.eval(adapter);
    const map = (window as any).DafanDashboardAdapter.mapDashboard;
    map({
      recommendedRecipes: [{ id: 'r', name: '菜', tags: ['快手'], cookingTimeMinutes: 10, rating: 4.5 }],
      todayRecords: [{ title: '午餐', recorded: true }],
      inventory: { totalIngredients: 3, expiringIngredients: [{ id: 'i', name: '葱', expireDaysLeft: 2 }] },
      weeklyStats: { totalMeals: 8 },
      calendarDays: [
        { weekday: '一', dayOfMonth: 28, isToday: true, date: '2026-09-28', status: 'recorded' },
        { weekday: '二', dayOfMonth: 29, isToday: false, date: '2026-09-29', status: 'planned' },
        { weekday: '三', dayOfMonth: 30, isToday: false, date: '2026-09-30', status: 'empty' }
      ]
    });
    expect(document.querySelector('[data-business-value="name"]')?.textContent).toBe('菜');
    expect(document.querySelector('[data-business-value="tags"]')?.textContent).toBe('快手');
    expect(document.querySelector('[data-business-value="time"]')?.textContent).toContain('10');
    expect(document.querySelector('[data-business-value="rating"]')?.textContent).toContain('4.5');
    expect(document.querySelector('[data-binding="todayRecordsCount"]')?.textContent).toBe('1/1 餐');
    expect(document.querySelector('[data-binding="inventory-totalIngredients"]')?.textContent).toBe('3');
    expect(document.querySelector('[data-binding="weeklyStat-totalMeals"]')?.textContent).toBe('8');
    expect(document.querySelector('[data-binding="calendarDay-0"]')?.dataset.date).toBe('2026-09-28');
    expect(document.querySelector('[data-binding="calendarDay-0"] [data-business-value="weekday"]')?.textContent).toBe(
      '今天'
    );
    expect(
      document.querySelector('[data-binding="calendarDay-0"] [data-business-value="dayOfMonth"]')?.textContent
    ).toBe('28');
    expect(document.querySelector('[data-binding="calendarDay-0"] [data-business-value="label"]')?.textContent).toBe(
      '1餐已记录'
    );
    expect(document.querySelector('[data-binding="calendarDay-1"] [data-business-value="weekday"]')?.textContent).toBe(
      '周二'
    );
    expect(document.querySelector('[data-binding="calendarDay-1"] [data-business-value="label"]')?.textContent).toBe(
      '已排餐'
    );
    expect(document.querySelector('[data-binding="calendarDay-2"] [data-business-value="label"]')?.textContent).toBe(
      ''
    );
    expect(
      document.querySelector('[data-binding="expiringIngredient-0"] [data-business-value="expiry"]')?.textContent
    ).toBe('2天后到期');
    map({
      recommendedRecipes: [],
      todayRecords: [],
      inventory: { expiringIngredients: [] },
      weeklyStats: {},
      calendarDays: []
    });
    expect(document.querySelector('[data-business-value="name"]')?.textContent).toBe('');
    expect(document.querySelector('[data-binding="calendarDay-0"]')?.hidden).toBe(true);
  });

  it('问候卡绑定只更新叶子节点，不会清空嵌套结构', () => {
    document.body.innerHTML = `
      <section id="homeGreetingCard">
        <div class="header"><span data-binding="branding">旧品牌</span><span data-binding="currentDate">旧日期</span></div>
        <h1 data-binding="greetingTitle">旧标题</h1>
        <div class="bubble"><span class="icon">💡</span><span data-binding="tip">旧提示</span></div>
      </section>`;
    window.eval(adapter);
    (window as any).DafanDashboardAdapter.mapDashboard({
      branding: { appName: '搭饭小馆' },
      currentDate: '2026-09-29',
      greetingTitle: '早上好',
      greetingText: '今天也要好好吃饭',
      calendarDays: [],
      todayRecords: [],
      recommendedRecipes: [],
      inventory: {},
      weeklyStats: {}
    });
    expect(document.querySelector('#homeGreetingCard .header')).not.toBeNull();
    expect(document.querySelector('#homeGreetingCard .bubble .icon')).not.toBeNull();
    expect(document.querySelector('[data-binding="branding"]')?.textContent).toBe('搭饭小馆');
    expect(document.querySelector('[data-binding="currentDate"]')?.textContent).toBe('2026-09-29');
    expect(document.querySelector('[data-binding="greetingTitle"]')?.textContent).toBe('早上好');
    expect(document.querySelector('[data-binding="tip"]')?.textContent).toBe('今天也要好好吃饭');
  });

  it('日历和临期项重映射只保留最新 handler，空态会清空 dataset 与 onclick', () => {
    document.body.innerHTML = `
      <div data-binding="calendarDays">${Array.from({ length: 7 }, (_, i) => `<div data-binding="calendarDay-${i}"><span data-business-value="weekday"></span><span data-business-value="dayOfMonth"></span><span data-business-value="label"></span></div>`).join('')}</div>
      <div data-binding="expiringIngredients"><div data-binding="expiringIngredient-0"><span data-business-value="name"></span><span data-business-value="expiry"></span></div><div data-binding="expiringIngredient-1"><span data-business-value="name"></span><span data-business-value="expiry"></span></div></div>`;
    const open = vi.fn();
    (window as any).BentoModal = { open };
    window.eval(adapter);
    const map = (window as any).DafanDashboardAdapter.mapDashboard;
    const base = { branding: {}, recommendedRecipes: [], todayRecords: [], inventory: {}, weeklyStats: {} };
    map({
      ...base,
      calendarDays: [{ date: '2026-09-01', weekday: '二', dayOfMonth: '1', status: 'recorded' }],
      inventory: { expiringIngredients: [{ id: 'old-id', name: '旧食材', expireDaysLeft: 1 }] }
    });
    map({
      ...base,
      calendarDays: [{ date: '2026-09-02', weekday: '三', dayOfMonth: '2', status: 'planned' }],
      inventory: { expiringIngredients: [{ id: 'new-id', name: '新食材', expireDaysLeft: 2 }] }
    });
    document.querySelector('[data-binding="calendarDay-0"]')?.dispatchEvent(new MouseEvent('click'));
    document.querySelector('[data-binding="expiringIngredient-0"]')?.dispatchEvent(new MouseEvent('click'));
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, 'dailyDiary', { year: 2026, month: 9, day: 2 });
    expect(open).toHaveBeenNthCalledWith(2, 'ingredientDetail', 'new-id');
    map({ ...base, calendarDays: [], inventory: { expiringIngredients: [] } });
    document.querySelector('[data-binding="calendarDay-0"]')?.dispatchEvent(new MouseEvent('click'));
    document.querySelector('[data-binding="expiringIngredient-0"]')?.dispatchEvent(new MouseEvent('click'));
    expect(open).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-binding="calendarDay-0"]')?.dataset.date).toBeUndefined();
    expect(document.querySelector('[data-binding="calendarDay-0"]')?.onclick).toBeNull();
    expect(document.querySelector('[data-binding="expiringIngredient-0"]')?.dataset.ingredientId).toBeUndefined();
    expect(document.querySelector('[data-binding="expiringIngredient-0"]')?.onclick).toBeNull();
  });

  it('正式入口初始日历 7 项和临期 2 项不含硬编码 onclick', () => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    expect(parsed.querySelectorAll('[data-binding^="calendarDay-"]').length).toBe(7);
    expect(parsed.querySelectorAll('[data-binding^="calendarDay-"][onclick]').length).toBe(0);
    expect(parsed.querySelectorAll('[data-binding^="expiringIngredient-"]').length).toBe(2);
    expect(parsed.querySelectorAll('[data-binding^="expiringIngredient-"][onclick]').length).toBe(0);
  });

  it('正式入口周打卡区域（桌面 + 移动）不残留任何演示假数据', () => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    expect(parsed.querySelectorAll('.mobile-week-calendar-list [data-binding^="mobileCalendarDay-"]').length).toBe(7);
    expect(
      parsed.querySelectorAll('.mobile-week-calendar-list [data-binding^="mobileCalendarDay-"][onclick]').length
    ).toBe(0);
    const weekArea = parsed.querySelector('[data-binding="calendarDays"]')?.textContent || '';
    const mobileArea = parsed.querySelector('.mobile-week-calendar-list')?.textContent || '';
    for (const demo of ['周一 9/1', '周二 9/2', '3餐已完成', '2/3餐进行中', '已达标', '记录中', '3餐完成', '进行中']) {
      expect(`${weekArea}${mobileArea}`).not.toContain(demo);
    }
    // 每个周历槽位都有 data-business-value 叶子绑定，供 adapter 写入真实数据
    parsed.querySelectorAll('[data-binding^="calendarDay-"]').forEach((card) => {
      expect(
        card.querySelectorAll(
          '[data-business-value="weekday"], [data-business-value="dayOfMonth"], [data-business-value="label"]'
        ).length
      ).toBe(3);
    });
    parsed.querySelectorAll('.mobile-week-calendar-list [data-binding^="mobileCalendarDay-"]').forEach((row) => {
      expect(
        row.querySelectorAll(
          '[data-business-value="dateBadge"], [data-business-value="statusText"], [data-business-value="statusPill"]'
        ).length
      ).toBe(3);
    });
  });

  it('移动端周打卡列表由真实 calendarDays 填充，空态隐藏行并清理演示内容', () => {
    document.body.innerHTML = `
      <div data-binding="calendarDays">
        ${Array.from(
          { length: 7 },
          (_, i) =>
            `<div data-binding="calendarDay-${i}"><span data-business-value="weekday">mock</span><span data-business-value="dayOfMonth">mock</span><span data-business-value="label">mock</span></div>`
        ).join('')}
      </div>
      <div class="mobile-week-calendar-list">
        ${Array.from(
          { length: 7 },
          (_, i) =>
            `<div data-binding="mobileCalendarDay-${i}"><div><span data-business-value="dateBadge">周一 9/1</span><span data-business-value="statusText">3餐已完成</span></div><span data-business-value="statusPill">已达标</span></div>`
        ).join('')}
      </div>`;
    const open = vi.fn();
    (window as any).BentoModal = { open };
    window.eval(adapter);
    const map = (window as any).DafanDashboardAdapter.mapDashboard;
    const base = { branding: {}, recommendedRecipes: [], inventory: {}, weeklyStats: {} };
    map({
      ...base,
      todayRecords: [{ recorded: true }, { recorded: false }],
      calendarDays: [
        { weekday: '一', dayOfMonth: 28, isToday: true, date: '2026-09-28', status: 'recorded' },
        { weekday: '二', dayOfMonth: 29, isToday: false, date: '2026-09-29', status: 'empty' }
      ]
    });
    const row0 = document.querySelector('[data-binding="mobileCalendarDay-0"]');
    expect(row0?.hidden).toBe(false);
    expect(row0?.querySelector('[data-business-value="dateBadge"]')?.textContent).toBe('今天 9/28');
    expect(row0?.querySelector('[data-business-value="statusText"]')?.textContent).toBe('1餐已记录');
    expect(row0?.querySelector('[data-business-value="statusPill"]')?.textContent).toBe('1餐 ✓');
    const row1 = document.querySelector('[data-binding="mobileCalendarDay-1"]');
    expect(row1?.querySelector('[data-business-value="dateBadge"]')?.textContent).toBe('周二 9/29');
    expect(row1?.querySelector('[data-business-value="statusText"]')?.textContent).toBe('');
    expect(row1?.querySelector('[data-business-value="statusPill"]')?.textContent).toBe('未记录');
    row0?.dispatchEvent(new MouseEvent('click'));
    expect(open).toHaveBeenCalledWith('dailyDiary', { year: 2026, month: 9, day: 28 });
    // 桌面与移动是并行视图：两套行各自按 days[i] 独立索引填充
    const desktop0 = document.querySelector('[data-binding="calendarDay-0"]');
    expect(desktop0?.hidden).toBe(false);
    expect(desktop0?.querySelector('[data-business-value="weekday"]')?.textContent).toBe('今天');
    expect(desktop0?.querySelector('[data-business-value="label"]')?.textContent).toBe('1餐已记录');
    map({ ...base, todayRecords: [], calendarDays: [] });
    expect(document.querySelector('[data-binding="mobileCalendarDay-0"]')?.hidden).toBe(true);
    expect(document.querySelector('[data-binding="mobileCalendarDay-0"]')?.onclick).toBeNull();
    expect(document.querySelector('[data-binding="mobileCalendarDay-0"]')?.dataset.date).toBeUndefined();
  });

  it('【VAN-33】周历进入日记传数值 year/month/day：桌面与移动都走真实 SoT 标记，且不串日期', () => {
    const markup = weekCalendarMarkup();
    expect(markup).toContain('calendarDay-6');
    expect(markup).toContain('mobileCalendarDay-6');
    document.body.innerHTML = markup;
    const open = vi.fn();
    (window as any).BentoModal = { open };
    window.eval(adapter);
    const map = (window as any).DafanDashboardAdapter.mapDashboard;
    const base = { branding: {}, recommendedRecipes: [], todayRecords: [], inventory: {}, weeklyStats: {} };
    map({
      ...base,
      calendarDays: [
        { weekday: '一', dayOfMonth: 31, isToday: false, date: '2026-08-31', status: 'recorded' },
        { weekday: '二', dayOfMonth: 1, isToday: false, date: '2026-09-01', status: 'empty' },
        { weekday: '三', dayOfMonth: 9, isToday: false, date: '2026-12-09', status: 'planned' },
        { weekday: '四', dayOfMonth: 1, isToday: false, date: '2027-01-01', status: 'empty' }
      ]
    });

    const desktop0 = document.querySelector('[data-binding="calendarDay-0"]') as HTMLElement;
    const desktop1 = document.querySelector('[data-binding="calendarDay-1"]') as HTMLElement;
    const desktop2 = document.querySelector('[data-binding="calendarDay-2"]') as HTMLElement;
    const desktop3 = document.querySelector('[data-binding="calendarDay-3"]') as HTMLElement;
    const mobile1 = document.querySelector('[data-binding="mobileCalendarDay-1"]') as HTMLElement;

    desktop0.click();
    // 跨月边界：8 月 31 日仍然是 8 月，不能被取整/进位到 9 月
    expect(open).toHaveBeenNthCalledWith(1, 'dailyDiary', { year: 2026, month: 8, day: 31 });
    desktop1.click();
    expect(open).toHaveBeenNthCalledWith(2, 'dailyDiary', { year: 2026, month: 9, day: 1 });
    // 单数字月份/日期必须保持数字 9 与 9，不能被 0 填充成字符串
    desktop2.click();
    expect(open).toHaveBeenNthCalledWith(3, 'dailyDiary', { year: 2026, month: 12, day: 9 });
    desktop3.click();
    // 跨年边界：1 月 1 日属于 2027，不能被进位回 2026
    expect(open).toHaveBeenNthCalledWith(4, 'dailyDiary', { year: 2027, month: 1, day: 1 });
    mobile1.click();
    expect(open).toHaveBeenNthCalledWith(5, 'dailyDiary', { year: 2026, month: 9, day: 1 });

    for (const call of open.mock.calls) {
      const payload = call[1] as Record<string, unknown>;
      expect(typeof payload.year).toBe('number');
      expect(typeof payload.month).toBe('number');
      expect(typeof payload.day).toBe('number');
      expect(Object.values(payload)).not.toContain(undefined);
    }
    // 真实 SoT 标记里不得残留把字符串日期直接当 payload 的旧接线
    expect(adapter).not.toMatch(/open\('dailyDiary',\s*value\.date/);
  });

  it('【VAN-33】非法或缺失业务日期不绑定日记入口，移动端与桌面一致 fail-closed', () => {
    document.body.innerHTML = weekCalendarMarkup();
    const open = vi.fn();
    (window as any).BentoModal = { open };
    window.eval(adapter);
    const map = (window as any).DafanDashboardAdapter.mapDashboard;
    const base = { branding: {}, recommendedRecipes: [], todayRecords: [], inventory: {}, weeklyStats: {} };
    map({
      ...base,
      calendarDays: [
        { weekday: '一', dayOfMonth: 31, isToday: false, date: '2026-02-31', status: 'empty' },
        { weekday: '二', dayOfMonth: 1, isToday: false, date: '2026-09-1', status: 'empty' },
        { weekday: '三', dayOfMonth: 1, isToday: false, date: '', status: 'empty' }
      ]
    });
    const rows = [
      document.querySelector('[data-binding="calendarDay-0"]'),
      document.querySelector('[data-binding="mobileCalendarDay-0"]'),
      document.querySelector('[data-binding="calendarDay-1"]'),
      document.querySelector('[data-binding="mobileCalendarDay-1"]'),
      document.querySelector('[data-binding="calendarDay-2"]'),
      document.querySelector('[data-binding="mobileCalendarDay-2"]')
    ];
    rows.forEach((row) => {
      expect((row as HTMLElement).onclick).toBeNull();
      row?.dispatchEvent(new MouseEvent('click'));
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('【VAN-33】真实 2 月 29 日与月份/日期边界按日历校验（拒 2026-02-31 等）', () => {
    document.body.innerHTML = weekCalendarMarkup();
    const open = vi.fn();
    (window as any).BentoModal = { open };
    window.eval(adapter);
    const map = (window as any).DafanDashboardAdapter.mapDashboard;
    const base = { branding: {}, recommendedRecipes: [], todayRecords: [], inventory: {}, weeklyStats: {} };
    map({
      ...base,
      calendarDays: [
        { weekday: '六', dayOfMonth: 29, isToday: false, date: '2024-02-29', status: 'recorded' },
        { weekday: '日', dayOfMonth: 30, isToday: false, date: '2026-04-31', status: 'empty' },
        { weekday: '一', dayOfMonth: 1, isToday: false, date: '2026-13-01', status: 'empty' },
        { weekday: '二', dayOfMonth: 1, isToday: false, date: '2026-00-01', status: 'empty' }
      ]
    });
    (document.querySelector('[data-binding="calendarDay-0"]') as HTMLElement).click();
    expect(open).toHaveBeenNthCalledWith(1, 'dailyDiary', { year: 2024, month: 2, day: 29 });
    for (const index of [1, 2, 3]) {
      const row = document.querySelector(`[data-binding="calendarDay-${index}"]`) as HTMLElement;
      expect(row.onclick).toBeNull();
      row.click();
    }
    expect(open).toHaveBeenCalledTimes(1);
  });

  // 忌口成员读取是推荐请求的前置输入：diners 走真实分页响应，random 按用例给固定结果
  const dinersPage = {
    items: [
      { id: 'd1', name: '小夏', active: true, version: 1, tabooText: null, allergyText: null, dislikesText: null }
    ],
    page: 1,
    pageSize: 100,
    total: 1,
    totalPages: 1
  };
  const routeRecommendations = (fetchMock: ReturnType<typeof vi.fn>, random: () => unknown) =>
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(String(url).includes('/diners') ? jsonOk(dinersPage) : jsonOk(random()))
    );

  it('正式入口转盘落点由 recommendation API 驱动：命中当前扇区返回真实索引', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const items = [
      { id: 'r1', title: '菜一', type: 'recipe' },
      { id: 's1', title: '店一', type: 'store' },
      { id: 'r2', title: '菜二', type: 'recipe' }
    ];
    (window as any).getDynamicWheelItems = () => items;
    const renderWheelSlices = vi.fn();
    (window as any).renderWheelSlices = renderWheelSlices;
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    routeRecommendations(fetchMock, () => ({
      historyId: 'h1',
      type: 'SINGLE',
      results: [{ resultType: 'RECIPE', resultId: 'r2', title: '菜二' }]
    }));
    const randomSpy = vi.spyOn(Math, 'random');
    const index = await (window as any).DafanWheelAdapter.resolveTargetIndex('all');
    expect(index).toBe(2);
    expect(randomSpy).not.toHaveBeenCalled();
    const randomCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/recommendations/random'));
    expect(randomCalls).toHaveLength(1);
    expect(randomCalls[0][0]).toBe('/api/v1/recommendations/random');
    expect(randomCalls[0][1].method).toBe('POST');
    expect(JSON.parse(randomCalls[0][1].body)).toEqual({ dinerIds: ['d1'] });
    expect(renderWheelSlices).not.toHaveBeenCalled();
    randomSpy.mockRestore();
  });

  it('推荐结果不在当前扇区时映射进最后一个扇区并重渲染，模式映射到精确请求体', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const items = [
      { id: 'r1', title: '菜一', type: 'recipe', sub: 'A · 10分钟' },
      { id: 's1', title: '店一', type: 'store', sub: 'B · 人均¥30' },
      { id: 'r2', title: '菜二', type: 'recipe', sub: '' }
    ];
    (window as any).getDynamicWheelItems = () => items;
    const renderWheelSlices = vi.fn();
    (window as any).renderWheelSlices = renderWheelSlices;
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] } };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    (window as any).BentoService.stores.data = [
      { id: 's9', name: '推荐新店', category: '轻食', price: 28, supportsDineIn: true }
    ];
    fetchMock.mockReset();
    routeRecommendations(fetchMock, () => ({
      historyId: 'h2',
      type: 'SINGLE',
      results: [{ resultType: 'STORE', resultId: 's9', title: '推荐新店' }]
    }));
    const index = await (window as any).DafanWheelAdapter.resolveTargetIndex('takeout');
    const randomCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/recommendations/random'));
    expect(randomCalls).toHaveLength(1);
    expect(randomCalls[0][0]).toBe('/api/v1/recommendations/random');
    expect(JSON.parse(randomCalls[0][1].body)).toEqual({
      dinerIds: ['d1'],
      sourceTypes: ['STORE'],
      acquisitionModes: ['TAKEOUT']
    });
    expect(index).toBe(2);
    expect(items[2]).toMatchObject({ id: 's9', type: 'store', title: '推荐新店', sub: '轻食 · 人均¥28' });
    expect(renderWheelSlices).toHaveBeenCalledTimes(1);
  });

  it('推荐 API 无结果或失败时 fail-closed：返回 null、toast 提示、不伪造落点', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    (window as any).getDynamicWheelItems = () => [{ id: 'r1', title: '菜一', type: 'recipe' }];
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('/diners') ? jsonOk(dinersPage) : jsonOk({ historyId: 'h3', type: 'SINGLE', results: [] })
      )
    );
    const emptyIndex = await (window as any).DafanWheelAdapter.resolveTargetIndex('cook');
    expect(emptyIndex).toBeNull();
    const emptyCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/recommendations/random'));
    expect(emptyCalls).toHaveLength(1);
    expect(emptyCalls[0][0]).toBe('/api/v1/recommendations/random');
    expect(JSON.parse(emptyCalls[0][1].body)).toEqual({ dinerIds: ['d1'], sourceTypes: ['RECIPE'] });
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('暂无符合条件'), 'info');
    const unavailable = {
      ok: false,
      status: 503,
      headers: new Headers(),
      text: async () => JSON.stringify({ success: false, error: { code: 'UNAVAILABLE' } })
    };
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(String(url).includes('/diners') ? jsonOk(dinersPage) : unavailable)
    );
    const failIndex = await (window as any).DafanWheelAdapter.resolveTargetIndex('cook');
    expect(failIndex).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('503'), 'error');
    expect(Math.random).toBeTypeOf('function');
  });

  it('【VAN-35】真实 Settings 区块：备份按钮走 exportBackup，忌口按钮不触发导出', async () => {
    const settingsMarkup = sourceSection('#page-settings');
    expect(settingsMarkup).toContain('数据备份与导出');
    expect(settingsMarkup).toContain('食用者忌口偏好');
    document.body.innerHTML = settingsMarkup;
    const backupResponse = {
      ok: true,
      headers: new Headers({ 'Content-Disposition': 'attachment; filename="backup.zip"' }),
      blob: async () => new Blob(['zip'])
    };
    const settingsResponse = { ok: true, text: async () => JSON.stringify({ success: true, data: {} }) };
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(String(url).includes('/backups/export') ? backupResponse : settingsResponse)
    );
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn().mockReturnValue('blob:test');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const toast = vi.fn();
    (window as any).showToast = toast;
    localStorage.setItem('dafan-pin-token', 'secret-token');
    window.eval(adapter);
    await (window as any).DafanSettingsAdapter.wireSettings();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const backupButton = settingsButton('数据备份与导出');
    const tabooButton = settingsButton('食用者忌口偏好');
    expect(backupButton).not.toBeNull();
    expect(tabooButton).not.toBeNull();

    fetchMock.mockClear();
    backupButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const backupCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/backups/export'));
    expect(backupCalls).toHaveLength(1);
    expect(backupCalls[0][0]).toBe('/api/v1/backups/export');
    expect(backupCalls[0][0]).not.toContain('secret-token');
    expect(backupCalls[0][1].headers).toMatchObject({ 'X-App-Pin-Token': 'secret-token' });
    expect(backupCalls[0][1].headers).not.toHaveProperty('Content-Type');
    expect(backupCalls[0][1].body).toBeUndefined();
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
    expect(backupButton?.disabled).toBe(false);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    backupButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('403'), 'error');
    expect(backupButton?.disabled).toBe(false);

    // 忌口按钮：真实弹窗入口，不再宣称「暂未开放」；此 fixture 未挂弹窗 DOM，
    // 因此只允许保持静默（不发写请求、不触发导出、不弹误导提示）
    fetchMock.mockClear();
    toast.mockClear();
    tabooButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const writes = fetchMock.mock.calls.filter(([, init]) => ['POST', 'PUT', 'DELETE'].includes(String(init?.method)));
    expect(writes).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/backups/export'))).toHaveLength(0);
    expect(toast).not.toHaveBeenCalled();
    expect(document.getElementById('page-settings')?.textContent || '').not.toContain('暂未开放编辑');
  });

  it('【VAN-35】boot 之后再调用 wireSettings 不会重复绑定备份入口', async () => {
    document.body.innerHTML = sourceSection('#page-settings');
    const settingsResponse = { ok: true, text: async () => JSON.stringify({ success: true, data: {} }) };
    const backupResponse = { ok: true, blob: async () => new Blob(['zip']) };
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(String(url).includes('/backups/export') ? backupResponse : settingsResponse)
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn().mockReturnValue('blob:test'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    (window as any).showToast = vi.fn();
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (window as any).DafanSettingsAdapter.wireSettings();
    fetchMock.mockClear();
    settingsButton('数据备份与导出')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/backups/export'))).toHaveLength(1);
    // 全部 wireSettings 路径都不得发送写请求
    expect(fetchMock.mock.calls.every(([, init]) => !init || !init.method)).toBe(true);
  });

  it('所有未接后端写入口均提示且不产生数据副作用', () => {
    const toast = vi.fn();
    (window as any).showToast = toast;
    const data = () => [];
    const service: any = {};
    const methods = {
      pantry: ['save', 'consume', 'delete'],
      plans: ['uncheckin'],
      records: ['buildFromPlan']
    };
    for (const [key, names] of Object.entries(methods))
      service[key] = {
        data: data(),
        getAll: () => ['must be cleared'],
        ...Object.fromEntries(names.map((name) => [name, vi.fn()]))
      };
    (window as any).BentoService = service;
    window.eval(adapter);
    for (const [key, names] of Object.entries(methods)) {
      for (const name of names) service[key][name]({ id: 'fake-id', date: '2026-09-11' });
      expect(service[key].data).toEqual([]);
      expect(service[key].getAll()).toEqual([]);
    }
    // plans.uncheckin is a real backend mutation now; an unknown id fails closed without a toast.
    expect(toast).toHaveBeenCalledTimes(3);
    expect(toast).toHaveBeenCalledWith('该功能尚未接通真实后端', 'error');
  });

  it('stores/recipes 真实 CRUD 与收藏使用 DTO、version 和正确路径', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({ success: true, data: { items: [{ id: 's1', name: '店', version: 2 }], total: 1 } })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            success: true,
            data: { items: [{ id: 'r1', name: '菜', version: 3, ingredients: [], steps: [] }], total: 1 }
          })
      });
    vi.stubGlobal('fetch', fetchMock);
    document.body.innerHTML = '<div data-binding="calendarDays"></div>';
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] } };
    (window as any).BentoModal = { close: vi.fn() };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stores = (window as any).BentoService.stores;
    const recipes = (window as any).BentoService.recipes;
    expect(stores.data[0]).toMatchObject({ id: 's1', name: '店', version: 2 });
    expect(recipes.data[0]).toMatchObject({ id: 'r1', name: '菜', version: 3 });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { id: 's1', name: '店', version: 3, favorite: true } })
    });
    await stores.toggleFavorite('s1');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/v1/stores/s1/favorite');
    expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body)).toEqual({ favorite: true, version: 2 });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { id: 'r1', name: '菜', version: 4, deleted: true } })
    });
    await recipes.delete('r1');
    expect(fetchMock.mock.calls.find(([url]) => String(url).includes('/api/v1/recipes/r1?version=3'))?.[0]).toBe(
      '/api/v1/recipes/r1?version=3'
    );
  });

  it('stores 与 recipes 的空分页清除旧列表并发出 changed', async () => {
    const changed = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { items: [], totalPages: 1 } })
    });
    vi.stubGlobal('fetch', fetchMock);
    (window as any).BentoBus = { emit: changed };
    const stores: any = { data: [{ id: 's-old' }] },
      recipes: any = { data: [{ id: 'r-old' }] };
    (window as any).BentoService = { stores, recipes };
    window.eval(adapter);
    await (window as any).DafanDomainAdapter.replaceStoreService(stores)();
    await (window as any).DafanDomainAdapter.replaceRecipeService(recipes)();
    expect(stores.data).toEqual([]);
    expect(recipes.data).toEqual([]);
    expect(changed).toHaveBeenCalledWith('stores:changed');
    expect(changed).toHaveBeenCalledWith('recipes:changed');
  });

  it('stores 分页聚合空列表并发出 stores:changed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ success: true, data: { items: [{ id: 's1' }], totalPages: 2 } })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ success: true, data: { items: [{ id: 's2' }] } })
      });
    vi.stubGlobal('fetch', fetchMock);
    const changed = vi.fn();
    (window as any).BentoBus = { emit: changed };
    (window as any).BentoService = { stores: { data: [{ id: 'old' }] }, recipes: { data: [] } };
    window.eval(adapter);
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ success: true, data: { items: [{ id: 's1' }], totalPages: 2 } })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ success: true, data: { items: [{ id: 's2' }] } })
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ success: true, data: { items: [{ id: 's1' }], totalPages: 2 } })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ success: true, data: { items: [{ id: 's2' }] } })
      });
    const reload = (window as any).DafanDomainAdapter.replaceStoreService((window as any).BentoService.stores);
    await reload();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/stores?page=1&pageSize=100',
      '/api/v1/stores?page=2&pageSize=100'
    ]);
    expect((window as any).BentoService.stores.data.map((x: any) => x.id)).toEqual(['s1', 's2']);
    expect(changed).toHaveBeenCalledWith('stores:changed');
  });

  it('recipes create 精确发送后端字段，热量按正式契约写入', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { id: 'r2', version: 2, name: '新菜' } })
    });
    vi.stubGlobal('fetch', fetchMock);
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] } };
    (window as any).BentoModal = { close: vi.fn() };
    window.eval(adapter);
    const service = (window as any).DafanDomainAdapter.replaceRecipeService((window as any).BentoService.recipes);
    await service.then?.(() => undefined);
    await (window as any).BentoService.recipes.save({
      name: '新菜',
      calories: 520,
      ingredients: [{ ingredientId: 'i1', name: '盐', quantity: 2, unit: 'PIECE', optional: true, isPrimary: true }],
      steps: [{ content: '翻炒', imagePath: '/x' }],
      tags: ['家常'],
      mealTypes: ['DINNER'],
      mealRoles: ['MAIN'],
      toolIds: [{ toolId: 't1', name: '炒锅' }],
      icon: 'x',
      random: 1
    });
    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/v1/recipes');
    const body = JSON.parse(call?.[1].body);
    expect(body).toMatchObject({
      name: '新菜',
      calories: 520,
      ingredients: [{ ingredientId: 'i1', name: '盐', quantity: 2, unit: 'PIECE', optional: true, isPrimary: true }],
      steps: [{ content: '翻炒', imagePath: '/x' }],
      tags: ['家常'],
      mealTypes: ['DINNER'],
      mealRoles: ['MAIN'],
      toolIds: [{ toolId: 't1', name: '炒锅', required: true }]
    });
    expect(body).not.toHaveProperty('icon');
    expect(body).not.toHaveProperty('random');
    // 越界/非整数热量与非法餐次枚举：快速失败，不再静默丢弃或假称“字段不支持”
    await expect((window as any).BentoService.recipes.save({ name: '坏菜', calories: 30 })).rejects.toMatchObject({
      code: 'RECIPE_CALORIES_INVALID'
    });
    await expect((window as any).BentoService.recipes.save({ name: '坏菜', calories: 520.5 })).rejects.toMatchObject({
      code: 'RECIPE_CALORIES_INVALID'
    });
    await expect(
      (window as any).BentoService.recipes.save({ name: '坏菜', mealTypes: ['夜宵'] })
    ).rejects.toMatchObject({ code: 'RECIPE_MEAL_TYPE_UNSUPPORTED' });
    await expect(
      (window as any).BentoService.recipes.save({ name: '坏菜', mealRoles: ['甜点'] })
    ).rejects.toMatchObject({ code: 'RECIPE_MEAL_ROLE_UNSUPPORTED' });
    await expect(
      (window as any).BentoService.recipes.save({
        name: '坏菜',
        ingredients: [{ name: '盐', quantity: 1, unit: '茶匙' }]
      })
    ).rejects.toMatchObject({ code: 'RECIPE_INGREDIENT_UNIT_UNSUPPORTED' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/v1/recipes')).toHaveLength(1);
  });

  it('legacy recipe form 真实 submit 读取 steps 且保留旧 steps 无行时', async () => {
    document.body.innerHTML = `<form><input id="formRecipeId" value="r1"><input id="formRecipeName" value="新菜"><input id="formRecipeCategory" value="家常"><input id="formRecipeTime" value="20"><input id="formRecipeDifficulty" value="中"><input id="formRecipeCalories" value=""><div id="formRecipeIngList"></div><div id="formRecipeStepList"><div class="recipe-step-row"><input class="recipe-step-title" value="切配"><input class="recipe-step-desc" value="切好"></div></div></form>`;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { id: 'r1', version: 4, ingredients: [], steps: [] } })
    });
    vi.stubGlobal('fetch', fetchMock);
    const modal: any = { open: vi.fn(), close: vi.fn(), handleRecipeFormSubmit: vi.fn() };
    (window as any).BentoModal = modal;
    (window as any).BentoService = {
      stores: { data: [] },
      recipes: {
        data: [
          {
            id: 'r1',
            version: 3,
            ingredients: [{ ingredientId: 'i1', name: '旧', quantity: 1, unit: '个', optional: true, isPrimary: true }],
            steps: [{ content: '旧步骤', imagePath: '/step.jpg' }],
            tags: ['标签'],
            mealTypes: ['晚餐'],
            mealRoles: ['主菜'],
            toolIds: ['t1'],
            imagePath: '/cover.jpg',
            spicyLevel: 2,
            servings: 2,
            sourceNote: '来源',
            notes: '备注',
            enabledForRecommendation: false
          }
        ]
      }
    };
    window.eval(adapter);
    (window as any).BentoService.recipes.data = [
      {
        id: 'r1',
        version: 3,
        ingredients: [{ ingredientId: 'i1', name: '旧', quantity: 1, unit: '个', optional: true, isPrimary: true }],
        steps: [{ content: '旧步骤', imagePath: '/step.jpg' }],
        tags: ['标签'],
        mealTypes: ['晚餐'],
        mealRoles: ['主菜'],
        toolIds: ['t1'],
        imagePath: '/cover.jpg',
        spicyLevel: 2,
        servings: 2,
        sourceNote: '来源',
        notes: '备注',
        enabledForRecommendation: false
      }
    ];
    const button = document.createElement('button');
    document.querySelector('form')!.append(button);
    await modal.handleRecipeFormSubmit({ preventDefault: vi.fn(), submitter: button });
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/v1/recipes/r1');
    const body = JSON.parse(call[1].body);
    // 单位按后端 QuantityUnit 映射；餐次/餐位按后端枚举送；工具按 {toolId,name,required} 送
    expect(body.ingredients).toEqual([
      { ingredientId: 'i1', name: '旧', quantity: 1, unit: 'PIECE', amountText: null, optional: true, isPrimary: true }
    ]);
    expect(body.steps).toEqual([{ content: '切好', title: '切配', timerMinutes: null, imagePath: '/step.jpg' }]);
    expect(body).toMatchObject({
      tags: ['标签'],
      mealTypes: ['DINNER'],
      mealRoles: ['MAIN'],
      toolIds: [{ toolId: null, name: 't1', required: true }],
      imagePath: '/cover.jpg',
      enabledForRecommendation: false,
      // 热量控件为空 = 未填写 → 显式 null（不是缺字段，也不是 320）
      calories: null
    });
    expect(JSON.parse(call[1].body)).toHaveProperty('calories', null);
    const recipeCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/v1/recipes')).length;
    // 3000 超出后端 50..2000 上界：快速失败，不发请求
    (document.querySelector('#formRecipeCalories') as HTMLInputElement).value = '3000';
    await modal.handleRecipeFormSubmit({ preventDefault: vi.fn(), submitter: button });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/v1/recipes')).length).toBe(recipeCalls);

    // 500 在正式范围内：真实送达后端
    (document.querySelector('#formRecipeCalories') as HTMLInputElement).value = '500';
    await modal.handleRecipeFormSubmit({ preventDefault: vi.fn(), submitter: button });
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ calories: 500 });
    expect(button.disabled).toBe(false);
  });

  const okJson = (data: unknown) => ({ ok: true, text: async () => JSON.stringify({ success: true, data }) });

  it('recipe form 用量「2汤匙」「适量」保存原文不降级，DTO 回填不失真（P1-1 回归）', async () => {
    document.body.innerHTML = `<form><input id="formRecipeId" value=""><input id="formRecipeName" value="回归菜"><input id="formRecipeTime" value="20"><input id="formRecipeCalories" value=""><div id="formRecipeIngList"></div><div id="formRecipeStepList"></div></form>`;
    const createdDto = {
      id: 'r9',
      version: 1,
      name: '回归菜',
      ingredients: [
        { id: 'ing1', ingredientNameSnapshot: '酱油', quantity: null, unit: null, amountText: '2汤匙' },
        { id: 'ing2', ingredientNameSnapshot: '盐', quantity: null, unit: null, amountText: '适量' },
        { id: 'ing3', ingredientNameSnapshot: '糖', quantity: 300, unit: 'GRAM', amountText: null }
      ],
      steps: [{ id: 'step1', stepNo: 1, content: '拌匀', title: null }]
    };
    const fetchMock = vi.fn(async (url: any, options?: any) => {
      const method = options?.method || 'GET';
      if (String(url) === '/api/v1/recipes' && method === 'POST') return okJson(createdDto);
      if (String(url) === '/api/v1/recipes/r9' && method === 'PUT') return okJson({ ...createdDto, version: 2 });
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);
    (window as any).BentoModal = { open: vi.fn(), close: vi.fn(), handleRecipeFormSubmit: vi.fn() };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] } };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ingRow = (id: string, name: string, amount: string) =>
      `<div class="recipe-ing-row"${id ? ` data-ingredient-id="${id}"` : ''}><input class="recipe-ing-name" value="${name}"><input class="recipe-ing-amount" value="${amount}"></div>`;
    const stepRow = (id: string, title: string, desc: string) =>
      `<div class="recipe-step-row"${id ? ` data-step-id="${id}"` : ''}><input class="recipe-step-title" value="${title}"><textarea class="recipe-step-desc">${desc}</textarea></div>`;
    document.querySelector('#formRecipeIngList')!.innerHTML = [
      ingRow('', '酱油', '2汤匙'),
      ingRow('', '盐', '适量'),
      ingRow('', '糖', '300g')
    ].join('');
    document.querySelector('#formRecipeStepList')!.innerHTML = stepRow('', '拌', '拌匀');
    const button = document.createElement('button');
    document.querySelector('form')!.append(button);
    await (window as any).BentoModal.handleRecipeFormSubmit({ preventDefault: vi.fn(), submitter: button });

    const postBody = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url) === '/api/v1/recipes')?.[1].body);
    // 「2汤匙」整段语义保留在 amountText，绝不降级成 quantity:2 + unit:null + amountText:null
    expect(postBody.ingredients).toEqual([
      {
        ingredientId: null,
        name: '酱油',
        quantity: null,
        unit: null,
        amountText: '2汤匙',
        optional: false,
        isPrimary: false
      },
      {
        ingredientId: null,
        name: '盐',
        quantity: null,
        unit: null,
        amountText: '适量',
        optional: false,
        isPrimary: false
      },
      {
        ingredientId: null,
        name: '糖',
        quantity: 300,
        unit: 'GRAM',
        amountText: null,
        optional: false,
        isPrimary: false
      }
    ]);

    // 按 DTO 重新打开编辑表单：原文完整回填，而不是只剩「2」或空
    const mapped = (window as any).DafanDomainAdapter.mapRecipe(createdDto);
    expect(mapped.ingredients.map((i: any) => i.amount)).toEqual(['2汤匙', '适量', '300g']);

    (window as any).BentoService.recipes.data = [mapped];
    (document.querySelector('#formRecipeId') as HTMLInputElement).value = 'r9';
    document.querySelector('#formRecipeIngList')!.innerHTML = [
      ingRow('ing1', '酱油', '2汤匙'),
      ingRow('ing2', '盐', '适量'),
      ingRow('ing3', '糖', '300g')
    ].join('');
    document.querySelector('#formRecipeStepList')!.innerHTML = stepRow('step1', '', '拌匀');
    await (window as any).BentoModal.handleRecipeFormSubmit({ preventDefault: vi.fn(), submitter: button });
    const putBody = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url) === '/api/v1/recipes/r9')?.[1].body);
    // 未改动行原样重存：amountText 原文不丢、结构化行不漂移
    expect(putBody.ingredients).toEqual([
      {
        ingredientId: null,
        name: '酱油',
        quantity: null,
        unit: null,
        amountText: '2汤匙',
        optional: false,
        isPrimary: false
      },
      {
        ingredientId: null,
        name: '盐',
        quantity: null,
        unit: null,
        amountText: '适量',
        optional: false,
        isPrimary: false
      },
      {
        ingredientId: null,
        name: '糖',
        quantity: 300,
        unit: 'GRAM',
        amountText: null,
        optional: false,
        isPrimary: false
      }
    ]);
    expect(putBody.steps).toEqual([{ content: '拌匀', title: null, timerMinutes: null, imagePath: null }]);
  });

  it('recipe form 步骤 title/content 独立：连续编辑不累积旧标题（P1-2 回归）', async () => {
    document.body.innerHTML = `<form><input id="formRecipeId" value="r1"><input id="formRecipeName" value="步骤回归"><input id="formRecipeTime" value="20"><input id="formRecipeCalories" value=""><div id="formRecipeIngList"></div><div id="formRecipeStepList"></div></form>`;
    const stepDto = { id: 's1', stepNo: 1, content: 'add water', title: 'stir' };
    const fetchMock = vi.fn(async (url: any, options?: any) => {
      if (String(url) === '/api/v1/recipes/r1' && options?.method === 'PUT')
        return okJson({ id: 'r1', version: 9, name: '步骤回归', ingredients: [], steps: [stepDto] });
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);
    (window as any).BentoModal = { open: vi.fn(), close: vi.fn(), handleRecipeFormSubmit: vi.fn() };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] } };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    (window as any).BentoService.recipes.data = [
      (window as any).DafanDomainAdapter.mapRecipe({
        id: 'r1',
        version: 1,
        name: '步骤回归',
        ingredients: [],
        steps: [stepDto]
      })
    ];
    const stepRow = (title: string, desc: string) =>
      `<div class="recipe-step-row" data-step-id="s1"><input class="recipe-step-title" value="${title}"><textarea class="recipe-step-desc">${desc}</textarea></div>`;
    document.querySelector('#formRecipeStepList')!.innerHTML = stepRow('stir', 'add water');
    const button = document.createElement('button');
    document.querySelector('form')!.append(button);
    const submit = () =>
      (window as any).BentoModal.handleRecipeFormSubmit({ preventDefault: vi.fn(), submitter: button });
    const stepBodies = () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url) === '/api/v1/recipes/r1')
        .map(([, options]) => JSON.parse(options.body).steps);

    await submit();
    // 未改动行沿用后端既有 content，不重写
    expect(stepBodies()[0]).toEqual([{ content: 'add water', title: 'stir', timerMinutes: null, imagePath: null }]);
    document.querySelector('.recipe-step-title')!.value = 'mix';
    await submit();
    // 改标题只改 title：正文不出现「mix：」前缀，也不累积旧标题
    expect(stepBodies()[1]).toEqual([{ content: 'add water', title: 'mix', timerMinutes: null, imagePath: null }]);
    document.querySelector('.recipe-step-desc')!.textContent = 'boil water';
    await submit();
    expect(stepBodies()[2]).toEqual([{ content: 'boil water', title: 'mix', timerMinutes: null, imagePath: null }]);
  });

  it('recipe form 新建步骤正文不拼标题，只有标题没有正文时显式失败不静默丢行（P1-2 回归）', async () => {
    document.body.innerHTML = `<form><input id="formRecipeId" value=""><input id="formRecipeName" value="新菜"><input id="formRecipeTime" value="20"><input id="formRecipeCalories" value=""><div id="formRecipeIngList"></div><div id="formRecipeStepList"></div></form>`;
    const fetchMock = vi.fn(async () => okJson({ id: 'r2', version: 1, name: '新菜', ingredients: [], steps: [] }));
    vi.stubGlobal('fetch', fetchMock);
    (window as any).BentoModal = { open: vi.fn(), close: vi.fn(), handleRecipeFormSubmit: vi.fn() };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] } };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector('#formRecipeStepList')!.innerHTML =
      '<div class="recipe-step-row"><input class="recipe-step-title" value="stir"><textarea class="recipe-step-desc">add water</textarea></div>';
    const button = document.createElement('button');
    document.querySelector('form')!.append(button);
    await (window as any).BentoModal.handleRecipeFormSubmit({ preventDefault: vi.fn(), submitter: button });
    const postBody = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url) === '/api/v1/recipes')?.[1].body);
    // 正文就是做法本身：不拼「stir：」前缀
    expect(postBody.steps).toEqual([{ content: 'add water', title: 'stir', timerMinutes: null, imagePath: null }]);

    // 只有标题没有正文：行保留、save 显式失败（不发请求、不静默丢步骤、不拿标题冒充正文）
    const postCount = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/v1/recipes').length;
    document.querySelector('.recipe-step-desc')!.textContent = '';
    await (window as any).BentoModal.handleRecipeFormSubmit({ preventDefault: vi.fn(), submitter: button });
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/v1/recipes').length).toBe(postCount);
    await expect(
      (window as any).BentoService.recipes.save({ name: '坏菜', steps: [{ title: '只有标题' }] })
    ).rejects.toMatchObject({ code: 'RECIPE_STEP_CONTENT_UNSUPPORTED' });
  });

  it('stores menuItems 现在纳入请求并按顺序保存', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store: any = { data: [{ id: 's1' }] };
    (window as any).BentoService = { stores: store, recipes: { data: [] } };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    store.data = [{ id: 's1' }];
    (window as any).DafanDomainAdapter.replaceStoreService(store);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          success: true,
          data: { id: 's2', name: '店', version: 1, menuItems: [{ id: 'm1', name: '菜', price: 0, sortOrder: 0 }] }
        })
    });
    await store.save({ name: '店', menuItems: [{ name: '菜', price: null, isSignature: false }] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).menuItems).toEqual([
      { name: '菜', price: null, icon: null, desc: null, isSignature: false, sortOrder: 0 }
    ]);
  });

  it('submit guard pending 时只执行一次并在失败后恢复按钮', async () => {
    const button = document.createElement('button');
    const event: any = { submitter: button };
    let reject!: (error: Error) => void;
    const task = () =>
      new Promise((_, r) => {
        reject = r;
      });
    const guard = (window as any).DafanDomainAdapter.withSubmitGuard;
    const first = guard(event, task);
    await Promise.resolve();
    const second = guard(event, vi.fn());
    expect(second).toBe(first);
    expect(button.disabled).toBe(true);
    reject(new Error('fail'));
    await expect(first).rejects.toThrow('fail');
    expect(button.disabled).toBe(false);
    expect(button.dataset.submitting).toBe('false');
  });

  it('stores 详情回填 cache 后 update/delete 使用最新 version', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store: any = { data: [] };
    (window as any).BentoService = { stores: store, recipes: { data: [] } };
    (window as any).BentoModal = { close: vi.fn() };
    window.eval(adapter);
    (window as any).DafanDomainAdapter.replaceStoreService(store);
    const service = store;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { id: 's1', name: '详情', version: 8 } })
    });
    await service.getByIdRemote('s1');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { id: 's1', name: '更新', version: 9 } })
    });
    await store.save({ ...store.getById('s1'), name: '更新' });
    expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body).version).toBe(8);
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ success: true, data: {} }) });
    await store.delete('s1');
    expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body)).toEqual({ version: 9 });
  });

  it('recipes 详情回填后 update/favorite 使用最新 version', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const recipe: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: recipe };
    (window as any).BentoModal = { close: vi.fn() };
    window.eval(adapter);
    (window as any).DafanDomainAdapter.replaceRecipeService(recipe);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({ success: true, data: { id: 'r1', name: '详情', version: 12, ingredients: [], steps: [] } })
    });
    await recipe.getByIdRemote('r1');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { id: 'r1', version: 13, ingredients: [], steps: [] } })
    });
    await recipe.save({ ...recipe.getById('r1'), name: '更新' });
    expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body).version).toBe(12);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({ success: true, data: { id: 'r1', version: 14, favorite: true, ingredients: [], steps: [] } })
    });
    await recipe.toggleFavorite('r1');
    expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body).version).toBe(13);
  });

  it('API 空 body、409、503 均转为带状态码的 ApiError，并保留 PIN header', async () => {
    localStorage.setItem('dafan-pin-token', 'pin');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, text: async () => '' })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ success: false, error: { code: 'MAINTENANCE', message: '维护中' } })
      });
    vi.stubGlobal('fetch', fetchMock);
    await expect((window as any).DafanApiClient.request('/settings')).rejects.toMatchObject({
      status: 409,
      code: 'HTTP_ERROR'
    });
    await expect((window as any).DafanApiClient.request('/settings')).rejects.toMatchObject({
      status: 503,
      code: 'MAINTENANCE'
    });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'X-App-Pin-Token': 'pin' });
  });

  it('submit guard 成功路径在 pending 期间只执行一次并恢复按钮状态', async () => {
    const button = document.createElement('button');
    const event: any = { submitter: button };
    let resolveTask!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolveTask = resolve;
    });
    const task = vi.fn(() => pending);
    const guard = (window as any).DafanDomainAdapter.withSubmitGuard;
    const first = guard(event, task);
    const second = guard(event, vi.fn());
    expect(button.disabled).toBe(true);
    expect(button.dataset.submitting).toBe('true');
    expect(second).toBe(first);
    resolveTask('ok');
    await expect(first).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(false);
    expect(button.dataset.submitting).toBe('false');
  });

  it.each([
    {
      status: 400,
      code: 'VALIDATION_ERROR',
      domain: 'stores',
      method: 'save',
      input: { name: '新店', address: '新地址' },
      response: { id: 'new-store', name: '新店', version: 2 },
      expectedMethod: 'POST',
      expectedPath: '/api/v1/stores'
    },
    {
      status: 404,
      code: 'STORE_NOT_FOUND',
      domain: 'stores',
      method: 'delete',
      input: 's-old',
      response: null,
      expectedMethod: 'DELETE',
      expectedPath: '/api/v1/stores/s-old'
    },
    {
      status: 409,
      code: 'VERSION_CONFLICT',
      domain: 'recipes',
      method: 'save',
      input: { id: 'r-old', name: '改菜', version: 7, ingredients: [], steps: [] },
      response: null,
      expectedMethod: 'PUT',
      expectedPath: '/api/v1/recipes/r-old'
    },
    {
      status: 503,
      code: 'MAINTENANCE',
      domain: 'recipes',
      method: 'toggleFavorite',
      input: 'r-old',
      response: null,
      expectedMethod: 'POST',
      expectedPath: '/api/v1/recipes/r-old/favorite'
    }
  ])('%s %s 写失败传播状态并保持 service 与 modal 不变', async (caseData) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: { items: [], totalPages: 1 } })
    });
    const toast = vi.fn();
    const close = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    (window as any).showToast = toast;
    (window as any).BentoModal = { close };
    const stores: any = { data: [{ id: 's-old', name: '旧店', version: 3 }] };
    const recipes: any = {
      data: [{ id: 'r-old', name: '旧菜', version: 7, favorite: false, ingredients: [], steps: [] }]
    };
    (window as any).BentoService = { stores, recipes };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockClear();
    stores.data = [{ id: 's-old', name: '旧店', version: 3 }];
    recipes.data = [{ id: 'r-old', name: '旧菜', version: 7, favorite: false, ingredients: [], steps: [] }];
    const service = caseData.domain === 'stores' ? stores : recipes;
    (window as any).DafanDomainAdapter[caseData.domain === 'stores' ? 'replaceStoreService' : 'replaceRecipeService'](
      service
    );
    const before = structuredClone(service.data);
    const beforeVersion = service.data[0].version;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: caseData.status,
      text: async () => JSON.stringify({ success: false, error: { code: caseData.code, message: '写入失败' } })
    });

    await expect(service[caseData.method](caseData.input)).rejects.toMatchObject({
      status: caseData.status,
      code: caseData.code
    });
    expect(service.data).toEqual(before);
    expect(service.data[0].version).toBe(beforeVersion);
    expect(close).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(caseData.expectedPath);
    expect(fetchMock.mock.calls[0][1].method).toBe(caseData.expectedMethod);
  });

  it('stores 四类写操作发送精确请求并串联服务端 version', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('dafan-pin-token', 'pin');
    const stores: any = { data: [{ id: '旧店', name: '旧', version: 1, favorite: false }] };
    (window as any).BentoService = { stores, recipes: { data: [] } };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockClear();
    stores.data = [{ id: '旧店', name: '旧', version: 1, favorite: false }];
    (window as any).DafanDomainAdapter.replaceStoreService(stores);
    const json = (data: any) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, data }) });

    fetchMock.mockResolvedValueOnce(json({ id: 's/1', name: '店', version: 2 }));
    await stores.save({
      name: '店',
      address: '街',
      storeType: '小馆',
      cuisine: '中餐',
      averageCost: 30,
      supportsDineIn: true,
      supportsTakeout: false,
      contact: '123',
      businessHours: '10-20',
      rating: 4.5,
      recommendedDishes: '面',
      notes: '好',
      favorite: false,
      id: undefined,
      version: 99,
      icon: 'x',
      menuItems: [],
      random: 1,
      date: 'today'
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/stores');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-App-Pin-Token': 'pin'
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: '店',
      address: '街',
      storeType: '小馆',
      cuisine: '中餐',
      averageCost: 30,
      supportsDineIn: true,
      supportsTakeout: false,
      contact: '123',
      businessHours: '10-20',
      rating: 4.5,
      recommendedDishes: '面',
      notes: '好',
      favorite: false,
      menuItems: []
    });

    fetchMock.mockResolvedValueOnce(json({ id: 's/1', name: '店改', version: 3 }));
    await stores.save({ id: 's/1', version: 2, name: '店改' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/stores/s%2F1');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ name: '店改', version: 2 });

    fetchMock.mockResolvedValueOnce(json({}));
    await stores.delete('s/1');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/stores/s%2F1');
    expect(fetchMock.mock.calls[2][1].method).toBe('DELETE');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ version: 3 });

    stores.data = [{ id: 's/1', name: '店改', version: 4, favorite: false }];
    fetchMock.mockResolvedValueOnce(json({ id: 's/1', name: '店改', version: 5, favorite: true }));
    await stores.toggleFavorite('s/1');
    expect(fetchMock.mock.calls[3][0]).toBe('/api/v1/stores/s%2F1/favorite');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ favorite: true, version: 4 });
  });

  it('recipes 四类写操作发送精确请求、串联 version，delete 不带 body/content type', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('dafan-pin-token', 'pin');
    const recipes: any = {
      data: [{ id: 'r/1', name: '旧菜', version: 1, favorite: false, ingredients: [], steps: [] }]
    };
    (window as any).BentoService = { stores: { data: [] }, recipes };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockClear();
    recipes.data = [{ id: 'r/1', name: '旧菜', version: 1, favorite: false, ingredients: [], steps: [] }];
    (window as any).DafanDomainAdapter.replaceRecipeService(recipes);
    const json = (data: any) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, data }) });

    fetchMock.mockResolvedValueOnce(json({ id: 'r/1', name: '新菜', version: 2, ingredients: [], steps: [] }));
    await recipes.save({
      name: '新菜',
      ingredients: [],
      steps: [],
      id: undefined,
      version: 99,
      icon: 'x',
      calories: undefined,
      random: 1,
      date: 'today'
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/recipes');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    const createBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(createBody).not.toHaveProperty('id');
    expect(createBody).not.toHaveProperty('version');
    expect(createBody).not.toHaveProperty('icon');
    expect(createBody).not.toHaveProperty('random');
    expect(createBody).not.toHaveProperty('date');

    fetchMock.mockResolvedValueOnce(json({ id: 'r/1', name: '改菜', version: 3, ingredients: [], steps: [] }));
    await recipes.save({ id: 'r/1', version: 2, name: '改菜', ingredients: [], steps: [] });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/recipes/r%2F1');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ version: 2 });

    fetchMock.mockResolvedValueOnce(json({ id: 'r/1', version: 4, favorite: true, ingredients: [], steps: [] }));
    await recipes.toggleFavorite('r/1');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/recipes/r%2F1/favorite');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ favorite: true, version: 3 });

    recipes.data = [{ id: 'r/1', version: 4, ingredients: [], steps: [] }];
    fetchMock.mockResolvedValueOnce(json({}));
    await recipes.delete('r/1');
    const deleteCall = fetchMock.mock.calls[3];
    expect(deleteCall[0]).toBe('/api/v1/recipes/r%2F1?version=4');
    expect(deleteCall[1].method).toBe('DELETE');
    expect(deleteCall[1].body).toBeUndefined();
    expect(deleteCall[1].headers).toMatchObject({ 'X-App-Pin-Token': 'pin' });
    expect(deleteCall[1].headers).not.toHaveProperty('Content-Type');
  });

  it('stores 与 recipes 详情请求对含空格和斜杠的 id 使用 encodeURIComponent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { id: 'a b/c', version: 2, ingredients: [], steps: [] } })
    });
    vi.stubGlobal('fetch', fetchMock);
    const stores: any = { data: [] },
      recipes: any = { data: [] };
    (window as any).BentoService = { stores, recipes };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockClear();
    (window as any).DafanDomainAdapter.replaceStoreService(stores);
    (window as any).DafanDomainAdapter.replaceRecipeService(recipes);
    await stores.getByIdRemote('a b/c');
    await recipes.getByIdRemote('a b/c');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/stores/a%20b%2Fc');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/recipes/a%20b%2Fc');
  });

  it('stores reload 旧多页响应不能覆盖后发的新响应', async () => {
    const old1 = deferred<any>();
    const old2 = deferred<any>();
    const fresh = deferred<any>();
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('page=1') && fetchMock.mock.calls.length === 1) return old1.promise;
      if (String(url).includes('page=2')) return old2.promise;
      return fresh.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    const service: any = { data: [] };
    (window as any).BentoService = { stores: service, recipes: { data: [] } };
    window.eval(adapter);
    const reload = (window as any).DafanDomainAdapter.replaceStoreService(service);
    const first = reload();
    await Promise.resolve();
    const second = reload();
    fresh.resolve({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { items: [{ id: 'new', version: 2 }], totalPages: 1 } })
    });
    await second;
    old1.resolve({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { items: [{ id: 'old' }], totalPages: 2 } })
    });
    old2.resolve({ ok: true, text: async () => JSON.stringify({ success: true, data: { items: [{ id: 'old-2' }] } }) });
    await first;
    expect(service.data).toMatchObject([{ id: 'new', version: 2 }]);
  });

  it('recipes reload 旧多页响应不能覆盖后发的新响应', async () => {
    const old1 = deferred<any>();
    const old2 = deferred<any>();
    const fresh = deferred<any>();
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('page=1') && fetchMock.mock.calls.length === 1) return old1.promise;
      if (String(url).includes('page=2')) return old2.promise;
      return fresh.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    const service: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: service };
    window.eval(adapter);
    const reload = (window as any).DafanDomainAdapter.replaceRecipeService(service);
    const first = reload();
    await Promise.resolve();
    const second = reload();
    fresh.resolve({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { items: [{ id: 'new', version: 2 }], totalPages: 1 } })
    });
    await second;
    old1.resolve({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { items: [{ id: 'old' }], totalPages: 2 } })
    });
    old2.resolve({ ok: true, text: async () => JSON.stringify({ success: true, data: { items: [{ id: 'old-2' }] } }) });
    await first;
    expect(service.data).toMatchObject([{ id: 'new', version: 2 }]);
  });

  it.each(['cookCheckin'])('%s gap 统一 error、无请求和数据副作用', async (method) => {
    const toast = vi.fn();
    (window as any).showToast = toast;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service: any = { data: [{ id: 'r1', version: 2, ingredients: [], steps: [] }] };
    (window as any).BentoService = { stores: { data: [] }, recipes: service };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockClear();
    (window as any).DafanDomainAdapter.replaceRecipeService(service);
    const before = structuredClone(service.data);
    expect(await service[method]({})).toBe(false);
    expect(toast).toHaveBeenCalledWith('菜谱不存在', 'error');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/v1/recipes'))).toHaveLength(0);
    expect(service.data).toEqual(before);
  });

  function localDateKey(daysFromToday: number): string {
    const date = new Date();
    date.setDate(date.getDate() + daysFromToday);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  it('pantry reload 分页聚合、DTO 映射与 pantry:changed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            success: true,
            data: {
              items: [
                {
                  id: 'i1',
                  name: '生菜',
                  quantity: 2,
                  unit: 'PIECE',
                  location: '冷藏室',
                  expiryDate: localDateKey(3),
                  purchaseDate: localDateKey(-1),
                  version: 4
                }
              ],
              totalPages: 2
            }
          })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            success: true,
            data: { items: [{ id: 'i2', name: '盐', quantity: 500, unit: 'GRAM', location: null, version: 1 }] }
          })
      });
    vi.stubGlobal('fetch', fetchMock);
    const changed = vi.fn();
    (window as any).BentoBus = { emit: changed };
    const pantry: any = { data: [{ id: 'old' }] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, pantry };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            success: true,
            data: {
              items: [
                {
                  id: 'i1',
                  name: '生菜',
                  quantity: 2,
                  unit: 'PIECE',
                  location: '冷藏室',
                  expiryDate: localDateKey(3),
                  purchaseDate: localDateKey(-1),
                  version: 4
                }
              ],
              totalPages: 2
            }
          })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            success: true,
            data: { items: [{ id: 'i2', name: '盐', quantity: 500, unit: 'GRAM', location: null, version: 1 }] }
          })
      });
    const reload = (window as any).DafanDomainAdapter.replacePantryService(pantry);
    await reload();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/ingredients?page=1&pageSize=100',
      '/api/v1/ingredients?page=2&pageSize=100'
    ]);
    expect(pantry.data).toHaveLength(2);
    expect(pantry.data[0]).toMatchObject({
      id: 'i1',
      name: '生菜',
      stock: 2,
      unit: '个',
      unitKey: 'PIECE',
      storageLocation: '冷藏室',
      expireDate: localDateKey(3),
      expireDaysLeft: 3,
      purchaseDate: localDateKey(-1),
      version: 4
    });
    expect(pantry.data[1]).toMatchObject({
      id: 'i2',
      stock: 500,
      unit: 'g',
      storageLocation: '',
      expireDaysLeft: undefined
    });
    expect(changed).toHaveBeenCalledWith('pantry:changed');
  });

  it('pantry 空分页清除旧列表并发出 pantry:changed', async () => {
    const changed = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { items: [], totalPages: 1 } })
    });
    vi.stubGlobal('fetch', fetchMock);
    (window as any).BentoBus = { emit: changed };
    const pantry: any = { data: [{ id: 'old' }] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, pantry };
    window.eval(adapter);
    await (window as any).DafanDomainAdapter.replacePantryService(pantry)();
    expect(pantry.data).toEqual([]);
    expect(changed).toHaveBeenCalledWith('pantry:changed');
  });

  it('pantry 四类写操作发送精确请求并串联服务端 version', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('dafan-pin-token', 'pin');
    const pantry: any = { data: [{ id: 'i/1', name: '旧菜', version: 1, unit: '个', unitKey: 'PIECE' }] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, pantry };
    (window as any).BentoModal = { close: vi.fn() };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockClear();
    pantry.data = [{ id: 'i/1', name: '旧菜', version: 1, unit: '个', unitKey: 'PIECE' }];
    (window as any).DafanDomainAdapter.replacePantryService(pantry);
    const json = (data: any) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, data }) });

    fetchMock.mockResolvedValueOnce(json({ id: 'i1', name: '生菜', quantity: 500, unit: 'GRAM', location: '冷藏室' }));
    await pantry.save({
      name: '生菜',
      category: '蔬菜',
      storageLocation: '冷藏室',
      stock: 500,
      unit: 'g',
      expireDaysLeft: 5,
      id: undefined,
      version: 99,
      icon: 'x',
      random: 1,
      date: 'today'
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/ingredients');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-App-Pin-Token': 'pin'
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: '生菜',
      imagePath: null,
      category: '蔬菜',
      unit: 'GRAM',
      minStock: null,
      maxStock: null,
      notes: null,
      batches: [
        {
          quantity: 500,
          unit: 'GRAM',
          purchaseDate: null,
          expiryDate: localDateKey(5),
          location: '冷藏室',
          opened: false,
          consumePriority: false,
          notes: null
        }
      ]
    });
    expect(pantry.data[0]).toMatchObject({
      id: 'i1',
      stock: 500,
      unit: 'g',
      unitKey: 'GRAM',
      storageLocation: '冷藏室'
    });
    expect((window as any).BentoModal.close).toHaveBeenCalledWith(true);

    fetchMock.mockResolvedValueOnce(json({ id: 'i/1', name: '改菜', quantity: 3, unit: 'PIECE', version: 2 }));
    await pantry.save({ id: 'i/1', version: 1, name: '改菜', category: '蔬菜', unit: '个', unitKey: 'PIECE' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/ingredients/i%2F1');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      name: '改菜',
      category: '蔬菜',
      unit: 'PIECE',
      version: 1
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('batches');

    pantry.data = [{ id: 'i/1', name: '改菜', quantity: 3, unit: '个', unitKey: 'PIECE', version: 2 }];
    fetchMock.mockResolvedValueOnce(json({}));
    await pantry.delete('i/1');
    const deleteCall = fetchMock.mock.calls[2];
    expect(deleteCall[0]).toBe('/api/v1/ingredients/i%2F1?version=2');
    expect(deleteCall[1].method).toBe('DELETE');
    expect(deleteCall[1].body).toBeUndefined();
    expect(deleteCall[1].headers).toMatchObject({ 'X-App-Pin-Token': 'pin' });
    expect(deleteCall[1].headers).not.toHaveProperty('Content-Type');
    expect(pantry.data).toEqual([]);
  });

  it('pantry 编辑：批次字段可提交，非法批次/未知单位快速失败且不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const pantry: any = { data: [{ id: 'i1', name: '旧', version: 2, location: '冷藏室' }] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, pantry };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockClear();
    (window as any).DafanDomainAdapter.replacePantryService(pantry);
    const before = structuredClone(pantry.data);
    // 后端 Ingredient PUT 已支持 batches（无 migration），但批次缺少单位必须 fail-closed
    await expect(
      pantry.save({ id: 'i1', version: 2, name: '改', unit: '个', unitKey: 'PIECE', batches: [{ quantity: 1 }] })
    ).rejects.toMatchObject({ code: 'INGREDIENT_BATCH_INVALID' });
    await expect(pantry.save({ name: '新', unit: '斗' })).rejects.toMatchObject({
      code: 'INGREDIENT_UNIT_UNSUPPORTED'
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pantry.data).toEqual(before);
  });

  it('pantry 写失败传播状态并保持 service 与 modal 不变', async () => {
    const toast = vi.fn();
    const close = vi.fn();
    const fetchMock = vi.fn() as any;
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { items: [], totalPages: 1 } })
    });
    vi.stubGlobal('fetch', fetchMock);
    (window as any).showToast = toast;
    (window as any).BentoModal = { close };
    const pantry: any = { data: [{ id: 'i-old', name: '旧菜', version: 3, unit: '个', unitKey: 'PIECE' }] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, pantry };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockClear();
    pantry.data = [{ id: 'i-old', name: '旧菜', version: 3, unit: '个', unitKey: 'PIECE' }];
    (window as any).DafanDomainAdapter.replacePantryService(pantry);
    const cases = [
      {
        status: 400,
        code: 'VALIDATION_ERROR',
        method: 'save',
        input: { name: '新菜', unit: 'g', stock: 500 },
        expectedMethod: 'POST',
        expectedPath: '/api/v1/ingredients'
      },
      {
        status: 404,
        code: 'INGREDIENT_NOT_FOUND',
        method: 'delete',
        input: 'i-old',
        expectedMethod: 'DELETE',
        expectedPath: '/api/v1/ingredients/i-old?version=3'
      },
      {
        status: 409,
        code: 'VERSION_CONFLICT',
        method: 'save',
        input: { id: 'i-old', version: 3, name: '改菜', unit: '个', unitKey: 'PIECE' },
        expectedMethod: 'PUT',
        expectedPath: '/api/v1/ingredients/i-old'
      },
      {
        status: 503,
        code: 'MAINTENANCE',
        method: 'getByIdRemote',
        input: 'i-old',
        expectedMethod: 'GET',
        expectedPath: '/api/v1/ingredients/i-old'
      }
    ];
    for (const caseData of cases) {
      const before = structuredClone(pantry.data);
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: caseData.status,
        text: async () => JSON.stringify({ success: false, error: { code: caseData.code, message: '写入失败' } })
      });
      await expect(pantry[caseData.method](caseData.input)).rejects.toMatchObject({
        status: caseData.status,
        code: caseData.code
      });
      expect(pantry.data).toEqual(before);
      expect(close).not.toHaveBeenCalled();
      expect(toast).not.toHaveBeenCalled();
      const call = fetchMock.mock.calls.at(-1);
      expect(call[0]).toBe(caseData.expectedPath);
      expect(call[1].method ?? 'GET').toBe(caseData.expectedMethod);
    }
  });

  it.each(['consume'])('pantry %s gap 统一 error、无请求和数据副作用', async (method) => {
    const toast = vi.fn();
    (window as any).showToast = toast;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const pantry: any = { data: [{ id: 'i1', version: 2 }] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, pantry };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockClear();
    (window as any).DafanDomainAdapter.replacePantryService(pantry);
    const before = structuredClone(pantry.data);
    expect(pantry[method]('i1', 100)).toBe(false);
    expect(toast).toHaveBeenCalledWith('食材版本已失效，请刷新后重试', 'error');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pantry.data).toEqual(before);
  });

  it('legacy 食材表单真实 submit 映射表单字段并恢复提交按钮', async () => {
    document.body.innerHTML = `<form><input id="formIngName" value="鸡腿肉"><select id="formIngCategory"><option selected>肉禽</option></select><select id="formIngLocation"><option selected>冷冻室</option></select><input id="formIngStockNum" value="600"><select id="formIngStockUnit"><option selected value="g">克 (g)</option></select><input id="formIngExpireDays" value="4"></form>`;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({ success: true, data: { id: 'i9', name: '鸡腿肉', quantity: 600, unit: 'GRAM', version: 1 } })
    });
    vi.stubGlobal('fetch', fetchMock);
    const close = vi.fn();
    const modal: any = { open: vi.fn(), close, handleIngredientFormSubmit: vi.fn() };
    (window as any).BentoModal = modal;
    (window as any).BentoService = {
      stores: { data: [] },
      recipes: { data: [] },
      pantry: { data: [{ id: 'i1', name: '生菜', version: 1 }] }
    };
    window.eval(adapter);
    const button = document.createElement('button');
    document.querySelector('form')!.append(button);
    await modal.handleIngredientFormSubmit({ preventDefault: vi.fn(), submitter: button });
    const submitCall = fetchMock.mock.calls.find(([url]) => url === '/api/v1/ingredients')!;
    expect(submitCall[1].method).toBe('POST');
    expect(JSON.parse(submitCall[1].body)).toMatchObject({
      name: '鸡腿肉',
      category: '肉禽',
      unit: 'GRAM',
      batches: [{ quantity: 600, unit: 'GRAM', expiryDate: localDateKey(4), location: '冷冻室' }]
    });
    expect(close).toHaveBeenCalledWith(true);
    expect(button.disabled).toBe(false);
    expect((window as any).BentoService.pantry.data[0]).toMatchObject({ id: 'i9', stock: 600, unitKey: 'GRAM' });
  });

  it('ingredientDetail 打开前回拉最新 DTO，失败则不打开', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const originalOpen = vi.fn();
    const modal: any = { open: originalOpen };
    (window as any).BentoModal = modal;
    (window as any).showToast = vi.fn();
    const pantry: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, pantry };
    window.eval(adapter);
    (window as any).DafanDomainAdapter.replacePantryService(pantry);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          success: true,
          data: { id: 'i1', name: '生菜', quantity: 2, unit: 'PIECE', expiryDate: localDateKey(2), version: 6 }
        })
    });
    await modal.open('ingredientDetail', 'i1');
    expect(fetchMock.mock.calls.find(([url]) => url === '/api/v1/ingredients/i1')).toBeTruthy();
    expect(originalOpen).toHaveBeenCalledWith('ingredientDetail', pantry.getById('i1'));
    expect(pantry.getById('i1')).toMatchObject({ stock: 2, expireDaysLeft: 2 });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({ success: false, error: { code: 'INGREDIENT_NOT_FOUND', message: '食材不存在' } })
    });
    await modal.open('ingredientDetail', 'i1');
    expect((window as any).showToast).toHaveBeenCalledWith('食材不存在', 'error');
    expect(originalOpen).toHaveBeenCalledTimes(1);
  });

  const shoppingListDto = (version: number, items: unknown[]) => ({
    id: 'sl1',
    name: '购物补货清单',
    status: 'ACTIVE',
    version,
    items
  });
  const shoppingItemDto = (overrides: Record<string, unknown> = {}) => ({
    id: 'it1',
    ingredientNameSnapshot: '小葱',
    quantity: 2,
    unit: 'PIECE',
    sourceType: 'MANUAL',
    completed: false,
    ...overrides
  });
  const shoppingJson = (data: unknown) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ success: true, data })
  });

  const pendingCheckinKey = 'dafan-shopping-checkin-pending';
  const errorJson = (status: number, code: string, message: string) => ({
    ok: false,
    status,
    text: async () => JSON.stringify({ success: false, error: { code, message } })
  });
  const readPendingRecord = () => {
    const raw = localStorage.getItem(pendingCheckinKey);
    return raw === null ? null : JSON.parse(raw);
  };
  /**
   * 替换整个 localStorage：单个方法覆写（defineProperty 到 Storage 实例）在 jsdom 下不生效。
   * 委托目标固定为模块加载时捕获的真实 Storage，避免二次 stub 时把 stub 当真实实现递归委托。
   */
  const nativeStorage = window.localStorage;
  const stubStorage = (overrides: Partial<Storage>) => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => nativeStorage.getItem(key),
      setItem: (key: string, value: string) => nativeStorage.setItem(key, value),
      removeItem: (key: string) => nativeStorage.removeItem(key),
      clear: () => nativeStorage.clear(),
      key: (index: number) => nativeStorage.key(index),
      get length() {
        return nativeStorage.length;
      },
      ...overrides
    } as Storage);
  };

  /**
   * 严格路由 mock：命中 exact URL 才响应，未声明的请求直接失败，
   * 避免“额外请求被宽容 mock 吞掉”造成的假通过。
   */
  const routeFetch = (routes: Record<string, unknown | ((init: any) => unknown)>) =>
    vi.fn((url: string, init: any) => {
      const route = routes[String(url)];
      if (route === undefined) return Promise.reject(new Error(`未预期的请求：${url}`));
      const value = typeof route === 'function' ? (route as (init: any) => unknown)(init) : route;
      return Promise.resolve(value);
    });

  /**
   * boot 阶段用宽容 mock（每个域都会 reload），boot 完成后换成调用方给出的严格路由，
   * 于是“入库流程里到底发了哪些请求”是被真实断言的。
   */
  const bootShopping = async (
    activeDto: unknown,
    operationRoutes: Record<string, unknown | ((init: any) => unknown)>,
    services: Record<string, unknown> = {}
  ) => {
    // 补量弹窗由 HTML 提供；每个用例默认按“未提供”启动，避免上一个用例的 stub 泄漏
    delete (window as any).openShoppingCheckinPrompt;
    delete (window as any).closeShoppingCheckinPrompt;
    const fetchMock = vi.fn() as any;
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('/shopping-lists?status=ACTIVE')
        ? Promise.resolve(shoppingJson([activeDto]))
        : Promise.resolve(arrayJson([]))
    );
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    (window as any).BentoBus = { emit: vi.fn() };
    const shopping: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, shopping, ...services };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    // 绑定阶段强制返回 activeDto，保证 service.data 来自声明的 active 清单
    fetchMock.mockImplementation(
      routeFetch({ ...operationRoutes, '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([activeDto]) })
    );
    await (window as any).DafanDomainAdapter.replaceShoppingService(shopping)();
    // 入库阶段换成调用方声明的严格路由：多一个请求都会直接失败，不做宽容兜底
    fetchMock.mockImplementation(routeFetch(operationRoutes));
    fetchMock.mockClear();
    return { fetchMock, toast, shopping };
  };

  it('shopping reload 绑定 ACTIVE 清单并映射 DTO，单请求不分页', async () => {
    const loadedItems = [
      shoppingItemDto({ id: 'it1' }),
      shoppingItemDto({
        id: 'it2',
        ingredientNameSnapshot: '牛奶',
        quantity: 1.5,
        unit: 'LITER',
        sourceType: 'LOW_STOCK',
        ingredientId: 'ing-9',
        completed: true
      })
    ];
    const fetchMock = vi.fn().mockResolvedValue(shoppingJson([shoppingListDto(3, loadedItems)]));
    vi.stubGlobal('fetch', fetchMock);
    const changed = vi.fn();
    (window as any).BentoBus = { emit: changed };
    const shopping: any = { data: [{ id: 'old' }] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, shopping };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(shoppingJson([shoppingListDto(3, loadedItems)]));
    await (window as any).DafanDomainAdapter.replaceShoppingService(shopping)();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/shopping-lists?status=ACTIVE']);
    expect(shopping.data).toEqual([
      expect.objectContaining({
        id: 'it1',
        name: '小葱',
        amount: '2个',
        unit: '个',
        unitKey: 'PIECE',
        isChecked: false,
        source: '手动备忘',
        category: '调味'
      }),
      expect.objectContaining({
        id: 'it2',
        name: '牛奶',
        amount: '1.5L',
        unit: 'L',
        unitKey: 'LITER',
        isChecked: true,
        source: '库存预警'
      })
    ]);
    expect(changed).toHaveBeenCalledWith('shopping:changed');
  });

  it('shopping 无 ACTIVE 清单时以固定名称自动创建，请求体无本地 id/date', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (String(url) === '/api/v1/shopping-lists')
        return Promise.resolve(shoppingJson(shoppingListDto(1, [shoppingItemDto({ id: 'it-new' })])));
      return Promise.resolve(shoppingJson([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const shopping: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, shopping };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/v1/shopping-lists?status=ACTIVE')).toHaveLength(1);
    const createCall = fetchMock.mock.calls.find(([url]) => url === '/api/v1/shopping-lists');
    expect(createCall?.[1].method).toBe('POST');
    expect(JSON.parse(createCall?.[1].body)).toEqual({ name: '购物补货清单' });
    expect(shopping.data.map((x: any) => x.id)).toEqual(['it-new']);
  });

  it('shopping reload 旧响应不能覆盖后发的新响应', async () => {
    const stale = deferred<any>();
    const fresh = deferred<any>();
    const fetchMock = vi.fn((_url: string) => (fetchMock.mock.calls.length === 1 ? stale.promise : fresh.promise));
    vi.stubGlobal('fetch', fetchMock);
    const shopping: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, shopping };
    window.eval(adapter);
    const reload = (window as any).DafanDomainAdapter.replaceShoppingService(shopping);
    const first = reload();
    await Promise.resolve();
    const second = reload();
    fresh.resolve(shoppingJson([shoppingListDto(4, [shoppingItemDto({ id: 'new' })])]));
    await second;
    stale.resolve(shoppingJson([shoppingListDto(2, [shoppingItemDto({ id: 'stale-item' })])]));
    await first;
    expect(shopping.data.map((x: any) => x.id)).toEqual(['new']);
  });

  it('shopping 写操作发送精确请求并串联清单 version，delete 走 query 且回拉清单', async () => {
    const fetchMock = vi.fn() as any;
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('dafan-pin-token', 'pin');
    const shopping: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, shopping };
    (window as any).BentoModal = { close: vi.fn() };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(shoppingJson([shoppingListDto(2, [])]));
    await (window as any).DafanDomainAdapter.replaceShoppingService(shopping)();
    fetchMock.mockClear();

    fetchMock.mockResolvedValueOnce(
      shoppingJson(
        shoppingListDto(3, [shoppingItemDto({ ingredientNameSnapshot: '牛腩', quantity: 500, unit: 'GRAM' })])
      )
    );
    await shopping.add({
      name: '牛腩',
      amount: '500g',
      source: '手动备忘',
      isChecked: false,
      id: 'local',
      date: 'today',
      random: 1
    });
    const addCall = fetchMock.mock.calls.find(([url]) => url === '/api/v1/shopping-lists/sl1/items');
    expect(addCall?.[1].method).toBe('POST');
    expect(JSON.parse(addCall?.[1].body)).toEqual({
      version: 2,
      ingredientName: '牛腩',
      quantity: 500,
      unit: 'GRAM',
      sourceType: 'MANUAL',
      sourceId: null,
      completed: false
    });
    expect(shopping.data[0]).toMatchObject({ id: 'it1', name: '牛腩', amount: '500g', isChecked: false });

    fetchMock.mockResolvedValueOnce(
      shoppingJson(
        shoppingListDto(4, [
          shoppingItemDto({ ingredientNameSnapshot: '牛腩', quantity: 500, unit: 'GRAM', completed: true })
        ])
      )
    );
    await shopping.toggle('it1');
    const toggleCall = fetchMock.mock.calls.find(([url]) => url === '/api/v1/shopping-list-items/it1');
    expect(toggleCall?.[1].method).toBe('PUT');
    expect(JSON.parse(toggleCall?.[1].body)).toEqual({ version: 3, completed: true });
    expect(shopping.data[0].isChecked).toBe(true);

    fetchMock
      .mockResolvedValueOnce(shoppingJson({ id: 'it1', shoppingListId: 'sl1' }))
      .mockResolvedValueOnce(shoppingJson(shoppingListDto(5, [])));
    await shopping.delete('it1');
    const deleteCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/v1/shopping-list-items/it1?'));
    expect(deleteCall?.[0]).toBe('/api/v1/shopping-list-items/it1?version=4');
    expect(deleteCall?.[1].method).toBe('DELETE');
    expect(deleteCall?.[1].body).toBeUndefined();
    expect(deleteCall?.[1].headers).not.toHaveProperty('Content-Type');
    expect(fetchMock.mock.calls.at(-1)[0]).toBe('/api/v1/shopping-lists/sl1');
    expect(shopping.data).toEqual([]);
  });

  it('shopping add：名称与规格必填，标准规格走结构化、自由规格按 amountText 原样保存', async () => {
    const fetchMock = vi.fn() as any;
    vi.stubGlobal('fetch', fetchMock);
    const shopping: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, shopping };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(shoppingJson([shoppingListDto(2, [])]));
    await (window as any).DafanDomainAdapter.replaceShoppingService(shopping)();
    fetchMock.mockClear();

    await expect(shopping.add({ name: '', amount: '1份' })).rejects.toMatchObject({ code: 'SHOPPING_ITEM_INVALID' });
    await expect(shopping.add({ name: '奇怪', amount: '   ' })).rejects.toMatchObject({
      code: 'SHOPPING_ITEM_INVALID'
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shopping.data).toEqual([]);

    const addBody = async (amount: string) => {
      // 固定回传 version 2 的 DTO：只验证请求体契约，不让版本随响应累积
      fetchMock.mockResolvedValueOnce(shoppingJson(shoppingListDto(2, [shoppingItemDto()])));
      await shopping.add({ name: '奇怪', amount });
      const call = fetchMock.mock.calls.at(-1);
      expect(call[0]).toBe('/api/v1/shopping-lists/sl1/items');
      expect(call[1].method).toBe('POST');
      return JSON.parse(call[1].body);
    };
    // 标准写法不额外携带 amountText（兼容既有请求体契约）
    expect(await addBody('500g')).toEqual({
      version: 2,
      ingredientName: '奇怪',
      sourceType: 'MANUAL',
      sourceId: null,
      completed: false,
      quantity: 500,
      unit: 'GRAM'
    });
    // 原文与标准展示不一致时保留原文语义
    expect(await addBody('200克')).toMatchObject({ quantity: 200, unit: 'GRAM', amountText: '200克' });
    expect(await addBody('0.5公斤')).toMatchObject({ quantity: 0.5, unit: 'KILOGRAM', amountText: '0.5公斤' });
    // 自由规格：不再抛 SHOPPING_AMOUNT_UNSUPPORTED，也不伪映射成 OTHER
    expect(await addBody('2根')).toEqual({
      version: 2,
      ingredientName: '奇怪',
      sourceType: 'MANUAL',
      sourceId: null,
      completed: false,
      quantity: null,
      unit: null,
      amountText: '2根'
    });
    expect(await addBody('适量')).toMatchObject({ quantity: null, unit: null, amountText: '适量' });
    expect(await addBody('1勺')).toMatchObject({ quantity: null, unit: null, amountText: '1勺' });
  });

  it('mapShoppingItem：名称不含规格，amountText 优先，暴露结构化状态', () => {
    const mapShoppingItem = (window as any).DafanDomainAdapter.mapShoppingItem;
    expect(
      mapShoppingItem({
        id: 'it1',
        ingredientNameSnapshot: '葱',
        quantity: null,
        unit: null,
        amountText: '2根',
        sourceType: 'RECIPE'
      })
    ).toMatchObject({
      name: '葱',
      amount: '2根',
      amountText: '2根',
      quantity: null,
      unitKey: null,
      hasStructuredQuantity: false
    });
    // 自由规格与结构化并存时仍以原文优先展示
    expect(
      mapShoppingItem({
        id: 'it2',
        ingredientNameSnapshot: '土豆',
        quantity: 200,
        unit: 'GRAM',
        amountText: '200克',
        sourceType: 'RECIPE'
      })
    ).toMatchObject({ name: '土豆', amount: '200克', hasStructuredQuantity: true });
    expect(
      mapShoppingItem({
        id: 'it3',
        ingredientNameSnapshot: '土豆',
        quantity: 200,
        unit: 'GRAM',
        amountText: null
      })
    ).toMatchObject({ name: '土豆', amount: '200g', amountText: null, quantity: 200, unitKey: 'GRAM' });
    // 无数量无规格绝不出现 'null'/'undefined' 文案
    const empty = mapShoppingItem({ id: 'it4', ingredientNameSnapshot: '盐', quantity: null, unit: null });
    expect(empty.amount).toBe('');
    expect(empty.hasStructuredQuantity).toBe(false);
  });

  it('mapShoppingItem：分类统一到七类，空值及无效分类按食材名推导', () => {
    // 单用例过滤运行时前序用例不会执行，这里在缺失时自行加载正式适配器源码
    if (!(window as any).DafanDomainAdapter) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonFail(503, 'OFFLINE', 'offline'))
      );
      window.eval(adapter);
    }
    const mapShoppingItem = (window as any).DafanDomainAdapter.mapShoppingItem;
    const base = { id: 'it-cat', ingredientNameSnapshot: '小葱', quantity: 1, unit: 'BAG', sourceType: 'MANUAL' };
    expect(mapShoppingItem({ ...base, category: '  调味 ' }).category).toBe('调味');
    expect(mapShoppingItem({ ...base, category: '肉禽' }).category).toBe('肉禽');
    for (const category of [null, undefined, '', '   ', 42, true, ['蔬菜'], { name: '蔬菜' }]) {
      expect(mapShoppingItem({ ...base, category }).category).toBe('调味');
    }
    expect(mapShoppingItem(base).category).toBe('调味');
    expect(mapShoppingItem({ ...base, ingredientNameSnapshot: '鸡蛋', category: '蛋奶' }).category).toBe('蛋奶豆制');
    expect(mapShoppingItem({ ...base, ingredientNameSnapshot: '未知物品' }).category).toBe('其他');
  });

  const realPageMarkup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  const realPageScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');

  /** 用正式 index.html 的真实脚本与标记渲染购物页，再加载正式 adapter（mapShoppingItem / renderShoppingList 均来自正式源码）。 */
  async function bootRealShoppingPage() {
    document.body.innerHTML = realPageMarkup;
    Object.defineProperty(Element.prototype, 'innerText', {
      configurable: true,
      get() {
        return this.textContent || '';
      },
      set(value) {
        this.textContent = value;
      }
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ success: true, data: { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 } })
      }))
    );
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        matches: false,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      }))
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    window.eval(realPageScripts);
    window.eval('var BentoService = window.BentoService;');
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** 用正式 index.html 的真实脚本与标记渲染记录/日记页，再加载正式 adapter。 */
  async function bootRealRecordsPage() {
    document.body.innerHTML = realPageMarkup;
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            data: String(url).includes('/dashboard')
              ? {
                  branding: {},
                  todayRecords: [],
                  recommendedRecipes: [],
                  inventory: {},
                  weeklyStats: {},
                  calendarDays: []
                }
              : String(url).includes('/statistics')
                ? {}
                : { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 }
          })
      }))
    );
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        matches: false,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      }))
    });
    window.eval(realPageScripts);
    window.eval('var BentoService = window.BentoService; var BentoModal = window.BentoModal;');
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('混合默认 null 草稿与含字面 null 的已确认记录：日记与记录列表按原文保留', async () => {
    await bootRealRecordsPage();
    const mapRecord = (window as any).DafanDomainAdapter.mapRecord;
    // 默认草稿：营养/备注全为真实 null；已确认记录标题/备注含单词 null
    const draft = mapRecord(
      recordDto({ id: 'draft-1', status: 'DRAFT', title: '计划午餐', calories: null, satiety: null, notes: null })
    );
    const confirmed = mapRecord(
      recordDto({
        id: 'confirmed-1',
        status: 'CONFIRMED',
        title: '早餐吃 null 味增汤',
        notes: '这里的 null 是字面文本，不能被清除',
        calories: 640,
        satiety: 8
      })
    );
    const records = (window as any).BentoService.records;
    records.data = [draft, confirmed];
    records.getAll = () => records.data;

    (window as any).renderRecords();
    const listText = document.getElementById('recordsListContainer')?.textContent || '';
    expect(listText).toContain('早餐吃 null 味增汤');
    expect(listText).toContain('这里的 null 是字面文本，不能被清除');
    expect(listText).toContain('640 kcal');
    expect(listText).not.toMatch(/null kcal|undefined/);

    (window as any).BentoModal.setupDailyDiary({ year: 2026, month: 9, day: 28 });
    const diaryText = document.getElementById('dailyDiaryMealsList')?.textContent || '';
    expect(diaryText).toContain('早餐吃 null 味增汤');
    expect(diaryText).toContain('这里的 null 是字面文本，不能被清除');
    expect(diaryText).toContain('640 kcal');
    // 草稿的空字段保持空展示，不出现字面 null 或派生假文案
    expect(diaryText).not.toMatch(/null kcal|饱腹感：null|undefined/);
    // 适配器不再用 textContent.replaceAll('null') 之类文本改写兜底
    expect(adapter).not.toContain(".replaceAll('null'");
    document.body.innerHTML = '';
  });

  it('records confirm 409 自愈后首页可见即刷新概览，非首页只置脏不发请求', async () => {
    await bootRealRecordsPage();
    const records = (window as any).BentoService.records;
    records.data = [
      (window as any).DafanDomainAdapter.mapRecord(
        recordDto({ id: 'rec1', status: 'DRAFT', version: 2, recordDate: '2026-09-28' })
      )
    ];
    records.getAll = () => records.data;
    const json = (data: unknown, status = 200) => ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data })
    });
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.includes('/records/rec1/confirm')) return json({ code: 'VERSION_CONFLICT', message: '版本冲突' }, 409);
      if (path.includes('/records/rec1'))
        return json(recordDto({ id: 'rec1', status: 'CONFIRMED', version: 4, recordDate: '2026-09-28' }));
      if (path.includes('/dashboard'))
        return json({
          weeklyStats: { totalMeals: 1 },
          todayRecords: [],
          recommendedRecipes: [],
          inventory: {},
          calendarDays: []
        });
      return json({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const dirty = vi.spyOn((window as any).BentoBus, 'emit');
    const home = document.getElementById('page-home')!;

    // 首页可见：自愈成功后立即刷新概览/活动统计
    expect(home.classList.contains('active')).toBe(true);
    await expect(records.confirm('rec1')).rejects.toMatchObject({ status: 409 });
    for (let i = 0; i < 20 && !fetchMock.mock.calls.some(([url]) => String(url).includes('/dashboard')); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/dashboard'))).toHaveLength(1);
    expect(dirty.mock.calls.filter(([name]) => name === 'dashboard:dirty')).toHaveLength(1);
    expect(document.querySelector('[data-binding="weeklyStat-totalMeals"]')?.textContent).toBe('1');
    expect(records.data[0]).toMatchObject({ id: 'rec1', status: 'CONFIRMED', version: 4 });

    // 非首页：自愈同样只置脏，不发 dashboard 请求
    home.classList.remove('active');
    records.data = [
      (window as any).DafanDomainAdapter.mapRecord(
        recordDto({ id: 'rec1', status: 'DRAFT', version: 5, recordDate: '2026-09-28' })
      )
    ];
    fetchMock.mockClear();
    dirty.mockClear();
    await expect(records.confirm('rec1')).rejects.toMatchObject({ status: 409 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/dashboard'))).toHaveLength(0);
    expect(dirty.mock.calls.filter(([name]) => name === 'dashboard:dirty')).toHaveLength(1);
    expect(records.data[0]).toMatchObject({ id: 'rec1', status: 'CONFIRMED', version: 4 });
    document.body.innerHTML = '';
  });

  it('confirm 409 自愈后日记确认按钮只提示一次，原始错误仍可传播', async () => {
    await bootRealRecordsPage();
    const records = (window as any).BentoService.records;
    records.data = [
      (window as any).DafanDomainAdapter.mapRecord(
        recordDto({ id: 'rec1', status: 'DRAFT', version: 2, recordDate: '2026-09-11', title: '计划午餐' })
      )
    ];
    records.getAll = () => records.data;
    const json = (data: unknown, status = 200) => ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data })
    });
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.includes('/records/rec1/confirm'))
        return json({ code: 'VERSION_CONFLICT', message: '版本冲突，请读取最新记录' }, 409);
      if (path.includes('/records/rec1'))
        return json(recordDto({ id: 'rec1', status: 'CONFIRMED', version: 4, recordDate: '2026-09-11' }));
      if (path.includes('/dashboard'))
        return json({
          weeklyStats: { totalMeals: 1 },
          todayRecords: [],
          recommendedRecipes: [],
          inventory: {},
          calendarDays: []
        });
      return json({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const toastSpy = vi.spyOn(window, 'showToast');
    (window as any).BentoModal.open('dailyDiary', { year: 2026, month: 9, day: 11 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('#dailyDiaryMealsList button')).find(
      (node) => node.textContent?.trim() === '确认已用餐'
    );
    expect(button).toBeTruthy();
    toastSpy.mockClear();

    // 按钮路径（confirmMealRecord 的 catch）不得在 service 提示之外再弹一次
    button!.click();
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (fetchMock.mock.calls.some(([url]) => String(url).includes('/records/rec1')) && records.data[0].version === 4)
        break;
    }
    const errorToasts = toastSpy.mock.calls.filter(([, type]) => type === 'error');
    expect(errorToasts).toHaveLength(1);
    expect(errorToasts[0][0]).toBe('记录已被修改或已确认，已同步最新状态，请刷新查看');
    expect(records.data[0]).toMatchObject({ id: 'rec1', status: 'CONFIRMED', version: 4 });

    // 直接调用仍拿到原始 409 错误对象（status/code 不变），并带已提示标记
    records.data = [
      (window as any).DafanDomainAdapter.mapRecord(
        recordDto({ id: 'rec1', status: 'DRAFT', version: 5, recordDate: '2026-09-11' })
      )
    ];
    const error = await records.confirm('rec1').catch((reason: any) => reason);
    expect(error).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect(error.__dafanRecordConfirmNotified).toBe(true);
    document.body.innerHTML = '';
  });

  it('mapShoppingItem → 真实 renderShoppingList：分类胶囊按纯文本渲染且无注入面', async () => {
    delete (window as any).__xss;
    await bootRealShoppingPage();
    const malicious = '<img src=x onerror="window.__xss=201">';
    const dtos = [
      {
        id: 'it-a',
        ingredientNameSnapshot: '小葱',
        quantity: 2,
        unit: 'PIECE',
        sourceType: 'MANUAL',
        category: ' 调味 '
      },
      {
        id: 'it-b',
        ingredientNameSnapshot: '盐',
        quantity: null,
        unit: null,
        sourceType: 'MANUAL',
        category: malicious
      },
      {
        id: 'it-c',
        ingredientNameSnapshot: '土豆',
        quantity: 200,
        unit: 'GRAM',
        sourceType: 'RECIPE',
        category: '   '
      },
      { id: 'it-d', ingredientNameSnapshot: '牛腩', quantity: 500, unit: 'GRAM', sourceType: 'MANUAL', category: 7 }
    ];
    const mapped = dtos.map((dto) => (window as any).DafanDomainAdapter.mapShoppingItem(dto));
    expect(mapped.map((item: any) => item.category)).toEqual(['调味', '调味', '蔬菜', '肉禽']);
    const shopping = (window as any).BentoService.shopping;
    shopping.data = mapped;
    shopping.getAll = () => shopping.data;
    (window as any).renderShoppingList();

    const container = document.getElementById('shoppingListContainer') as HTMLElement;
    expect(container.querySelectorAll('img, svg, script, iframe, object, embed')).toHaveLength(0);
    container.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
    });
    expect((window as any).__xss).toBeUndefined();
    // 所有分类均为七类白名单，恶意文本不会进入分类胶囊。
    const pills = Array.from(container.querySelectorAll('.rounded-full')) as HTMLElement[];
    expect(pills.map((pill) => pill.textContent)).toEqual(['调味', '调味', '蔬菜', '肉禽']);
    expect(container.textContent).not.toContain(malicious);
    // 不把正式页面标记遗留给后续用例（否则残留 #modalPinUnlock 会额外触发会话请求）
    document.body.innerHTML = '';
  });

  it.each([
    {
      status: 400,
      code: 'VALIDATION_ERROR',
      method: 'add',
      input: { name: '牛腩', amount: '500g' },
      expectedMethod: 'POST',
      expectedPath: '/api/v1/shopping-lists/sl1/items'
    },
    {
      status: 404,
      code: 'NOT_FOUND',
      method: 'toggle',
      input: 'it-old',
      expectedMethod: 'PUT',
      expectedPath: '/api/v1/shopping-list-items/it-old'
    },
    {
      status: 409,
      code: 'VERSION_CONFLICT',
      method: 'toggle',
      input: 'it-old',
      expectedMethod: 'PUT',
      expectedPath: '/api/v1/shopping-list-items/it-old'
    },
    {
      status: 503,
      code: 'MAINTENANCE',
      method: 'delete',
      input: 'it-old',
      expectedMethod: 'DELETE',
      expectedPath: '/api/v1/shopping-list-items/it-old?version=2'
    }
  ])('shopping %s %s 写失败传播状态并保持 service、modal 与 toast 不变', async (caseData) => {
    const toast = vi.fn();
    const close = vi.fn();
    const fetchMock = vi.fn() as any;
    const loadedItems = [shoppingItemDto({ id: 'it-old', ingredientNameSnapshot: '旧', quantity: 1 })];
    fetchMock.mockResolvedValue(shoppingJson([shoppingListDto(2, loadedItems)]));
    vi.stubGlobal('fetch', fetchMock);
    (window as any).showToast = toast;
    (window as any).BentoModal = { close };
    const shopping: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, shopping };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(shoppingJson([shoppingListDto(2, loadedItems)]));
    await (window as any).DafanDomainAdapter.replaceShoppingService(shopping)();
    fetchMock.mockClear();
    const before = structuredClone(shopping.data);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: caseData.status,
      text: async () => JSON.stringify({ success: false, error: { code: caseData.code, message: '写入失败' } })
    });
    await expect(shopping[caseData.method](caseData.input)).rejects.toMatchObject({
      status: caseData.status,
      code: caseData.code
    });
    expect(shopping.data).toEqual(before);
    expect(close).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    const call = fetchMock.mock.calls.at(-1);
    expect(call[0]).toBe(caseData.expectedPath);
    expect(call[1].method ?? 'GET').toBe(caseData.expectedMethod);
  });

  it('shopping importCheckedToPantry 真实入库：批次无固定日期，勾选项经 completed+clear-completed 清理', async () => {
    const checkedMeat = shoppingItemDto({
      id: 'it1',
      ingredientNameSnapshot: '鸡腿肉 (手动补货)',
      quantity: 600,
      unit: 'GRAM',
      completed: true
    });
    const checkedEgg = shoppingItemDto({
      id: 'it2',
      ingredientNameSnapshot: '鸡蛋',
      quantity: 6,
      unit: 'PIECE',
      sourceType: 'LOW_STOCK',
      ingredientId: 'ing-9',
      completed: true
    });
    const unchecked = shoppingItemDto({ id: 'it3', ingredientNameSnapshot: '小葱', quantity: 1, unit: 'BAG' });
    const loadedItems = [checkedMeat, checkedEgg, unchecked];
    const fetchMock = vi.fn() as any;
    fetchMock.mockResolvedValue(shoppingJson([shoppingListDto(2, loadedItems)]));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const shopping: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, shopping };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(shoppingJson([shoppingListDto(2, loadedItems)]));
    await (window as any).DafanDomainAdapter.replaceShoppingService(shopping)();
    fetchMock.mockClear();

    fetchMock
      .mockResolvedValueOnce(shoppingJson(shoppingListDto(3, [unchecked])))
      .mockResolvedValueOnce(shoppingJson(shoppingListDto(3, [unchecked])))
      .mockResolvedValueOnce(shoppingJson([shoppingListDto(3, [unchecked])]));
    expect(await shopping.importCheckedToPantry()).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/shopping-lists/sl1/check-in',
      '/api/v1/shopping-lists/sl1',
      '/api/v1/shopping-lists?status=ACTIVE'
    ]);
    const checkinCall = fetchMock.mock.calls[0];
    expect(JSON.parse(checkinCall[1].body)).toMatchObject({ version: 2, itemIds: ['it1', 'it2'] });
    expect(JSON.parse(checkinCall[1].body).operationId).toBeTruthy();
    expect(shopping.data).toEqual([expect.objectContaining({ id: 'it3' })]);
    expect(toast).toHaveBeenCalledWith('已将 2 件采购食材入库冰箱', 'success');
  });

  it('shopping importCheckedToPantry 无勾选仅提示不发请求，建档失败时错误传播且清单不变', async () => {
    const unloaded = [shoppingItemDto({ id: 'it3', completed: false })];
    const fetchMock = vi.fn() as any;
    fetchMock.mockResolvedValue(shoppingJson([shoppingListDto(2, unloaded)]));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const shopping: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, shopping };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(shoppingJson([shoppingListDto(2, unloaded)]));
    await (window as any).DafanDomainAdapter.replaceShoppingService(shopping)();
    fetchMock.mockClear();
    expect(await shopping.importCheckedToPantry()).toBe(false);
    expect(toast).toHaveBeenCalledWith('请先勾选已采购的物品再入库', 'error');
    expect(fetchMock).not.toHaveBeenCalled();

    const checkedItems = [
      shoppingItemDto({ id: 'it1', ingredientNameSnapshot: '鸡腿肉', quantity: 600, unit: 'GRAM', completed: true })
    ];
    fetchMock.mockResolvedValueOnce(shoppingJson([shoppingListDto(2, checkedItems)]));
    await (window as any).DafanDomainAdapter.replaceShoppingService(shopping)();
    fetchMock.mockClear();
    const before = structuredClone(shopping.data);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: '食材名称不能为空' } })
    });
    await expect(shopping.importCheckedToPantry()).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/shopping-lists/sl1/check-in']);
    expect(shopping.data).toEqual(before);
  });

  it('【VAN-31 断点】丢响应后重启：重放原 listId/原 payload，不因 active 清单变化、勾选消失或 version 前进而换新 operation', async () => {
    const checkedMeat = shoppingItemDto({
      id: 'it1',
      ingredientNameSnapshot: '鸡腿肉',
      quantity: 600,
      unit: 'GRAM',
      completed: true
    });
    const checkedEgg = shoppingItemDto({
      id: 'it2',
      ingredientNameSnapshot: '鸡蛋',
      quantity: 6,
      unit: 'PIECE',
      completed: true
    });
    localStorage.setItem('dafan-pin-token', 'pin-token-van31');
    const first = await bootShopping(shoppingListDto(2, [checkedMeat, checkedEgg]), {
      '/api/v1/shopping-lists/sl1/check-in': () => Promise.reject(new TypeError('Failed to fetch'))
    });
    await expect(first.shopping.importCheckedToPantry()).rejects.toThrow('Failed to fetch');
    // 请求已发出、响应丢失：本地必须留下未决记录（而不是被当成“没有未决操作”）
    const recorded = readPendingRecord();
    expect(recorded).toMatchObject({ listId: 'sl1', version: 2, itemIds: ['it1', 'it2'] });
    expect(recorded.operationId).toBeTruthy();
    expect(first.fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/shopping-lists/sl1/check-in']);
    expect(first.fetchMock.mock.calls[0][1].headers['X-App-Pin-Token']).toBe('pin-token-van31');
    expect(first.toast).not.toHaveBeenCalled();

    // 模拟重启 + 后端已经推进：active 清单变成另一张 sl2（其中还有已勾选项），原 sl1 已无勾选项且 version 已到 5
    const restartedActive = {
      ...shoppingListDto(7, [
        shoppingItemDto({ id: 'it-sl2', ingredientNameSnapshot: '新清单已勾选项', completed: true })
      ]),
      id: 'sl2'
    };
    const restarted = await bootShopping(restartedActive, {
      '/api/v1/shopping-lists/sl1/check-in': shoppingJson(shoppingListDto(5, [])),
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(5, [])),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([restartedActive]),
      '/api/v1/shopping-lists/sl2/check-in': shoppingJson(shoppingListDto(8, [])),
      '/api/v1/shopping-lists/sl2': shoppingJson(shoppingListDto(8, []))
    });
    expect(restarted.shopping.data.map((x: any) => x.id)).toEqual(['it-sl2']);
    expect(restarted.shopping.data.filter((x: any) => x.isChecked)).toHaveLength(1);
    expect(await restarted.shopping.importCheckedToPantry()).toBe(true);

    const calls = restarted.fetchMock.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      '/api/v1/shopping-lists/sl1/check-in',
      '/api/v1/shopping-lists/sl1',
      '/api/v1/shopping-lists?status=ACTIVE'
    ]);
    // 用的是原 listId + 原 payload（version 2 / 原 operationId / 原 itemIds），不是当前 active 清单与新勾选
    expect(JSON.parse(calls[0][1].body)).toEqual({
      version: 2,
      operationId: recorded.operationId,
      itemIds: ['it1', 'it2']
    });
    expect(restarted.toast).toHaveBeenCalledWith('已将 2 件采购食材入库冰箱', 'success');
    expect(readPendingRecord()).toBeNull();

    // 重放完成后的再次点击属于新的用户操作：按当前 active 清单 + 新勾选 + 新 operationId，绝不复用旧 operation
    expect(await restarted.shopping.importCheckedToPantry()).toBe(true);
    const checkinCalls = restarted.fetchMock.mock.calls.filter(([url]) => String(url).includes('/check-in'));
    expect(checkinCalls.map(([url]) => url)).toEqual([
      '/api/v1/shopping-lists/sl1/check-in',
      '/api/v1/shopping-lists/sl2/check-in'
    ]);
    const newOperation = JSON.parse(checkinCalls[1][1].body);
    expect(newOperation).toMatchObject({ version: 7, itemIds: ['it-sl2'] });
    expect(newOperation.operationId).not.toBe(recorded.operationId);
  });

  it('【VAN-31 断点】当前清单已无勾选项、version 已更新时仍按原 payload 重放，而不是报“请先勾选”', async () => {
    const checked = shoppingItemDto({
      id: 'it1',
      ingredientNameSnapshot: '鸡腿肉',
      quantity: 600,
      unit: 'GRAM',
      completed: true
    });
    // 第一次：网络层失败，留下未决记录（version 2 / it1）
    localStorage.setItem('dafan-pin-token', 'pin-token-van31');
    const first = await bootShopping(shoppingListDto(2, [checked]), {
      '/api/v1/shopping-lists/sl1/check-in': () => Promise.reject(new TypeError('Failed to fetch'))
    });
    await expect(first.shopping.importCheckedToPantry()).rejects.toThrow('Failed to fetch');
    const recorded = readPendingRecord();

    // 重启后仍是同一张 sl1，但勾选项已被别处清掉、version 已前进到 5
    const advanced = shoppingListDto(5, [shoppingItemDto({ id: 'it-other', ingredientNameSnapshot: '其它项' })]);
    const restarted = await bootShopping(advanced, {
      '/api/v1/shopping-lists/sl1/check-in': shoppingJson(shoppingListDto(5, [])),
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(6, [])),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([advanced])
    });
    expect(restarted.shopping.data).toHaveLength(1);
    expect(restarted.shopping.data.every((x: any) => !x.isChecked)).toBe(true);

    expect(await restarted.shopping.importCheckedToPantry()).toBe(true);
    const checkinCall = restarted.fetchMock.mock.calls.find(([url]) => String(url).includes('/check-in'));
    expect(JSON.parse(checkinCall![1].body)).toEqual({
      version: 2,
      operationId: recorded.operationId,
      itemIds: ['it1']
    });
    expect(restarted.toast).not.toHaveBeenCalledWith('请先勾选已采购的物品再入库', 'error');
    expect(restarted.toast).toHaveBeenCalledWith('已将 1 件采购食材入库冰箱', 'success');
  });

  it('【VAN-31 断点】storage 写入失败不发请求；pending 无法解析或读取失败时 fail-closed 阻断且不覆盖', async () => {
    const checked = shoppingItemDto({
      id: 'it1',
      ingredientNameSnapshot: '鸡腿肉',
      quantity: 600,
      unit: 'GRAM',
      completed: true
    });
    const { fetchMock, toast, shopping } = await bootShopping(shoppingListDto(2, [checked]), {
      '/api/v1/shopping-lists/sl1/check-in': shoppingJson(shoppingListDto(3, []))
    });

    stubStorage({
      setItem: () => {
        throw new Error('QuotaExceededError');
      }
    });
    expect(await shopping.importCheckedToPantry()).toBe(false);
    stubStorage({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('无法保存入库待处理操作，未执行入库', 'error');
    expect(readPendingRecord()).toBeNull();

    // malformed pending：既不重放也不允许用新勾选覆盖
    localStorage.setItem(pendingCheckinKey, '{not json');
    expect(await shopping.importCheckedToPantry()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(pendingCheckinKey)).toBe('{not json');

    // 结构不合法（version 非正整数）同样按 fail-closed 处理
    localStorage.setItem(
      pendingCheckinKey,
      JSON.stringify({ listId: 'sl1', version: 0, operationId: 'op', itemIds: ['it1'] })
    );
    expect(await shopping.importCheckedToPantry()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingRecord()).toMatchObject({ version: 0 });

    // 空字符串是损坏记录（不是“没有未决操作”）：fail-closed 且原样保留
    localStorage.setItem(pendingCheckinKey, '');
    expect(await shopping.importCheckedToPantry()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(pendingCheckinKey)).toBe('');

    // 空白 item id：本地不可能来自服务端，按损坏记录阻断
    localStorage.setItem(
      pendingCheckinKey,
      JSON.stringify({ listId: 'sl1', version: 2, operationId: 'op', itemIds: ['   '] })
    );
    expect(await shopping.importCheckedToPantry()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingRecord()).toMatchObject({ itemIds: ['   '] });

    // operationId 不满足服务端正则（含空格/非法字符）同样按损坏记录阻断
    localStorage.setItem(
      pendingCheckinKey,
      JSON.stringify({ listId: 'sl1', version: 2, operationId: 'bad op id!', itemIds: ['it1'] })
    );
    expect(await shopping.importCheckedToPantry()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingRecord()).toMatchObject({ operationId: 'bad op id!' });

    // localStorage 读取本身抛错：不得退化成“无未决操作”
    stubStorage({
      getItem: () => {
        throw new Error('SecurityError');
      }
    });
    expect(await shopping.importCheckedToPantry()).toBe(false);
    stubStorage({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingRecord()).toMatchObject({ operationId: 'bad op id!' });
    expect(toast).toHaveBeenCalledWith(
      '检测到无法解析的入库待处理记录，已阻止本次入库以避免重复或遗漏；该记录已保留，请先排查后再重试',
      'error'
    );
    // 诚实提示不得引导用户清理数据抹掉未决记录
    expect(toast.mock.calls.flat().join(' ')).not.toContain('清理浏览器数据');
  });

  it('【VAN-31 断点】入库成功但清理未决记录失败：保留原 operation、真实警告、不误报失败也不新建 operation', async () => {
    const checked = shoppingItemDto({
      id: 'it1',
      ingredientNameSnapshot: '鸡腿肉',
      quantity: 600,
      unit: 'GRAM',
      completed: true
    });
    const routes: Record<string, unknown | ((init: any) => unknown)> = {
      '/api/v1/shopping-lists/sl1/check-in': shoppingJson(shoppingListDto(3, [])),
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(3, [])),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(3, [])])
    };
    const { fetchMock, toast, shopping } = await bootShopping(shoppingListDto(2, [checked]), routes);
    stubStorage({
      removeItem: () => {
        throw new Error('SecurityError');
      }
    });
    expect(await shopping.importCheckedToPantry()).toBe(true);
    expect(toast).toHaveBeenCalledWith('已入库，刷新未完成', 'warning');
    stubStorage({});
    const retained = readPendingRecord();
    expect(retained).toMatchObject({ listId: 'sl1', version: 2 });

    // 重试仍然沿用原 operationId（幂等重放），绝不新建第二个 operation
    expect(await shopping.importCheckedToPantry()).toBe(true);
    const checkinBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/check-in'))
      .map(([, init]) => JSON.parse(init.body));
    expect(checkinBodies).toHaveLength(2);
    expect(checkinBodies[1].operationId).toBe(retained.operationId);
    expect(toast).toHaveBeenCalledWith('已将 1 件采购食材入库冰箱', 'success');
  });

  it('【VAN-31 断点】并发点击只产生一次 mutation，第二个调用复用同一 promise', async () => {
    const checked = shoppingItemDto({
      id: 'it1',
      ingredientNameSnapshot: '鸡腿肉',
      quantity: 600,
      unit: 'GRAM',
      completed: true
    });
    const gate = deferred<any>();
    const { fetchMock, shopping } = await bootShopping(shoppingListDto(2, [checked]), {
      '/api/v1/shopping-lists/sl1/check-in': () => gate.promise,
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(3, [])),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(3, [])])
    });
    const firstClick = shopping.importCheckedToPantry();
    const secondClick = shopping.importCheckedToPantry();
    await Promise.resolve();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/check-in'))).toHaveLength(1);
    gate.resolve(shoppingJson(shoppingListDto(3, [])));
    expect(await firstClick).toBe(true);
    expect(await secondClick).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/check-in'))).toHaveLength(1);
  });

  it('【VAN-31 断点】4xx 明确失败释放 pending 并允许用新 operation 重试；5xx 保留 pending 且原样重放', async () => {
    const checked = shoppingItemDto({
      id: 'it1',
      ingredientNameSnapshot: '鸡腿肉',
      quantity: 600,
      unit: 'GRAM',
      completed: true
    });
    const routes: Record<string, unknown | ((init: any) => unknown)> = {
      '/api/v1/shopping-lists/sl1/check-in': errorJson(409, 'VERSION_CONFLICT', '清单版本冲突'),
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(2, [checked])),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(2, [checked])])
    };
    const { fetchMock, shopping } = await bootShopping(shoppingListDto(2, [checked]), routes);
    await expect(shopping.importCheckedToPantry()).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect(readPendingRecord()).toBeNull();
    const firstOperationId = JSON.parse(fetchMock.mock.calls[0][1].body).operationId;

    // 用户修正后重试：允许新的 operation（不是被旧的未决记录卡死）
    routes['/api/v1/shopping-lists/sl1/check-in'] = shoppingJson(shoppingListDto(3, []));
    await shopping.importCheckedToPantry();
    const checkinBodies = () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).includes('/check-in'))
        .map(([, init]) => JSON.parse(init.body));
    expect(checkinBodies().at(-1).operationId).not.toBe(firstOperationId);

    // 5xx：pending 保留，重试沿用同一 operationId（幂等重放，不新建 operation）
    await shopping.reload();
    routes['/api/v1/shopping-lists/sl1/check-in'] = errorJson(503, 'MAINTENANCE', '服务维护中');
    await expect(shopping.importCheckedToPantry()).rejects.toMatchObject({ status: 503 });
    const retained = readPendingRecord();
    expect(retained).toMatchObject({ listId: 'sl1', version: 2 });
    routes['/api/v1/shopping-lists/sl1/check-in'] = shoppingJson(shoppingListDto(4, []));
    await shopping.importCheckedToPantry();
    expect(checkinBodies().at(-1).operationId).toBe(retained.operationId);
    expect(readPendingRecord()).toBeNull();
  });

  it('【VAN-31 断点】最新 DTO 已取到但 active 查询失败：pending 保留，重启后 active 变化且无勾选仍按原 URL/payload 重放', async () => {
    const checked = shoppingItemDto({
      id: 'it1',
      ingredientNameSnapshot: '鸡腿肉',
      quantity: 600,
      unit: 'GRAM',
      completed: true
    });
    const first = await bootShopping(shoppingListDto(2, [checked]), {
      '/api/v1/shopping-lists/sl1/check-in': shoppingJson(shoppingListDto(3, [])),
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(3, []))
      // 故意不声明 ACTIVE：原清单最新 DTO 已成功取到，但 active 刷新失败时 pending 必须保留
    });
    expect(await first.shopping.importCheckedToPantry()).toBe(true);
    expect(first.toast).toHaveBeenCalledWith('已入库，刷新未完成', 'warning');
    const recorded = readPendingRecord();
    expect(recorded).toMatchObject({ listId: 'sl1', version: 2, itemIds: ['it1'] });
    expect(first.fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/shopping-lists/sl1/check-in',
      '/api/v1/shopping-lists/sl1',
      '/api/v1/shopping-lists?status=ACTIVE'
    ]);

    // 重启：active 换成另一张没有勾选项的 sl2；必须重放原 sl1 + 原 payload，而不是改绑当前 active
    const restartedActive = {
      ...shoppingListDto(7, [
        shoppingItemDto({ id: 'it-sl2', ingredientNameSnapshot: '新 active 项', completed: false })
      ]),
      id: 'sl2'
    };
    const restarted = await bootShopping(restartedActive, {
      '/api/v1/shopping-lists/sl1/check-in': shoppingJson(shoppingListDto(5, [])),
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(5, [])),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([restartedActive])
    });
    expect(restarted.shopping.data.map((x: any) => x.id)).toEqual(['it-sl2']);
    expect(await restarted.shopping.importCheckedToPantry()).toBe(true);
    const calls = restarted.fetchMock.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      '/api/v1/shopping-lists/sl1/check-in',
      '/api/v1/shopping-lists/sl1',
      '/api/v1/shopping-lists?status=ACTIVE'
    ]);
    expect(JSON.parse(calls[0][1].body)).toEqual({ version: 2, operationId: recorded.operationId, itemIds: ['it1'] });
    expect(restarted.toast).toHaveBeenCalledWith('已将 1 件采购食材入库冰箱', 'success');
    expect(readPendingRecord()).toBeNull();
  });

  it('【VAN-31 断点】pantry/dashboard 刷新分别失败：pending 保留在原 operation，修复后按原 URL+payload 重放', async () => {
    const checked = shoppingItemDto({
      id: 'it1',
      ingredientNameSnapshot: '鸡腿肉',
      quantity: 600,
      unit: 'GRAM',
      completed: true
    });
    const routes: Record<string, unknown | ((init: any) => unknown)> = {
      '/api/v1/shopping-lists/sl1/check-in': shoppingJson(shoppingListDto(3, [])),
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(3, [])),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(3, [])])
    };

    // pantry reload reject：mutation 已成功，仍保留未决记录
    const pantryCase = await bootShopping(shoppingListDto(2, [checked]), routes, { pantry: { data: [] } });
    (window as any).BentoService.pantry.reload = () => Promise.reject(new Error('pantry down'));
    expect(await pantryCase.shopping.importCheckedToPantry()).toBe(true);
    expect(pantryCase.toast).toHaveBeenCalledWith('已入库，刷新未完成', 'warning');
    const pantryPending = readPendingRecord();
    expect(pantryPending).toMatchObject({ listId: 'sl1', version: 2 });
    // 修复刷新后重试：沿用原 operationId 幂等重放，绝不新建 operation
    (window as any).BentoService.pantry.reload = () => Promise.resolve([]);
    expect(await pantryCase.shopping.importCheckedToPantry()).toBe(true);
    const pantryBodies = pantryCase.fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/check-in'))
      .map(([, init]) => JSON.parse(init.body));
    expect(pantryBodies).toHaveLength(2);
    expect(pantryBodies[1]).toEqual({ version: 2, operationId: pantryPending.operationId, itemIds: ['it1'] });
    expect(readPendingRecord()).toBeNull();
    expect(pantryCase.toast).toHaveBeenCalledWith('已将 1 件采购食材入库冰箱', 'success');
    // 警告只说明刷新未完成，不得误报入库失败
    expect(pantryCase.toast.mock.calls.flat().join(' ')).not.toContain('入库失败');

    // dashboard reload reject：同一契约
    const dashboardCase = await bootShopping(shoppingListDto(2, [checked]), routes, {
      dashboard: { data: {}, reload: () => Promise.reject(new Error('dashboard down')) }
    });
    expect(await dashboardCase.shopping.importCheckedToPantry()).toBe(true);
    expect(dashboardCase.toast).toHaveBeenCalledWith('已入库，刷新未完成', 'warning');
    const dashboardPending = readPendingRecord();
    expect(dashboardPending).toMatchObject({ listId: 'sl1', version: 2 });
    (window as any).BentoService.dashboard.reload = () => Promise.resolve([]);
    expect(await dashboardCase.shopping.importCheckedToPantry()).toBe(true);
    const dashboardBodies = dashboardCase.fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/check-in'))
      .map(([, init]) => JSON.parse(init.body));
    expect(dashboardBodies).toHaveLength(2);
    expect(dashboardBodies[1]).toEqual({ version: 2, operationId: dashboardPending.operationId, itemIds: ['it1'] });
    expect(readPendingRecord()).toBeNull();
    expect(dashboardCase.toast).toHaveBeenCalledWith('已将 1 件采购食材入库冰箱', 'success');
  });

  it('【VAN-31 断点】入库后无 active 清单：不创建新清单、不保留旧无关清单数据，同清单保留最新 DTO', async () => {
    const checked = shoppingItemDto({
      id: 'it1',
      ingredientNameSnapshot: '鸡腿肉',
      quantity: 600,
      unit: 'GRAM',
      completed: true
    });
    // 同一张清单、latest 已成功应用：无 active 时保持该清单的最新事实数据（而非清空），不建新清单
    const remaining = shoppingItemDto({ id: 'it-remain', ingredientNameSnapshot: '未勾选项', quantity: 1 });
    const sameList = await bootShopping(shoppingListDto(2, [checked]), {
      '/api/v1/shopping-lists/sl1/check-in': shoppingJson(shoppingListDto(3, [remaining])),
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(3, [remaining])),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([])
    });
    expect(await sameList.shopping.importCheckedToPantry()).toBe(true);
    expect(sameList.toast).toHaveBeenCalledWith('已将 1 件采购食材入库冰箱', 'success');
    expect(sameList.fetchMock.mock.calls.filter(([url]) => url === '/api/v1/shopping-lists')).toHaveLength(0);
    // 原清单最新 DTO 的剩余项按事实保留，而不是被无 active 分支清空
    expect(sameList.shopping.data.map((x: any) => x.id)).toEqual(['it-remain']);
    expect(readPendingRecord()).toBeNull();

    // 跨清单（pending 属于 sl1、当前内存清单是 sl2）：active 返回空时清掉无关的 sl2 数据，仍不造新清单
    const otherActive = {
      ...shoppingListDto(4, [shoppingItemDto({ id: 'it-sl2', ingredientNameSnapshot: '无关清单项' })]),
      id: 'sl2'
    };
    const crossList = await bootShopping(otherActive, {
      '/api/v1/shopping-lists/sl1/check-in': shoppingJson(shoppingListDto(6, [])),
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(6, [])),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([])
    });
    expect(crossList.shopping.data.map((x: any) => x.id)).toEqual(['it-sl2']);
    localStorage.setItem(
      pendingCheckinKey,
      JSON.stringify({ listId: 'sl1', version: 2, operationId: 'op-cross-list', itemIds: ['it1'] })
    );
    expect(await crossList.shopping.importCheckedToPantry()).toBe(true);
    expect(crossList.fetchMock.mock.calls.filter(([url]) => url === '/api/v1/shopping-lists')).toHaveLength(0);
    expect(crossList.shopping.data).toEqual([]);
    expect(readPendingRecord()).toBeNull();
    const crossCheckin = crossList.fetchMock.mock.calls.find(([url]) => String(url).includes('/check-in'));
    expect(JSON.parse(crossCheckin![1].body)).toEqual({ version: 2, operationId: 'op-cross-list', itemIds: ['it1'] });
  });

  it('【VAN-31 断点】mutation 已成功但刷新失败：真实提示、不误报入库失败、不自动新建 operation', async () => {
    const checked = shoppingItemDto({
      id: 'it1',
      ingredientNameSnapshot: '鸡腿肉',
      quantity: 600,
      unit: 'GRAM',
      completed: true
    });
    const routes: Record<string, unknown | ((init: any) => unknown)> = {
      '/api/v1/shopping-lists/sl1/check-in': shoppingJson(shoppingListDto(3, [])),
      '/api/v1/shopping-lists/sl1': errorJson(500, 'INTERNAL_ERROR', '服务器内部错误')
    };
    const { fetchMock, toast, shopping } = await bootShopping(shoppingListDto(2, [checked]), routes);
    expect(await shopping.importCheckedToPantry()).toBe(true);
    expect(toast).toHaveBeenCalledWith('已入库，刷新未完成', 'warning');
    expect(toast.mock.calls.flat()).not.toContain('服务器内部错误');
    // 未取到最新清单前不得清除未决记录，也不能丢掉原 operation
    expect(readPendingRecord()).toMatchObject({ listId: 'sl1', version: 2 });
    const operationId = readPendingRecord().operationId;

    routes['/api/v1/shopping-lists/sl1'] = shoppingJson(shoppingListDto(3, []));
    routes['/api/v1/shopping-lists?status=ACTIVE'] = shoppingJson([shoppingListDto(3, [])]);
    expect(await shopping.importCheckedToPantry()).toBe(true);
    const checkinBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/check-in'))
      .map(([, init]) => JSON.parse(init.body));
    expect(checkinBodies).toHaveLength(2);
    expect(checkinBodies[1].operationId).toBe(operationId);
    expect(readPendingRecord()).toBeNull();
    expect(toast).toHaveBeenCalledWith('已将 1 件采购食材入库冰箱', 'success');
  });

  it('【VAN-31 断点】幂等命中返回缓存清单后仍回拉原清单最新 DTO，后续改动与版本不被旧缓存覆盖', async () => {
    const checked = shoppingItemDto({
      id: 'it1',
      ingredientNameSnapshot: '鸡腿肉',
      quantity: 600,
      unit: 'GRAM',
      completed: true
    });
    const cachedStale = shoppingListDto(3, [shoppingItemDto({ id: 'it-old', ingredientNameSnapshot: '旧缓存项' })]);
    const latest = shoppingListDto(6, [
      shoppingItemDto({ id: 'it-later', ingredientNameSnapshot: '后来新增项' }),
      shoppingItemDto({ id: 'it-later-2', ingredientNameSnapshot: '后来新增项二' })
    ]);
    const routes: Record<string, unknown | ((init: any) => unknown)> = {
      // 幂等命中：服务端直接回放历史缓存 DTO
      '/api/v1/shopping-lists/sl1/check-in': shoppingJson(cachedStale),
      '/api/v1/shopping-lists/sl1': shoppingJson(latest),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([latest])
    };
    const { fetchMock, shopping } = await bootShopping(shoppingListDto(4, [checked]), routes);
    expect(await shopping.importCheckedToPantry()).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/shopping-lists/sl1/check-in',
      '/api/v1/shopping-lists/sl1',
      '/api/v1/shopping-lists?status=ACTIVE'
    ]);
    expect(shopping.data.map((x: any) => x.id)).toEqual(['it-later', 'it-later-2']);
    expect(shopping.data.map((x: any) => x.id)).not.toContain('it-old');
    // 幂等缓存 DTO 里的 version 3 不得成为最终版本：后续写操作必须基于最新回拉到的 6
    routes['/api/v1/shopping-list-items/it-later'] = shoppingJson(latest);
    await shopping.toggle('it-later');
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toEqual({ version: 6, completed: true });
  });

  it('legacy 购物表单真实 submit 映射字段、成功关闭 Modal 并恢复按钮，失败不关闭', async () => {
    document.body.innerHTML = `<form><input id="formShopName" value="新鲜牛腩"><select id="formShopCategory"><option selected>肉禽</option></select><input id="formShopAmount" value="500g"></form>`;
    const fetchMock = vi.fn() as any;
    fetchMock.mockResolvedValue(shoppingJson([shoppingListDto(2, [])]));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const close = vi.fn();
    const modal: any = { open: vi.fn(), close, handleShoppingFormSubmit: vi.fn() };
    (window as any).BentoModal = modal;
    const shopping: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, shopping };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(shoppingJson([shoppingListDto(2, [])]));
    await (window as any).DafanDomainAdapter.replaceShoppingService(shopping)();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      shoppingJson(
        shoppingListDto(3, [shoppingItemDto({ ingredientNameSnapshot: '新鲜牛腩', quantity: 500, unit: 'GRAM' })])
      )
    );
    const button = document.createElement('button');
    document.querySelector('form')!.append(button);
    await modal.handleShoppingFormSubmit({ preventDefault: vi.fn(), submitter: button });
    const addCall = fetchMock.mock.calls.find(([url]) => url === '/api/v1/shopping-lists/sl1/items');
    expect(addCall?.[1].method).toBe('POST');
    expect(JSON.parse(addCall?.[1].body)).toMatchObject({
      ingredientName: '新鲜牛腩',
      quantity: 500,
      unit: 'GRAM',
      sourceType: 'MANUAL'
    });
    expect(close).toHaveBeenCalledWith(true);
    expect(button.disabled).toBe(false);

    const callsAfterSuccess = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: '食材名称不能为空' } })
    });
    await modal.handleShoppingFormSubmit({ preventDefault: vi.fn(), submitter: button });
    expect(fetchMock.mock.calls.length).toBe(callsAfterSuccess + 1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('食材名称不能为空', 'error');
    expect(button.disabled).toBe(false);
  });

  it('pantry addToShopping 解封后映射购物清单写端点，OTHER 单位落为自由规格「适量」', async () => {
    const fetchMock = vi.fn() as any;
    vi.stubGlobal('fetch', fetchMock);
    const close = vi.fn();
    (window as any).BentoModal = { close };
    const toast = vi.fn();
    (window as any).showToast = toast;
    const pantry: any = {
      data: [
        { id: 'i1', name: '生菜', version: 1, unit: '个', unitKey: 'PIECE' },
        { id: 'i2', name: '散装', version: 1, unit: '', unitKey: 'OTHER' }
      ]
    };
    const shopping: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, pantry, shopping };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    pantry.data = [
      { id: 'i1', name: '生菜', version: 1, unit: '个', unitKey: 'PIECE' },
      { id: 'i2', name: '散装', version: 1, unit: '', unitKey: 'OTHER' }
    ];
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(shoppingJson([shoppingListDto(2, [])]));
    await (window as any).DafanDomainAdapter.replaceShoppingService(shopping)();
    (window as any).DafanDomainAdapter.replacePantryService(pantry);
    fetchMock.mockClear();

    fetchMock.mockResolvedValueOnce(
      shoppingJson(
        shoppingListDto(3, [shoppingItemDto({ ingredientNameSnapshot: '生菜', quantity: 1, unit: 'PIECE' })])
      )
    );
    await pantry.addToShopping('i1');
    const call = fetchMock.mock.calls.at(-1);
    expect(call[0]).toBe('/api/v1/shopping-lists/sl1/items');
    expect(call[1].method).toBe('POST');
    // F-07：补货名称只允许纯净食材名，绝不拼「(手动补货)」
    expect(JSON.parse(call[1].body)).toEqual({
      version: 2,
      ingredientName: '生菜',
      quantity: 1,
      unit: 'PIECE',
      category: '蔬菜',
      sourceType: 'MANUAL',
      sourceId: null,
      completed: false
    });
    expect(close).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('已将「生菜」加入购物清单！', 'success');

    // OTHER/无展示单位：不得生成裸「1」，按自由规格「适量」写入
    close.mockClear();
    toast.mockClear();
    fetchMock.mockResolvedValueOnce(
      shoppingJson(shoppingListDto(3, [shoppingItemDto({ ingredientNameSnapshot: '散装', amountText: '适量' })]))
    );
    await pantry.addToShopping('i2');
    const otherCall = fetchMock.mock.calls.at(-1);
    expect(otherCall[1].method).toBe('POST');
    expect(JSON.parse(otherCall[1].body)).toEqual({
      version: 3,
      ingredientName: '散装',
      quantity: null,
      unit: null,
      amountText: '适量',
      category: '其他',
      sourceType: 'MANUAL',
      sourceId: null,
      completed: false
    });
    expect(close).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('已将「散装」加入购物清单！', 'success');
  });

  const planDto = (overrides: Record<string, unknown> = {}) => ({
    id: 'p1',
    planDate: '2026-10-01',
    mealType: 'DINNER',
    dinerCount: 2,
    status: 'PLANNED',
    notes: null,
    version: 1,
    items: [
      {
        itemType: 'RECIPE',
        recipeId: 'r1',
        storeId: null,
        customName: null,
        sortOrder: 0,
        recipe: { id: 'r1', name: '红烧肉', imagePath: null },
        store: null
      }
    ],
    ...overrides
  });
  const recordDto = (overrides: Record<string, unknown> = {}) => ({
    id: 'rec1',
    recordDate: '2026-09-28',
    recordTime: null,
    mealType: 'LUNCH',
    sourceType: 'HOMEMADE',
    status: 'CONFIRMED',
    imagePath: null,
    rating: 4.5,
    isNewTry: false,
    favorite: false,
    notes: '好吃',
    relatedPlanId: null,
    version: 2,
    items: [
      {
        itemType: 'CUSTOM',
        recipeId: null,
        storeId: null,
        customName: '燕麦粥',
        sortOrder: 0,
        recipe: null,
        store: null
      }
    ],
    ...overrides
  });
  const toolDto = (overrides: Record<string, unknown> = {}) => ({
    id: 't1',
    name: '电炖锅',
    icon: null,
    category: '慢炖',
    quantity: 1,
    status: '状态良好',
    notes: '适合煲汤',
    version: 1,
    ...overrides
  });
  const arrayJson = (data: unknown) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ success: true, data })
  });

  it('plans reload 数组直返单请求、DTO 推导目标字段，旧响应不能覆盖后发的新响应', async () => {
    const changed = vi.fn();
    (window as any).BentoBus = { emit: changed };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const plans: any = { data: [{ id: 'old' }] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, plans };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    const stale = deferred<any>();
    const fresh = deferred<any>();
    fetchMock.mockImplementation((_url: string) => (fetchMock.mock.calls.length === 1 ? stale.promise : fresh.promise));
    const reload = (window as any).DafanDomainAdapter.replacePlanService(plans);
    const first = reload();
    await Promise.resolve();
    const second = reload();
    fresh.resolve(arrayJson([planDto()]));
    await second;
    stale.resolve(arrayJson([planDto({ id: 'stale', planDate: '2026-01-01', version: 9, items: [] })]));
    await first;
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/plans', '/api/v1/plans']);
    expect(plans.data).toHaveLength(1);
    expect(plans.data[0]).toMatchObject({
      id: 'p1',
      date: '2026-10-01',
      slot: '晚餐',
      time: null,
      isCompleted: false,
      targetType: 'recipe',
      channel: 'cook',
      targetId: 'r1',
      title: null,
      icon: null,
      version: 1
    });
    expect(changed).toHaveBeenCalledWith('plans:changed');

    fetchMock.mockResolvedValueOnce(
      arrayJson([
        planDto({
          status: 'COMPLETED',
          items: [
            {
              itemType: 'STORE',
              recipeId: null,
              storeId: 's1',
              customName: null,
              sortOrder: 0,
              recipe: null,
              store: { id: 's1', name: '老店', imagePath: '/store.jpg', supportsTakeout: false, supportsDineIn: true }
            }
          ]
        })
      ])
    );
    await reload();
    expect(plans.data[0]).toMatchObject({
      isCompleted: true,
      targetType: 'store',
      channel: 'dinein',
      targetId: 's1',
      title: null,
      icon: null
    });
  });

  it('plans add/update/delete 发送精确请求并串联 version，餐次或目标不可映射时 422 阻断', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const plans: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, plans };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replacePlanService(plans);
    plans.data = [(window as any).DafanDomainAdapter.mapPlan(planDto({ version: 1 }))];

    fetchMock.mockResolvedValueOnce(arrayJson(planDto({ id: 'p2', planDate: '2026-10-02', mealType: 'LUNCH' })));
    await plans.add({
      date: '2026-10-02',
      slot: '午餐',
      targetType: 'recipe',
      targetId: 'r1',
      id: 'plan-local',
      random: 1
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/plans');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      planDate: '2026-10-02',
      mealType: 'LUNCH',
      dinerCount: 1,
      time: null,
      title: null,
      subtext: null,
      icon: null,
      items: [{ itemType: 'RECIPE', recipeId: 'r1', sortOrder: 0 }]
    });
    expect(plans.data[0]).toMatchObject({ id: 'p2', slot: '午餐' });

    fetchMock.mockResolvedValueOnce(
      arrayJson(
        planDto({
          planDate: '2026-10-03',
          mealType: 'DINNER',
          version: 2,
          items: [
            {
              itemType: 'STORE',
              recipeId: null,
              storeId: 's1',
              customName: null,
              sortOrder: 0,
              recipe: null,
              store: { id: 's1', name: '老店', imagePath: '/store.jpg', supportsTakeout: true, supportsDineIn: false }
            }
          ]
        })
      )
    );
    await plans.update('p1', { date: '2026-10-03', slot: '晚餐', targetType: 'store', targetId: 's1' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/plans/p1');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    // E11：编辑计划保留既有 dinerCount（fixture=2），绝不硬覆盖回 1
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      version: 1,
      planDate: '2026-10-03',
      mealType: 'DINNER',
      time: null,
      title: null,
      subtext: null,
      icon: null,
      dinerCount: 2,
      items: [{ itemType: 'STORE', storeId: 's1', sortOrder: 0 }]
    });

    fetchMock.mockResolvedValueOnce(arrayJson({ id: 'p1' }));
    await plans.delete('p1');
    const deleteCall = fetchMock.mock.calls[2];
    expect(deleteCall[0]).toBe('/api/v1/plans/p1?version=2');
    expect(deleteCall[1].method).toBe('DELETE');
    expect(deleteCall[1].body).toBeUndefined();
    expect(plans.data.map((x: any) => x.id)).toEqual(['p2']);

    await expect(
      plans.add({ date: '2026-10-02', slot: '夜宵', targetType: 'recipe', targetId: 'r1' })
    ).rejects.toMatchObject({ code: 'PLAN_MEAL_TYPE_UNSUPPORTED' });
    await expect(plans.add({ date: '2026-10-02', slot: '午餐' })).rejects.toMatchObject({
      code: 'PLAN_TARGET_UNSUPPORTED'
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('plans checkin 映射 complete 端点并联动 records 域写入 DRAFT 记录，幂等完成不重复插入', async () => {
    const changed = vi.fn();
    (window as any).BentoBus = { emit: changed };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const plans: any = { data: [] };
    const records: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, plans, records };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replacePlanService(plans);
    (window as any).DafanDomainAdapter.replaceRecordService(records);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    plans.data = [(window as any).DafanDomainAdapter.mapPlan(planDto({ version: 2 }))];

    fetchMock.mockResolvedValueOnce(
      arrayJson({
        plan: planDto({ status: 'COMPLETED', version: 3 }),
        record: recordDto({ id: 'rec-plan', status: 'DRAFT', rating: null, notes: null, version: 1 }),
        idempotent: false,
        inventoryDeductionPromptEnabled: false
      })
    );
    await plans.checkin('p1');
    const call = fetchMock.mock.calls.at(-1);
    expect(call[0]).toBe('/api/v1/plans/p1/complete');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({ version: 2 });
    expect(plans.data[0]).toMatchObject({ id: 'p1', isCompleted: true, version: 3 });
    expect(records.data.map((x: any) => x.id)).toEqual(['rec-plan']);
    expect(records.data[0]).toMatchObject({ date: '2026-09-28', slot: '午餐', type: '自烹', title: '燕麦粥' });
    expect(changed).toHaveBeenCalledWith('plans:changed');
    expect(changed).toHaveBeenCalledWith('records:changed');
    expect(toast).toHaveBeenCalledWith('打卡成功！已生成待确认就餐草稿（确认后计入统计）', 'success');

    fetchMock.mockResolvedValueOnce(
      arrayJson({
        plan: planDto({ status: 'COMPLETED', version: 3 }),
        record: recordDto({ id: 'rec-plan', status: 'DRAFT', rating: null, notes: null, version: 1 }),
        idempotent: true,
        inventoryDeductionPromptEnabled: false
      })
    );
    plans.data = [(window as any).DafanDomainAdapter.mapPlan(planDto({ version: 2 }))];
    await plans.checkin('p1');
    expect(records.data.map((x: any) => x.id)).toEqual(['rec-plan']);
    expect(toast).toHaveBeenLastCalledWith('打卡成功！已恢复待确认就餐草稿（确认后计入统计）', 'success');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(
      arrayJson({
        plan: planDto({ status: 'PLANNED', version: 4 }),
        removedRecord: { id: 'rec-plan' },
        idempotent: false
      })
    );
    const uncheckin = plans.uncheckin('p1');
    expect(uncheckin).toBeInstanceOf(Promise);
    await uncheckin;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockResolvedValueOnce(
      arrayJson({
        plan: planDto({ status: 'COMPLETED', version: 5 }),
        record: recordDto({ id: 'rec-plan-2', status: 'DRAFT', version: 1 }),
        idempotent: false,
        inventoryDeductionPromptEnabled: false
      })
    );
    await plans.toggleCheckin('p1');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('plans checkin 幂等返回已确认记录时诚实提示已确认用餐，不宣称新生成', async () => {
    const changed = vi.fn();
    (window as any).BentoBus = { emit: changed };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const plans: any = { data: [] };
    const records: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, plans, records };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replacePlanService(plans);
    (window as any).DafanDomainAdapter.replaceRecordService(records);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    plans.data = [(window as any).DafanDomainAdapter.mapPlan(planDto({ version: 2 }))];

    fetchMock.mockResolvedValueOnce(
      arrayJson({
        plan: planDto({ status: 'COMPLETED', version: 3 }),
        record: recordDto({
          id: 'rec-plan',
          status: 'CONFIRMED',
          confirmedAt: '2026-10-01T04:00:00.000Z',
          version: 2
        }),
        idempotent: true,
        inventoryDeductionPromptEnabled: false
      })
    );
    await plans.checkin('p1');
    expect(toast).toHaveBeenLastCalledWith('该计划已确认用餐，无需重复打卡', 'success');
    expect(records.data[0]).toMatchObject({
      id: 'rec-plan',
      status: 'CONFIRMED',
      isDraft: false,
      confirmedAt: '2026-10-01T04:00:00.000Z'
    });
  });

  it('mapRecord 规范映射 status/sourceMealPlanId/relatedPlanId/confirmedAt，缺失状态按已确认', () => {
    const mapped = (window as any).DafanDomainAdapter.mapRecord(
      recordDto({ status: 'DRAFT', sourceMealPlanId: 'p1', relatedPlanId: 'p1', confirmedAt: null })
    );
    expect(mapped).toMatchObject({
      status: 'DRAFT',
      isDraft: true,
      sourceMealPlanId: 'p1',
      relatedPlanId: 'p1',
      confirmedAt: null
    });
    const legacy = (window as any).DafanDomainAdapter.mapRecord({
      id: 'legacy',
      recordDate: '2026-10-01',
      mealType: 'LUNCH',
      sourceType: 'HOMEMADE',
      version: 1,
      items: []
    });
    expect(legacy).toMatchObject({
      status: 'CONFIRMED',
      isDraft: false,
      sourceMealPlanId: null,
      relatedPlanId: null,
      confirmedAt: null
    });
  });

  it.each([
    {
      status: 400,
      code: 'VALIDATION_ERROR',
      method: 'add',
      input: { date: '2026-10-02', slot: '午餐', targetType: 'recipe', targetId: 'r1' },
      expectedMethod: 'POST',
      expectedPath: '/api/v1/plans'
    },
    {
      status: 404,
      code: 'NOT_FOUND',
      method: 'delete',
      input: 'p1',
      expectedMethod: 'DELETE',
      expectedPath: '/api/v1/plans/p1?version=1'
    },
    {
      status: 409,
      code: 'VERSION_CONFLICT',
      method: 'update',
      input: { date: '2026-10-05', slot: '午餐', targetType: 'recipe', targetId: 'r1' },
      expectedMethod: 'PUT',
      expectedPath: '/api/v1/plans/p1'
    },
    {
      status: 503,
      code: 'MAINTENANCE',
      method: 'checkin',
      input: 'p1',
      expectedMethod: 'POST',
      expectedPath: '/api/v1/plans/p1/complete'
    }
  ])('plans 写失败 $status $code 传播状态并保持 service、modal 与 toast 不变', async (caseData) => {
    const fetchMock = vi.fn().mockResolvedValue(arrayJson([]));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    const close = vi.fn();
    (window as any).showToast = toast;
    (window as any).BentoModal = { close };
    const plans: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, plans };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replacePlanService(plans);
    plans.data = [(window as any).DafanDomainAdapter.mapPlan(planDto())];
    const before = structuredClone(plans.data);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: caseData.status,
      text: async () => JSON.stringify({ success: false, error: { code: caseData.code, message: '写入失败' } })
    });
    await expect(
      caseData.method === 'update'
        ? plans[caseData.method]('p1', caseData.input)
        : plans[caseData.method](caseData.input)
    ).rejects.toMatchObject({
      status: caseData.status,
      code: caseData.code
    });
    expect(plans.data).toEqual(before);
    expect(close).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    const call = fetchMock.mock.calls.at(-1);
    expect(call[0]).toBe(caseData.expectedPath);
    expect(call[1].method).toBe(caseData.expectedMethod);
  });

  it('records reload 分页聚合、DTO 映射与 records:changed，旧响应不能覆盖后发的新响应', async () => {
    const changed = vi.fn();
    (window as any).BentoBus = { emit: changed };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const records: any = { data: [{ id: 'old' }] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, records };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    const stale1 = deferred<any>();
    const stale2 = deferred<any>();
    const fresh = deferred<any>();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('page=1') && fetchMock.mock.calls.length === 1) return stale1.promise;
      if (String(url).includes('page=2')) return stale2.promise;
      return fresh.promise;
    });
    const reload = (window as any).DafanDomainAdapter.replaceRecordService(records);
    const first = reload();
    await Promise.resolve();
    const second = reload();
    fresh.resolve(
      arrayJson({
        items: [
          recordDto(),
          recordDto({
            id: 'rec2',
            recordDate: '2026-09-27',
            mealType: 'DINNER',
            sourceType: 'TAKEOUT',
            status: 'DRAFT',
            imagePath: '/p2.jpg',
            items: []
          })
        ],
        page: 1,
        pageSize: 100,
        total: 2,
        totalPages: 1
      })
    );
    await second;
    stale1.resolve(arrayJson({ items: [recordDto({ id: 'stale' })], totalPages: 2 }));
    stale2.resolve(arrayJson({ items: [recordDto({ id: 'stale-2' })] }));
    await first;
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/records?page=1&pageSize=100',
      '/api/v1/records?page=1&pageSize=100',
      '/api/v1/records?page=2&pageSize=100'
    ]);
    expect(records.data).toHaveLength(2);
    expect(records.data[0]).toMatchObject({
      id: 'rec1',
      date: '2026-09-28',
      slot: '午餐',
      type: '自烹',
      icon: '🍳',
      title: '燕麦粥',
      // VAN-32：后端 nullable 营养字段原样映射，DTO 无值就是 null（不再伪造成 ''/undefined）
      calories: null,
      satiety: null,
      cost: null,
      rating: 4.5,
      notes: '好吃',
      photos: [],
      version: 2
    });
    expect(records.data[1]).toMatchObject({ id: 'rec2', type: '外卖', icon: '🛵', title: '', photos: ['/p2.jpg'] });
    expect(changed).toHaveBeenCalledWith('records:changed');
  });

  it('records add 发送精确请求且无本地 id/date；非法 nullable 值或不可映射枚举 422 阻断', async () => {
    const changed = vi.fn();
    (window as any).BentoBus = { emit: changed };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const records: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, records };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replaceRecordService(records);

    fetchMock.mockResolvedValueOnce(
      arrayJson(
        recordDto({ imagePath: '/new.jpg', id: 'rec-new', version: 1, mealType: 'BREAKFAST', sourceType: 'DINE_IN' })
      )
    );
    await records.add({
      slot: '早餐',
      type: '堂食',
      title: '豆浆油条',
      calories: '',
      cost: '',
      satiety: '',
      rating: 5,
      notes: '',
      photos: ['/new.jpg', '/extra.jpg'],
      id: 'rec-local',
      random: 1
    });
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('/api/v1/records');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({
      recordDate: localDateKey(0),
      mealType: 'BREAKFAST',
      sourceType: 'DINE_IN',
      rating: 5,
      // VAN-32：calories/cost/satiety 已是正式可写字段，空值显式传 null（不默认 550/0/8，也不省略）
      calories: null,
      cost: null,
      satiety: null,
      notes: null,
      imagePath: '/new.jpg',
      photos: ['/new.jpg', '/extra.jpg'],
      title: '豆浆油条',
      items: [{ itemType: 'CUSTOM', customName: '豆浆油条', sortOrder: 0 }]
    });
    expect(records.data[0]).toMatchObject({ id: 'rec-new', type: '堂食', icon: '🍽️' });
    expect(changed).toHaveBeenCalledWith('records:changed');

    // 越界/非整数热量、非法消费、非正式档位饱腹：快速失败且不发请求（不再有 "字段不支持" 的假阻断）
    await expect(records.add({ slot: '午餐', type: '自烹', title: 'x', calories: '12abc' })).rejects.toMatchObject({
      code: 'RECORD_CALORIES_INVALID'
    });
    await expect(records.add({ slot: '午餐', type: '自烹', title: 'x', cost: '-1' })).rejects.toMatchObject({
      code: 'RECORD_COST_INVALID'
    });
    await expect(records.add({ slot: '午餐', type: '自烹', title: 'x', satiety: '8.5' })).rejects.toMatchObject({
      code: 'RECORD_SATIETY_INVALID'
    });
    await expect(records.add({ slot: '午餐', type: '自烹', title: 'x', satiety: 4 })).rejects.toMatchObject({
      code: 'RECORD_SATIETY_INVALID'
    });
    await expect(records.add({ slot: '夜宵', type: '自烹', title: 'x' })).rejects.toMatchObject({
      code: 'RECORD_MEAL_TYPE_UNSUPPORTED'
    });
    await expect(records.add({ slot: '午餐', type: '下午茶', title: 'x' })).rejects.toMatchObject({
      code: 'RECORD_SOURCE_TYPE_UNSUPPORTED'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(records.data).toHaveLength(1);
  });

  it('records update 发送精确请求并串联 version，photos 为空不覆盖后端照片', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const records: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, records };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replaceRecordService(records);
    records.data = [(window as any).DafanDomainAdapter.mapRecord(recordDto({ imagePath: '/old.jpg' }))];

    fetchMock.mockResolvedValueOnce(
      arrayJson(recordDto({ mealType: 'DINNER', sourceType: 'TAKEOUT', rating: 3, notes: '改', version: 3 }))
    );
    await records.update('rec1', {
      slot: '晚餐',
      type: '外卖',
      title: '新标题',
      rating: 3,
      notes: '改',
      photos: [],
      calories: '',
      cost: '',
      satiety: ''
    });
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('/api/v1/records/rec1');
    expect(call[1].method).toBe('PUT');
    // 空字符串是显式“未填写” → 真实送 null（后端据此 clear），而不是被拒绝或被省略成保留旧值
    expect(JSON.parse(call[1].body)).toEqual({
      version: 2,
      mealType: 'DINNER',
      sourceType: 'TAKEOUT',
      title: '新标题',
      photos: [],
      imagePath: null,
      rating: 3,
      notes: '改',
      calories: null,
      cost: null,
      satiety: null
    });
    expect(records.data[0]).toMatchObject({ slot: '晚餐', type: '外卖' });

    fetchMock.mockResolvedValueOnce(arrayJson(recordDto({ version: 4 })));
    await records.update('rec1', {
      photos: ['/replace.jpg'],
      title: '再改',
      slot: '',
      type: '',
      rating: undefined,
      notes: undefined
    });
    expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body)).toMatchObject({ version: 3, imagePath: '/replace.jpg' });

    // 非法值快速失败；省略字段不发送（保留后端现值）
    await expect(records.update('rec1', { calories: '500.5', slot: '', type: '' })).rejects.toMatchObject({
      code: 'RECORD_CALORIES_INVALID'
    });
    await expect(records.update('rec1', { satiety: '12' })).rejects.toMatchObject({ code: 'RECORD_SATIETY_INVALID' });
    const callsBefore = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValueOnce(arrayJson(recordDto({ version: 5 })));
    await records.update('rec1', { title: '只改标题' });
    const lastBody = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(lastBody).not.toHaveProperty('calories');
    expect(lastBody).not.toHaveProperty('satiety');
    expect(lastBody).not.toHaveProperty('cost');
    // 两次非法输入没有产生任何请求，只有最后这次合法的“只改标题”多了一次
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1);
  });

  it.each([
    {
      status: 400,
      code: 'VALIDATION_ERROR',
      method: 'add',
      input: { slot: '午餐', type: '自烹', title: '记录', calories: '', cost: '', satiety: '' },
      expectedMethod: 'POST',
      expectedPath: '/api/v1/records'
    },
    {
      status: 404,
      code: 'NOT_FOUND',
      method: 'delete',
      input: 'rec1',
      expectedMethod: 'DELETE',
      expectedPath: '/api/v1/records/rec1?version=2'
    },
    {
      status: 409,
      code: 'VERSION_CONFLICT',
      method: 'update',
      input: { slot: '晚餐', type: '外卖', title: '改', calories: '', cost: '', satiety: '' },
      expectedMethod: 'PUT',
      expectedPath: '/api/v1/records/rec1'
    },
    {
      status: 503,
      code: 'MAINTENANCE',
      method: 'delete',
      input: 'rec1',
      expectedMethod: 'DELETE',
      expectedPath: '/api/v1/records/rec1?version=2'
    }
  ])('records 写失败 $status $code 传播状态并保持 service、modal 与 toast 不变', async (caseData) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(arrayJson({ items: [recordDto()], page: 1, pageSize: 100, total: 1, totalPages: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    const close = vi.fn();
    (window as any).showToast = toast;
    (window as any).BentoModal = { close };
    const records: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, records };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replaceRecordService(records);
    records.data = [(window as any).DafanDomainAdapter.mapRecord(recordDto())];
    const before = structuredClone(records.data);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: caseData.status,
      text: async () => JSON.stringify({ success: false, error: { code: caseData.code, message: '写入失败' } })
    });
    await expect(
      caseData.method === 'update'
        ? records[caseData.method]('rec1', caseData.input)
        : records[caseData.method](caseData.input)
    ).rejects.toMatchObject({
      status: caseData.status,
      code: caseData.code
    });
    expect(records.data).toEqual(before);
    expect(close).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    const call = fetchMock.mock.calls.at(-1);
    expect(call[0]).toBe(caseData.expectedPath);
    expect(call[1].method).toBe(caseData.expectedMethod);
  });

  it('records confirm 按 id 去重、携带 version、成功后 upsert 缓存并诚实提示', async () => {
    const changed = vi.fn();
    (window as any).BentoBus = { emit: changed };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const records: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, records };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replaceRecordService(records);
    records.data = [
      (window as any).DafanDomainAdapter.mapRecord(
        recordDto({ id: 'rec1', status: 'DRAFT', version: 2, sourceMealPlanId: 'p1', relatedPlanId: 'p1' })
      )
    ];

    fetchMock.mockResolvedValueOnce(
      arrayJson(
        recordDto({
          id: 'rec1',
          status: 'CONFIRMED',
          version: 3,
          sourceMealPlanId: 'p1',
          relatedPlanId: 'p1',
          confirmedAt: '2026-10-01T04:00:00.000Z'
        })
      )
    );
    const first = records.confirm('rec1');
    const second = records.confirm('rec1');
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('/api/v1/records/rec1/confirm');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({ version: 2 });
    expect(records.data).toHaveLength(1);
    expect(records.data[0]).toMatchObject({
      id: 'rec1',
      status: 'CONFIRMED',
      isDraft: false,
      version: 3,
      confirmedAt: '2026-10-01T04:00:00.000Z'
    });
    expect(changed).toHaveBeenCalledWith('records:changed');
    expect(toast).toHaveBeenCalledWith('已确认用餐，已计入日历与统计', 'success');
  });

  it('records confirm 409 拉取单条有效实体自愈缓存，并保留原始错误', async () => {
    const changed = vi.fn();
    (window as any).BentoBus = { emit: changed };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const records: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, records };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replaceRecordService(records);
    records.data = [
      (window as any).DafanDomainAdapter.mapRecord(recordDto({ id: 'rec1', status: 'DRAFT', version: 2 }))
    ];

    toast.mockClear();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ success: false, error: { code: 'VERSION_CONFLICT', message: '版本冲突' } })
      })
      .mockResolvedValueOnce(arrayJson(recordDto({ id: 'rec1', status: 'CONFIRMED', version: 4 })));
    const error = await records.confirm('rec1').catch((reason: any) => reason);
    expect(error).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    // 按钮层按同一字段名跳过重复提示，同时仍拿到原始 409 错误对象
    expect(error.__dafanRecordConfirmNotified).toBe(true);
    expect(fetchMock.mock.calls.map(([url]: any[]) => url)).toEqual([
      '/api/v1/records/rec1/confirm',
      '/api/v1/records/rec1'
    ]);
    expect(records.data[0]).toMatchObject({ id: 'rec1', status: 'CONFIRMED', version: 4 });
    expect(changed).toHaveBeenCalledWith('records:changed');
    expect(changed.mock.calls.filter(([name]: any[]) => name === 'dashboard:dirty')).toHaveLength(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('记录已被修改或已确认，已同步最新状态，请刷新查看', 'error');
  });

  it('records confirm 409 兜底响应非有效实体时保留原缓存，不覆盖为 {items:[],total:0}', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const records: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, records };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replaceRecordService(records);
    records.data = [
      (window as any).DafanDomainAdapter.mapRecord(recordDto({ id: 'rec1', status: 'DRAFT', version: 2 }))
    ];
    const cached = records.data[0];

    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ success: false, error: { code: 'VERSION_CONFLICT', message: '版本冲突' } })
      })
      .mockResolvedValueOnce(arrayJson({ items: [], total: 0 }));
    await expect(records.confirm('rec1')).rejects.toMatchObject({ status: 409 });
    expect(records.data[0]).toBe(cached);
    expect(toast).toHaveBeenCalledWith('记录已被修改，未能同步最新状态，请刷新后重试', 'error');
  });

  it('records confirm 未 await 时的失败仍可见且不产生 unhandled rejection', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const records: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, records };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replaceRecordService(records);
    records.data = [
      (window as any).DafanDomainAdapter.mapRecord(recordDto({ id: 'rec1', status: 'DRAFT', version: 2 }))
    ];
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener('unhandledrejection', onUnhandled);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ success: false, error: { code: 'MAINTENANCE', message: '服务维护中' } })
    });
    records.confirm('rec1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(toast).toHaveBeenCalledWith('服务维护中', 'error');
    expect(unhandled).toHaveLength(0);
    window.removeEventListener('unhandledrejection', onUnhandled);
  });

  it('plans/records 写方法成功均标记首页脏，非首页时只置脏不发 dashboard 请求', async () => {
    const events: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const method = init?.method || 'GET';
      if (path.includes('/dashboard')) return arrayJson({});
      if (path === '/api/v1/plans' && method === 'POST') return arrayJson(planDto({ id: 'p-new', version: 1 }));
      if (path === '/api/v1/plans/p-new') return arrayJson(planDto({ id: 'p-new', version: 2 }));
      if (path === '/api/v1/records' && method === 'POST') return arrayJson(recordDto({ id: 'rec-new', version: 1 }));
      if (path === '/api/v1/records/rec-new' && method === 'PUT')
        return arrayJson(recordDto({ id: 'rec-new', version: 2 }));
      if (path === '/api/v1/records/rec-new/confirm')
        return arrayJson(recordDto({ id: 'rec-new', version: 3, confirmedAt: '2026-10-01T04:00:00.000Z' }));
      return arrayJson([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    (window as any).showToast = vi.fn();
    (window as any).BentoBus = { emit: (name: string) => events.push(name), on: vi.fn() };
    (window as any).BentoService = {
      stores: { data: [] },
      recipes: { data: [] },
      plans: { data: [] },
      records: { data: [] }
    };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((window as any).DafanDashboardAdapter.isHomeVisible()).toBe(false);
    fetchMock.mockClear();
    events.length = 0;
    const service = (window as any).BentoService;

    await service.plans.add({ date: '2026-10-02', slot: '午餐', targetType: 'recipe', targetId: 'r1' });
    await service.plans.update('p-new', { date: '2026-10-03', slot: '晚餐', targetType: 'recipe', targetId: 'r1' });
    await service.records.add({ slot: '午餐', type: '自烹', title: '记录' });
    await service.records.update('rec-new', { title: '改' });
    await service.records.confirm('rec-new');
    expect(events.filter((name) => name === 'dashboard:dirty')).toHaveLength(5);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/dashboard'))).toHaveLength(0);
  });

  it('legacy record 表单真实 submit：空营养字段送 null 后提交并关闭 Modal', async () => {
    document.body.innerHTML = `<form><input id="formRecordId" value=""><select id="formRecordSlot"><option selected>午餐</option></select><select id="formRecordType"><option selected>自烹</option></select><input id="formRecordTitle" value="手冲咖啡配贝果"><input id="formRecordCalories" value=""><input id="formRecordCost" value=""><select id="formRecordSatiety"><option value="10">10</option><option value="8">8</option><option value="7">7</option><option value="5">5</option><option value="3">3</option></select><input id="formRecordRating" value="5"><textarea id="formRecordNotes">好</textarea><div id="photoSlotView-0"><img src="/uploads/slot0.jpg"></div></form>`;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    const close = vi.fn();
    (window as any).showToast = toast;
    const modal: any = { open: vi.fn(), close, handleRecordFormSubmit: vi.fn() };
    (window as any).BentoModal = modal;
    const records: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, records };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replaceRecordService(records);
    (document.getElementById('formRecordSatiety') as HTMLSelectElement).selectedIndex = -1;
    const button = document.createElement('button');
    document.querySelector('form')!.append(button);

    fetchMock.mockResolvedValueOnce(arrayJson(recordDto({ id: 'rec-form', version: 1 })));
    await modal.handleRecordFormSubmit({ preventDefault: vi.fn(), submitter: button });
    const submitCall = fetchMock.mock.calls.find(([url]) => url === '/api/v1/records');
    expect(submitCall?.[1].method).toBe('POST');
    expect(JSON.parse(submitCall?.[1].body)).toEqual({
      recordDate: localDateKey(0),
      mealType: 'LUNCH',
      sourceType: 'HOMEMADE',
      rating: 5,
      // 未选择的饱腹/未填的热量与花费都是真实 null，不写 550/0/8 演示默认
      calories: null,
      cost: null,
      satiety: null,
      notes: '好',
      imagePath: '/uploads/slot0.jpg',
      photos: ['/uploads/slot0.jpg'],
      title: '手冲咖啡配贝果',
      items: [{ itemType: 'CUSTOM', customName: '手冲咖啡配贝果', sortOrder: 0 }]
    });
    expect(close).toHaveBeenCalledWith(true);
    expect(button.disabled).toBe(false);
    expect(records.data[0]).toMatchObject({ id: 'rec-form' });

    // 真实 number 命中正式契约：正常提交并再次关闭 Modal，不再被 422 阻断
    fetchMock.mockResolvedValueOnce(arrayJson(recordDto({ id: 'rec-form', version: 2 })));
    (document.querySelector('#formRecordCalories') as HTMLInputElement).value = '550';
    (document.querySelector('#formRecordSatiety') as HTMLSelectElement).value = '8';
    const callsAfterSuccess = fetchMock.mock.calls.length;
    await modal.handleRecordFormSubmit({ preventDefault: vi.fn(), submitter: button });
    expect(fetchMock.mock.calls.length).toBe(callsAfterSuccess + 1);
    const secondBody = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(secondBody).toMatchObject({ calories: 550, satiety: 8 });
    expect(close).toHaveBeenCalledTimes(2);
    expect(button.disabled).toBe(false);
  });

  it('tools reload 数组直返单请求、DTO 映射与 tools:changed，旧响应不能覆盖后发的新响应', async () => {
    const changed = vi.fn();
    (window as any).BentoBus = { emit: changed };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const tools: any = { data: [{ id: 'old' }] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, tools };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    const stale = deferred<any>();
    const fresh = deferred<any>();
    fetchMock.mockImplementation((_url: string) => (fetchMock.mock.calls.length === 1 ? stale.promise : fresh.promise));
    const reload = (window as any).DafanDomainAdapter.replaceToolService(tools);
    const first = reload();
    await Promise.resolve();
    const second = reload();
    fresh.resolve(
      arrayJson([toolDto(), toolDto({ id: 't2', name: '', icon: '/pan.jpg', category: '快炒', version: 3 })])
    );
    await second;
    stale.resolve(arrayJson([toolDto({ id: 'stale' })]));
    await first;
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/tools', '/api/v1/tools']);
    expect(tools.data).toHaveLength(2);
    expect(tools.data[0]).toMatchObject({ id: 't1', name: '电炖锅', icon: null, version: 1 });
    expect(tools.data[1]).toMatchObject({ id: 't2', icon: '/pan.jpg', version: 3 });
    expect(changed).toHaveBeenCalledWith('tools:changed');
  });

  it('tools save/delete 发送精确请求并串联 version，请求体无本地 id/icon', async () => {
    const changed = vi.fn();
    (window as any).BentoBus = { emit: changed };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const tools: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, tools };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replaceToolService(tools);

    fetchMock.mockResolvedValueOnce(arrayJson(toolDto({ id: 't9', name: '华夫饼机', icon: '🍲', category: '烘烤' })));
    await tools.save({
      name: '华夫饼机',
      icon: '♨',
      category: '烘烤',
      status: '状态良好',
      notes: '新购入',
      id: 'tool-local',
      random: 1,
      date: 'today'
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/tools');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: '华夫饼机',
      icon: '♨',
      category: '烘烤',
      status: '状态良好',
      notes: '新购入'
    });
    expect(tools.data[0]).toMatchObject({ id: 't9', icon: '🍲' });
    expect(toast).toHaveBeenCalledWith('设备「华夫饼机」已成功收录！', 'success');

    fetchMock.mockResolvedValueOnce(
      arrayJson(toolDto({ id: 't9', name: '华夫饼机改', version: 2, status: '需要养护' }))
    );
    await tools.save({ id: 't9', name: '华夫饼机改', icon: '♨', category: '烘烤', status: '需要养护', notes: '' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/tools/t9');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      name: '华夫饼机改',
      icon: '♨',
      category: '烘烤',
      status: '需要养护',
      notes: null,
      version: 1
    });
    expect(tools.data[0]).toMatchObject({ name: '华夫饼机改', version: 2 });

    fetchMock.mockResolvedValueOnce(arrayJson({ id: 't9', deleted: true }));
    await tools.delete('t9');
    const deleteCall = fetchMock.mock.calls[2];
    expect(deleteCall[0]).toBe('/api/v1/tools/t9?version=2');
    expect(deleteCall[1].method).toBe('DELETE');
    expect(deleteCall[1].body).toBeUndefined();
    expect(tools.data).toEqual([]);
    expect(changed).toHaveBeenCalledWith('tools:changed');
  });

  it('mochi_tools localStorage mock 存储失效：boot 后不再读取，save/delete 不再写入', async () => {
    const mockStore = JSON.stringify([{ id: 'mock-tool', name: '旧设备', icon: '🍳' }]);
    localStorage.setItem('mochi_tools', mockStore);
    const emptyPagination = () => arrayJson({ items: [], totalPages: 1 });
    const fetchMock = vi.fn((url: string) => {
      if (String(url).endsWith('/tools')) return Promise.resolve(arrayJson([]));
      if (String(url).includes('/shopping-lists')) return Promise.resolve(arrayJson([]));
      if (String(url).endsWith('/plans')) return Promise.resolve(arrayJson([]));
      if (String(url).includes('/records?page=')) return Promise.resolve(emptyPagination());
      if (String(url).includes('/stores?page=') || String(url).includes('/recipes?page='))
        return Promise.resolve(emptyPagination());
      if (String(url).includes('/ingredients?page=')) return Promise.resolve(emptyPagination());
      return Promise.resolve(
        arrayJson({
          branding: {},
          todayRecords: [],
          recommendedRecipes: [],
          inventory: {},
          weeklyStats: {},
          calendarDays: [],
          tip: ''
        })
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    document.body.innerHTML = '<div id="toolsCardGrid"></div><div id="toolsCountBadge"></div>';
    const toolGetAll = vi.fn(() => ['must not be served']);
    const toolSave = vi.fn();
    const toolDelete = vi.fn();
    (window as any).BentoService = {
      stores: { data: [{ id: 'mock' }] },
      recipes: { data: [{ id: 'mock' }] },
      pantry: { data: [{ id: 'mock' }] },
      shopping: { data: [{ id: 'mock' }] },
      plans: { data: [{ id: 'mock' }] },
      records: { data: [{ id: 'mock' }] },
      tools: { data: [{ id: 'mock-tool' }], getAll: toolGetAll, save: toolSave, delete: toolDelete }
    };
    window.eval(adapter);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const tools = (window as any).BentoService.tools;
    expect(tools.data).toEqual([]);
    expect(tools.getAll()).toEqual([]);
    expect(toolGetAll).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(arrayJson(toolDto({ id: 't-new', name: '新锅' })));
    await tools.save({ name: '新锅', icon: '🍲', category: '慢炖', status: '状态良好', notes: '' });
    const saveCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/v1/tools');
    const saveCall = saveCalls.at(-1);
    expect(saveCall?.[1].method).toBe('POST');
    expect(JSON.parse(saveCall?.[1].body)).not.toHaveProperty('id');
    expect(JSON.parse(saveCall?.[1].body)).toHaveProperty('icon', '🍲');
    expect(localStorage.getItem('mochi_tools')).toBe(mockStore);
    expect(toolSave).not.toHaveBeenCalled();

    tools.data = [(window as any).DafanDomainAdapter.mapTool(toolDto())];
    fetchMock.mockResolvedValueOnce(arrayJson({ id: 't1', deleted: true }));
    await tools.delete('t1');
    expect(localStorage.getItem('mochi_tools')).toBe(mockStore);
    expect(toolDelete).not.toHaveBeenCalled();
  });

  it('legacy tool 表单真实 submit：无本地 id、成功关闭 Modal 并恢复按钮', async () => {
    document.body.innerHTML = `<form><input id="formToolName" value="空气炸锅"><select id="formToolIcon"><option selected value="♨">♨</option></select><select id="formToolCategory"><option selected>烘烤</option></select><select id="formToolStatus"><option selected>状态良好</option></select><textarea id="formToolNotes">刚到手</textarea></form>`;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const close = vi.fn();
    (window as any).BentoModal = { open: vi.fn(), close };
    const tools: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, tools };
    window.handleToolFormSubmit = vi.fn();
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    (window as any).DafanDomainAdapter.replaceToolService(tools);
    const button = document.createElement('button');
    document.querySelector('form')!.append(button);

    fetchMock.mockResolvedValueOnce(
      arrayJson(toolDto({ id: 't-form', name: '空气炸锅', icon: '🍲', category: '烘烤', notes: '刚到手' }))
    );
    await (window as any).handleToolFormSubmit({ preventDefault: vi.fn(), submitter: button });
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/v1/tools');
    expect(call?.[1].method).toBe('POST');
    expect(JSON.parse(call?.[1].body)).toEqual({
      name: '空气炸锅',
      icon: '♨',
      category: '烘烤',
      status: '状态良好',
      notes: '刚到手'
    });
    expect(close).toHaveBeenCalledWith(true);
    expect(button.disabled).toBe(false);
    expect(tools.data[0]).toMatchObject({ id: 't-form', icon: '🍲' });
  });

  /** 绑定 recipes/pantry/shopping 三域并返回可直接断言的请求 mock。 */
  const bootD5 = async (options: {
    recipe: Record<string, unknown>;
    pantry?: unknown[];
    routes?: Record<string, unknown | ((init: any) => unknown)>;
  }) => {
    const fetchMock = vi.fn() as any;
    // boot 阶段宽容 mock（各域都会 reload），避免在途 reload 晚到覆盖后面手工设置的 pantry/recipes 数据
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('/shopping-lists?status=ACTIVE')
        ? Promise.resolve(shoppingJson([shoppingListDto(2, [])]))
        : Promise.resolve(arrayJson([]))
    );
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const open = vi.fn();
    (window as any).BentoModal = { open, close: vi.fn() };
    const recipes: any = { data: [] };
    const pantry: any = { data: [] };
    const shopping: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes, pantry, shopping };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    (window as any).DafanDomainAdapter.replaceRecipeService(recipes);
    (window as any).DafanDomainAdapter.replacePantryService(pantry);
    await (window as any).DafanDomainAdapter.replaceShoppingService(shopping)();
    fetchMock.mockReset();
    if (options.routes) fetchMock.mockImplementation(routeFetch(options.routes));
    recipes.data = [(window as any).DafanDomainAdapter.mapRecipe(options.recipe)];
    pantry.data = options.pantry ?? [];
    (window as any).DafanDomainAdapter.replaceRecipeService(recipes);
    (window as any).DafanDomainAdapter.replacePantryService(pantry);
    return { fetchMock, toast, open, recipes, pantry, shopping };
  };

  it('D5 一次单事务补齐：中文单位/自由规格全部入清单，名称纯净不拼括号且不抛不可映射', async () => {
    const { fetchMock, toast, open } = await bootD5({
      recipe: {
        id: 'r-d5',
        name: '五样缺料',
        version: 1,
        ingredients: [
          { name: '土豆', amountText: '200克' },
          { name: '葱', amountText: '适量' },
          { name: '姜', amountText: '2块' },
          { name: '蒜', amountText: '2根' },
          { name: '盐', amountText: '少许' }
        ],
        steps: []
      },
      routes: {
        '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(2, [])]),
        '/api/v1/shopping-lists/sl1/replenish-recipe': shoppingJson(shoppingListDto(3, [])),
        '/api/v1/recipes/r-d5': shoppingJson({ id: 'r-d5', name: '五样缺料', version: 1, ingredients: [], steps: [] })
      }
    });

    await (window as any).BentoService.recipes.addMissingIngredientsToShopping('r-d5');

    const posts = fetchMock.mock.calls.filter(([, init]: any) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe('/api/v1/shopping-lists/sl1/replenish-recipe');
    const body = JSON.parse(posts[0][1].body);
    expect(body).toMatchObject({ version: 2, recipeId: 'r-d5' });
    expect(body.items).toEqual([
      { ingredientId: null, ingredientName: '土豆', quantity: 200, unit: 'GRAM', amountText: '200克' },
      { ingredientId: null, ingredientName: '葱', quantity: null, unit: null, amountText: '适量' },
      { ingredientId: null, ingredientName: '姜', quantity: null, unit: null, amountText: '2块' },
      { ingredientId: null, ingredientName: '蒜', quantity: null, unit: null, amountText: '2根' },
      { ingredientId: null, ingredientName: '盐', quantity: null, unit: null, amountText: '少许' }
    ]);
    // 名称绝不拼括号规格
    expect(body.items.every((item: any) => !item.ingredientName.includes('('))).toBe(true);
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('无法映射'), 'error');
    expect(toast).toHaveBeenCalledWith('已成功将 5 项食材加入购物清单！', 'success');
    await flush();
    expect(open).toHaveBeenCalledWith('recipeDetail', expect.objectContaining({ id: 'r-d5', name: '五样缺料' }));
  });

  it('D5 严格库存匹配：ID 优先、唯一精确同名、歧义不误判、可换算差额与充足跳过、不可换算全量补', async () => {
    const { fetchMock } = await bootD5({
      recipe: {
        id: 'r-match',
        name: '匹配规则',
        version: 1,
        ingredients: [
          // 洋葱库存不得命中「葱」；无 ID 且库中无同名 → 全量补
          { name: '葱', quantity: 2, unit: 'PIECE' },
          // 同名两条歧义 → 不绑定、按实际不充足全量补
          { name: '蒜', amountText: '2根' },
          // 250g 需求 vs 0.1kg 库存 → 差额 150g
          { name: '土豆', amountText: '250g' },
          // 0.5kg 库存充足 → 跳过
          { name: '牛肉', amountText: '250g' },
          // 不可换算：需求 2个、库存 500g → 全量补
          { name: '鸡蛋', quantity: 2, unit: 'PIECE' },
          // 有 ID 且 ID 命中：库存充足跳过
          { name: '牛奶', quantity: 1, unit: 'LITER', ingredientId: 'i-milk' },
          // 有 ID 但库存已不存在：不绑定失效 ID，全量补
          { name: '香菜', amountText: '1把', ingredientId: 'i-gone' }
        ],
        steps: []
      },
      pantry: [
        { id: 'i-onion', name: '洋葱', stock: 800, unitKey: 'GRAM' },
        { id: 'i-garlic-1', name: '蒜', stock: 100, unitKey: 'GRAM' },
        { id: 'i-garlic-2', name: '蒜', stock: 100, unitKey: 'GRAM' },
        { id: 'i-potato', name: '土豆', stock: 0.1, unitKey: 'KILOGRAM' },
        { id: 'i-beef', name: '牛肉', stock: 0.5, unitKey: 'KILOGRAM' },
        { id: 'i-egg', name: '鸡蛋', stock: 500, unitKey: 'GRAM' },
        { id: 'i-milk', name: '牛奶', stock: 2, unitKey: 'LITER' }
      ],
      routes: {
        '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(2, [])]),
        '/api/v1/shopping-lists/sl1/replenish-recipe': shoppingJson(shoppingListDto(3, []))
      }
    });

    await (window as any).BentoService.recipes.addMissingIngredientsToShopping('r-match');

    const post = fetchMock.mock.calls.find(([url]: any) => url === '/api/v1/shopping-lists/sl1/replenish-recipe');
    expect(post).toBeTruthy();
    const body = JSON.parse(post![1].body);
    expect(body.items).toEqual([
      { ingredientId: null, ingredientName: '葱', quantity: 2, unit: 'PIECE', amountText: null },
      { ingredientId: null, ingredientName: '蒜', quantity: null, unit: null, amountText: '2根' },
      { ingredientId: 'i-potato', ingredientName: '土豆', quantity: 150, unit: 'GRAM', amountText: null },
      // 唯一精确同名命中 → 绑定库存 ID（补货入库累加到既有食材），但单位不可换算仍按需求全量补
      { ingredientId: 'i-egg', ingredientName: '鸡蛋', quantity: 2, unit: 'PIECE', amountText: null },
      { ingredientId: null, ingredientName: '香菜', quantity: null, unit: null, amountText: '1把' }
    ]);
    // 充足项（牛肉/牛奶）绝不出现在补货批次里
    const names = body.items.map((item: any) => item.ingredientName);
    expect(names).not.toContain('牛肉');
    expect(names).not.toContain('牛奶');
  });

  it('D5 库存全充足：仅提示无需补货且零请求；补齐接口失败如实抛出且不报成功', async () => {
    const sufficient = await bootD5({
      recipe: {
        id: 'r-full',
        name: '全都够',
        version: 1,
        ingredients: [{ name: '鸡蛋', amountText: '2个' }],
        steps: []
      },
      pantry: [{ id: 'i-egg', name: '鸡蛋', stock: 10, unitKey: 'PIECE' }],
      routes: {
        '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(2, [])])
      }
    });
    await (window as any).BentoService.recipes.addMissingIngredientsToShopping('r-full');
    expect(sufficient.toast).toHaveBeenCalledWith('菜谱食材均已在库，无需补货', 'success');
    expect(sufficient.fetchMock).not.toHaveBeenCalled();

    const failing = await bootD5({
      recipe: {
        id: 'r-fail',
        name: '写入失败',
        version: 1,
        ingredients: [{ name: '番茄', quantity: 2, unit: 'PIECE' }],
        steps: []
      },
      routes: {
        '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(2, [])]),
        '/api/v1/shopping-lists/sl1/replenish-recipe': errorJson(500, 'INTERNAL_ERROR', '服务器内部错误')
      }
    });
    await expect((window as any).BentoService.recipes.addMissingIngredientsToShopping('r-fail')).rejects.toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR'
    });
    expect(failing.toast).not.toHaveBeenCalledWith(expect.stringContaining('已成功将'), 'success');
    expect(failing.open).not.toHaveBeenCalled();
  });

  it('D5 补货遇 409 版本冲突：先 reload 最新清单再用最新 version 重试一次', async () => {
    let attempt = 0;
    const { fetchMock, toast } = await bootD5({
      recipe: {
        id: 'r-conflict',
        name: '版本冲突',
        version: 1,
        ingredients: [{ name: '番茄', quantity: 2, unit: 'PIECE' }],
        steps: []
      },
      routes: {
        '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(2, [])]),
        '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(6, [])),
        '/api/v1/shopping-lists/sl1/replenish-recipe': () => {
          attempt += 1;
          return attempt === 1 ? errorJson(409, 'VERSION_CONFLICT', '版本冲突') : shoppingJson(shoppingListDto(7, []));
        }
      }
    });

    await (window as any).BentoService.recipes.addMissingIngredientsToShopping('r-conflict');

    const posts = fetchMock.mock.calls.filter(([url]: any) => url === '/api/v1/shopping-lists/sl1/replenish-recipe');
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[0][1].body).version).toBe(2);
    expect(JSON.parse(posts[1][1].body).version).toBe(6);
    expect(fetchMock.mock.calls.find(([url]: any) => url === '/api/v1/shopping-lists/sl1')).toBeTruthy();
    expect(toast).toHaveBeenCalledWith('已成功将 1 项食材加入购物清单！', 'success');
  });

  it('D5 非版本冲突的 409 不重试，避免无界重复写入', async () => {
    const { fetchMock } = await bootD5({
      recipe: {
        id: 'r-locked',
        name: '清单不可补',
        version: 1,
        ingredients: [{ name: '番茄', quantity: 2, unit: 'PIECE' }],
        steps: []
      },
      routes: {
        '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(2, [])]),
        '/api/v1/shopping-lists/sl1/replenish-recipe': errorJson(409, 'SHOPPING_LIST_NOT_ACTIVE', '清单已完成')
      }
    });
    await expect(
      (window as any).BentoService.recipes.addMissingIngredientsToShopping('r-locked')
    ).rejects.toMatchObject({ status: 409 });
    expect(
      fetchMock.mock.calls.filter(([url]: any) => url === '/api/v1/shopping-lists/sl1/replenish-recipe')
    ).toHaveLength(1);
  });

  it('shopping 清理已购与勾选完成只写清单状态，绝不触发任何库存变动', async () => {
    const checked = shoppingItemDto({ id: 'it1', completed: true, quantity: 2, unit: 'PIECE' });
    const unchecked = shoppingItemDto({ id: 'it2', completed: false });
    const routes: Record<string, unknown | ((init: any) => unknown)> = {
      '/api/v1/shopping-lists/sl1/clear-completed': shoppingJson({
        list: shoppingListDto(3, [unchecked]),
        cleared: 1
      }),
      '/api/v1/shopping-list-items/it2': shoppingJson(shoppingListDto(3, [{ ...unchecked, completed: true }]))
    };
    const { fetchMock, toast, shopping } = await bootShopping(shoppingListDto(2, [checked, unchecked]), routes);

    expect(await shopping.clearCompleted()).toMatchObject({ id: 'sl1', version: 3 });
    const clearCall = fetchMock.mock.calls.find(([url]: any) => String(url).includes('/clear-completed'));
    expect(clearCall?.[1].method).toBe('POST');
    expect(JSON.parse(clearCall![1].body)).toEqual({ version: 2 });
    // 只回传 list 作为清单 DTO，cleared 数量用于提示
    expect(shopping.data.map((x: any) => x.id)).toEqual(['it2']);
    expect(toast).toHaveBeenCalledWith('已清理 1 项已购物品', 'success');

    await shopping.toggle('it2');
    const toggleCall = fetchMock.mock.calls.find(([url]: any) => String(url) === '/api/v1/shopping-list-items/it2');
    expect(toggleCall?.[1].method).toBe('PUT');
    // 勾选完成只发 completed，绝不附带数量单位或库存动作
    expect(JSON.parse(toggleCall![1].body)).toEqual({ version: 3, completed: true });
    // 全程零库存/清单条目以外的写请求
    const paths = fetchMock.mock.calls.map(([url]: any) => String(url));
    expect(paths.every((path: string) => !path.includes('/ingredients') && !path.includes('/check-in'))).toBe(true);
  });

  it('shopping 写失败（clearCompleted / toggle）错误向上抛，清单与提示不变', async () => {
    const cases = [
      {
        run: (shopping: any) => shopping.clearCompleted(),
        route: '/api/v1/shopping-lists/sl1/clear-completed',
        method: 'POST'
      },
      { run: (shopping: any) => shopping.toggle('it1'), route: '/api/v1/shopping-list-items/it1', method: 'PUT' }
    ];
    for (const testCase of cases) {
      const checked = shoppingItemDto({ id: 'it1', completed: true, quantity: 2, unit: 'PIECE' });
      const { fetchMock, toast, shopping } = await bootShopping(shoppingListDto(2, [checked]), {
        [testCase.route]: errorJson(409, 'VERSION_CONFLICT', '版本冲突')
      });
      const before = structuredClone(shopping.data);
      await expect(testCase.run(shopping)).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
      expect(shopping.data).toEqual(before);
      expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('已清理'), 'success');
      const call = fetchMock.mock.calls.find(([url]: any) => String(url) === testCase.route);
      expect(call?.[1].method).toBe(testCase.method);
    }
  });

  it('shopping updateItem 补填数量单位：串 version、不传 ingredientId/amountText，失败不吞错', async () => {
    const target = shoppingItemDto({
      id: 'it-free',
      ingredientNameSnapshot: '葱',
      quantity: null,
      unit: null,
      amountText: '适量',
      completed: true,
      ingredientId: 'ing-scallion'
    });
    const { fetchMock, shopping } = await bootShopping(shoppingListDto(2, [target]), {
      '/api/v1/shopping-list-items/it-free': shoppingJson(
        shoppingListDto(3, [{ ...target, quantity: 2, unit: 'BAG', amountText: null }])
      )
    });

    await shopping.updateItem('it-free', { quantity: 2, unit: '袋' });
    const call = fetchMock.mock.calls.find(([url]: any) => String(url) === '/api/v1/shopping-list-items/it-free');
    expect(call?.[1].method).toBe('PUT');
    const body = JSON.parse(call![1].body);
    expect(body).toEqual({ version: 2, quantity: 2, unit: 'BAG' });
    // 未传 ingredientId 表示保留后端关系；未传 amountText 由后端清空旧自由规格
    expect(body).not.toHaveProperty('ingredientId');
    expect(body).not.toHaveProperty('amountText');
    expect(shopping.data[0]).toMatchObject({ quantity: 2, unitKey: 'BAG', amountText: null, amount: '2袋' });

    // 非法补填值在本地快速失败且零请求
    fetchMock.mockClear();
    await expect(shopping.updateItem('it-free', { quantity: 0, unit: '袋' })).rejects.toMatchObject({
      code: 'SHOPPING_ITEM_INVALID'
    });
    await expect(shopping.updateItem('it-free', { quantity: 2, unit: '斗' })).rejects.toMatchObject({
      code: 'SHOPPING_ITEM_INVALID'
    });
    await expect(shopping.updateItem('it-free', { quantity: 2 })).rejects.toMatchObject({
      code: 'SHOPPING_ITEM_INVALID'
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // 后端写失败：错误原样传播
    fetchMock.mockReset().mockResolvedValue(errorJson(503, 'MAINTENANCE', '服务维护中'));
    await expect(shopping.updateItem('it-free', { quantity: 1, unit: '袋' })).rejects.toMatchObject({
      status: 503,
      code: 'MAINTENANCE'
    });
  });

  /**
   * 补量入库弹窗三条分支的公共脚手架：真实 DOM 渲染由 HTML 代理负责，
   * 这里用 stub openShoppingCheckinPrompt 捕获适配器传出的 items 与两个回调。
   */
  const bootCheckinPrompt = async (
    items: unknown[],
    routes: Record<string, unknown | ((init: any) => unknown)>,
    promptImpl?: (payload: any) => unknown
  ) => {
    const { fetchMock, toast, shopping } = await bootShopping(shoppingListDto(2, items), routes);
    const calls: any[] = [];
    (window as any).openShoppingCheckinPrompt = vi.fn((payload: any) => {
      calls.push(payload);
      return promptImpl ? promptImpl(payload) : undefined;
    });
    (window as any).closeShoppingCheckinPrompt = vi.fn();
    return { fetchMock, toast, shopping, calls, prompt: (window as any).openShoppingCheckinPrompt };
  };

  const freeSpecItem = () =>
    shoppingItemDto({
      id: 'it-free',
      ingredientNameSnapshot: '葱',
      quantity: null,
      unit: null,
      amountText: '适量',
      completed: true,
      ingredientId: 'ing-scallion'
    });
  const structuredItem = () =>
    shoppingItemDto({
      id: 'it-egg',
      ingredientNameSnapshot: '鸡蛋',
      quantity: 6,
      unit: 'PIECE',
      completed: true,
      ingredientId: 'ing-egg'
    });

  it('补量入库：缺量项打开弹窗且不提前写 check-in pending，取消零请求', async () => {
    const { fetchMock, shopping, calls } = await bootCheckinPrompt([freeSpecItem(), structuredItem()], {});
    const result = await shopping.importCheckedToPantry();
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].hasStructuredItems).toBe(true);
    expect(calls[0].items).toEqual([
      expect.objectContaining({ id: 'it-free', name: '葱', amount: '适量', amountText: '适量' })
    ]);
    expect(typeof calls[0].onSubmit).toBe('function');
    expect(typeof calls[0].onStructuredOnly).toBe('function');
    // 只打开弹窗（HTML 负责关闭）；适配器不得提前发 check-in 或写未决记录
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingRecord()).toBeNull();
    expect((window as any).closeShoppingCheckinPrompt).not.toHaveBeenCalled();
  });

  it('补量入库「补填并一并入库」：按 version 依次 PUT 补填后整批 check-in，保留 ingredientId', async () => {
    const free = freeSpecItem();
    const egg = structuredItem();
    const routes: Record<string, unknown | ((init: any) => unknown)> = {
      '/api/v1/shopping-list-items/it-free': (init: any) => {
        expect(JSON.parse(init.body)).toEqual({ version: 2, quantity: 2, unit: 'BAG' });
        return shoppingJson(shoppingListDto(3, [{ ...free, quantity: 2, unit: 'BAG', amountText: null }, egg]));
      },
      '/api/v1/shopping-lists/sl1/check-in': (init: any) => {
        expect(JSON.parse(init.body)).toMatchObject({ version: 3, itemIds: ['it-egg', 'it-free'] });
        return shoppingJson(shoppingListDto(4, []));
      },
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(4, [])),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(4, [])])
    };
    const { fetchMock, toast, shopping, calls } = await bootCheckinPrompt([free, egg], routes);

    await shopping.importCheckedToPantry();
    expect(calls).toHaveLength(1);
    expect(await calls[0].onSubmit([{ id: 'it-free', quantity: 2, unit: '袋' }])).toBe(true);

    const paths = fetchMock.mock.calls.map(([url]: any) => String(url));
    expect(paths).toEqual([
      '/api/v1/shopping-list-items/it-free',
      '/api/v1/shopping-lists/sl1/check-in',
      '/api/v1/shopping-lists/sl1',
      '/api/v1/shopping-lists?status=ACTIVE'
    ]);
    // PUT 只补数量单位：不传 ingredientId（后端保留关系）、不传 amountText（后端清空旧自由规格）
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    const checkinBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(checkinBody.itemIds).toEqual(['it-egg', 'it-free']);
    expect(checkinBody.operationId).toBeTruthy();
    expect(toast).toHaveBeenCalledWith('已将 2 件采购食材入库冰箱', 'success');
  });

  it('补量入库「仅入库已填数量项」：只提交结构化项，自由规格项保留且仍为已购态', async () => {
    const free = freeSpecItem();
    const egg = structuredItem();
    const remaining = { ...free };
    const routes: Record<string, unknown | ((init: any) => unknown)> = {
      '/api/v1/shopping-lists/sl1/check-in': (init: any) => {
        expect(JSON.parse(init.body)).toMatchObject({ itemIds: ['it-egg'] });
        return shoppingJson(shoppingListDto(3, [remaining]));
      },
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(3, [remaining])),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(3, [remaining])])
    };
    const { fetchMock, toast, shopping, calls } = await bootCheckinPrompt([free, egg], routes);

    await shopping.importCheckedToPantry();
    expect(await calls[0].onStructuredOnly()).toBe(true);
    const paths = fetchMock.mock.calls.map(([url]: any) => String(url));
    expect(paths).toEqual([
      '/api/v1/shopping-lists/sl1/check-in',
      '/api/v1/shopping-lists/sl1',
      '/api/v1/shopping-lists?status=ACTIVE'
    ]);
    // 零 PUT：不补填自由规格项
    expect(fetchMock.mock.calls.some(([, init]: any) => init?.method === 'PUT')).toBe(false);
    // 自由规格项原样留在清单且保持 completed=true
    expect(shopping.data).toEqual([expect.objectContaining({ id: 'it-free', amountText: '适量', isChecked: true })]);
    expect(toast).toHaveBeenCalledWith('已将 1 件采购食材入库冰箱', 'success');
  });

  it('补量入库：全部勾选项都缺量时「仅入库已填数量项」返回 false 且零请求', async () => {
    const { fetchMock, shopping, calls } = await bootCheckinPrompt(
      [freeSpecItem(), { ...freeSpecItem(), id: 'it-free-2', ingredientNameSnapshot: '姜', amountText: '2块' }],
      {}
    );
    await shopping.importCheckedToPantry();
    expect(calls[0].hasStructuredItems).toBe(false);
    expect(await calls[0].onStructuredOnly()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('补量入库：onSubmit 数据不合法时 fail-closed 零请求', async () => {
    const { fetchMock, shopping, calls } = await bootCheckinPrompt([freeSpecItem(), structuredItem()], {});
    await shopping.importCheckedToPantry();
    // 数量非法 / 单位不受支持 / 缺项 / 多条重复 / 空数组 全部拒绝
    const invalidCases = [
      [{ id: 'it-free', quantity: 0, unit: '袋' }],
      [{ id: 'it-free', quantity: 2, unit: '斗' }],
      [{ id: 'it-free', quantity: Number.NaN, unit: '袋' }],
      [],
      [{ id: 'it-other', quantity: 2, unit: '袋' }],
      [
        { id: 'it-free', quantity: 2, unit: '袋' },
        { id: 'it-free', quantity: 3, unit: '袋' }
      ]
    ];
    for (const updates of invalidCases) {
      await expect(calls[0].onSubmit(updates)).rejects.toMatchObject({
        code: 'SHOPPING_CHECKIN_QUANTITY_INVALID'
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingRecord()).toBeNull();
  });

  it('补量入库：缺少 HTML 弹窗函数时 fail-closed，不编造默认量也不直接 check-in', async () => {
    const { fetchMock, toast, shopping } = await bootShopping(shoppingListDto(2, [freeSpecItem()]), {});
    expect((window as any).openShoppingCheckinPrompt).toBeUndefined();
    expect(await shopping.importCheckedToPantry()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingRecord()).toBeNull();
    expect(toast).toHaveBeenCalledWith('补量入库弹窗不可用，已阻止本次入库；请先为缺量项补填数量与单位', 'error');
  });

  it('补量入库：已存在 pending 时严格重放原 payload，弹窗与新勾选不参与', async () => {
    const free = freeSpecItem();
    localStorage.setItem(
      'dafan-shopping-checkin-pending',
      JSON.stringify({ listId: 'sl1', version: 2, operationId: 'op-pending', itemIds: ['it-old'] })
    );
    const { fetchMock, shopping, prompt } = await bootCheckinPrompt([free], {
      '/api/v1/shopping-lists/sl1/check-in': shoppingJson(shoppingListDto(3, [])),
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(3, [])),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(3, [])])
    });
    expect(await shopping.importCheckedToPantry()).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    const checkin = fetchMock.mock.calls.find(([url]: any) => String(url).includes('/check-in'));
    expect(JSON.parse(checkin![1].body)).toEqual({
      version: 2,
      operationId: 'op-pending',
      itemIds: ['it-old']
    });
    expect(readPendingRecord()).toBeNull();
  });

  it('补量入库：全部为结构化项时直接入库，不打开补量弹窗', async () => {
    const { fetchMock, shopping, prompt, toast } = await bootCheckinPrompt([structuredItem()], {
      '/api/v1/shopping-lists/sl1/check-in': shoppingJson(shoppingListDto(3, [])),
      '/api/v1/shopping-lists/sl1': shoppingJson(shoppingListDto(3, [])),
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([shoppingListDto(3, [])])
    });
    expect(await shopping.importCheckedToPantry()).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]: any) => String(url))).toEqual([
      '/api/v1/shopping-lists/sl1/check-in',
      '/api/v1/shopping-lists/sl1',
      '/api/v1/shopping-lists?status=ACTIVE'
    ]);
    expect(toast).toHaveBeenCalledWith('已将 1 件采购食材入库冰箱', 'success');
  });

  it('补量入库：check-in 500 后再次提交严格重放原 operation，不重复 PUT 也不覆盖 pending', async () => {
    const free = freeSpecItem();
    const egg = structuredItem();
    const checkinBodies: any[] = [];
    const routes: Record<string, unknown | ((init: any) => unknown)> = {
      '/api/v1/shopping-list-items/it-free': (init: any) => {
        expect(JSON.parse(init.body)).toEqual({ version: 2, quantity: 2, unit: 'BAG' });
        return shoppingJson(shoppingListDto(3, [{ ...free, quantity: 2, unit: 'BAG', amountText: null }, egg]));
      },
      '/api/v1/shopping-lists/sl1/check-in': (init: any) => {
        checkinBodies.push(JSON.parse(init.body));
        return errorJson(500, 'INTERNAL_ERROR', '模拟故障');
      }
    };
    const { fetchMock, shopping, calls } = await bootCheckinPrompt([free, egg], routes);
    await shopping.importCheckedToPantry();
    const updates = [{ id: 'it-free', quantity: 2, unit: '袋' }];

    await expect(calls[0].onSubmit(updates)).rejects.toMatchObject({ status: 500 });
    const firstPending = localStorage.getItem(pendingCheckinKey);
    expect(readPendingRecord()).toMatchObject({ listId: 'sl1', version: 3, itemIds: ['it-egg', 'it-free'] });
    const putCount = () => fetchMock.mock.calls.filter(([, init]: any) => init?.method === 'PUT').length;
    expect(putCount()).toBe(1);

    // 用户在同一弹窗重试：必须原样重放 opA（原 version/operationId/itemIds），不能再补一次量
    await expect(calls[0].onSubmit(updates)).rejects.toMatchObject({ status: 500 });
    expect(putCount()).toBe(1);
    expect(checkinBodies).toHaveLength(2);
    expect(checkinBodies[1]).toEqual(checkinBodies[0]);
    expect(localStorage.getItem(pendingCheckinKey)).toBe(firstPending);
  });

  it('补量入库：既有 pending 时「仅入库已填数量项」同样只重放原 operation，不覆盖也不补 PUT', async () => {
    const free = freeSpecItem();
    const egg = structuredItem();
    const checkinBodies: any[] = [];
    const routes: Record<string, unknown | ((init: any) => unknown)> = {
      '/api/v1/shopping-list-items/it-free': shoppingJson(
        shoppingListDto(3, [{ ...free, quantity: 2, unit: 'BAG', amountText: null }, egg])
      ),
      '/api/v1/shopping-lists/sl1/check-in': (init: any) => {
        checkinBodies.push(JSON.parse(init.body));
        return errorJson(503, 'MAINTENANCE', '服务维护中');
      }
    };
    const { fetchMock, shopping, calls } = await bootCheckinPrompt([free, egg], routes);
    await shopping.importCheckedToPantry();
    await expect(calls[0].onSubmit([{ id: 'it-free', quantity: 2, unit: '袋' }])).rejects.toMatchObject({
      status: 503
    });
    const firstPending = localStorage.getItem(pendingCheckinKey);
    expect(readPendingRecord()).toMatchObject({ itemIds: ['it-egg', 'it-free'] });

    await expect(calls[0].onStructuredOnly()).rejects.toMatchObject({ status: 503 });
    expect(fetchMock.mock.calls.filter(([, init]: any) => init?.method === 'PUT')).toHaveLength(1);
    expect(checkinBodies).toHaveLength(2);
    expect(checkinBodies[1]).toEqual(checkinBodies[0]);
    expect(checkinBodies[1].itemIds).toEqual(['it-egg', 'it-free']);
    expect(localStorage.getItem(pendingCheckinKey)).toBe(firstPending);
  });

  it('补量入库：弹窗打开后 localStorage 损坏或读取抛错，任一回调都 fail-closed 零写入', async () => {
    const { fetchMock, shopping, calls } = await bootCheckinPrompt([freeSpecItem(), structuredItem()], {});
    await shopping.importCheckedToPantry();
    const updates = [{ id: 'it-free', quantity: 2, unit: '袋' }];

    localStorage.setItem(pendingCheckinKey, '{not json');
    expect(await calls[0].onSubmit(updates)).toBe(false);
    expect(await calls[0].onStructuredOnly()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(pendingCheckinKey)).toBe('{not json');

    localStorage.removeItem(pendingCheckinKey);
    stubStorage({
      getItem: () => {
        throw new Error('SecurityError');
      }
    });
    expect(await calls[0].onSubmit(updates)).toBe(false);
    expect(await calls[0].onStructuredOnly()).toBe(false);
    stubStorage({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingRecord()).toBeNull();
  });

  it('补量入库：OTHER 与中文非标准单位在本地 fail-closed，零请求且不写 pending', async () => {
    const { fetchMock, shopping, calls } = await bootCheckinPrompt([freeSpecItem(), structuredItem()], {});
    await shopping.importCheckedToPantry();
    for (const unit of ['OTHER', '根', '斗', '']) {
      await expect(calls[0].onSubmit([{ id: 'it-free', quantity: 2, unit }])).rejects.toMatchObject({
        code: 'SHOPPING_CHECKIN_QUANTITY_INVALID'
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingRecord()).toBeNull();
  });

  it('补量入库：弹窗打开后清单被切换，旧 callback 拒绝且零 PUT/POST', async () => {
    const otherList = {
      ...shoppingListDto(5, [shoppingItemDto({ id: 'it-other', ingredientNameSnapshot: '别的清单项', quantity: 1 })]),
      id: 'sl2'
    };
    const { fetchMock, shopping, calls, toast } = await bootCheckinPrompt([freeSpecItem(), structuredItem()], {
      '/api/v1/shopping-lists?status=ACTIVE': shoppingJson([otherList])
    });
    await shopping.importCheckedToPantry();
    await shopping.reload();
    expect(shopping.data.map((x: any) => x.id)).toEqual(['it-other']);
    fetchMock.mockClear();

    expect(await calls[0].onSubmit([{ id: 'it-free', quantity: 2, unit: '袋' }])).toBe(false);
    expect(await calls[0].onStructuredOnly()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingRecord()).toBeNull();
    expect(toast).toHaveBeenCalledWith('当前购物清单已切换，本次补量未提交；请重新选择条目后重试', 'error');
  });

  it('shopping updateItem：category/ingredientId/sortOrder 仅显式传入时白名单透传', async () => {
    const target = shoppingItemDto({ id: 'it-x', ingredientNameSnapshot: '葱', quantity: 2, unit: 'PIECE' });
    const { fetchMock, shopping } = await bootShopping(shoppingListDto(2, [target]), {
      '/api/v1/shopping-list-items/it-x': shoppingJson(shoppingListDto(2, [target]))
    });
    const lastBody = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body);

    // 不显式传：保持后端原值，不凭空携带关联/分类/排序字段
    await shopping.updateItem('it-x', { completed: true });
    expect(lastBody()).toEqual({ version: 2, completed: true });

    fetchMock.mockClear();
    await shopping.updateItem('it-x', {
      completed: true,
      category: '蔬菜',
      ingredientId: 'ing-9',
      sortOrder: 3
    });
    expect(lastBody()).toEqual({
      version: 2,
      completed: true,
      category: '蔬菜',
      ingredientId: 'ing-9',
      sortOrder: 3
    });

    // 非法白名单值本地快速失败且零请求
    fetchMock.mockClear();
    await expect(shopping.updateItem('it-x', { sortOrder: 1.5 })).rejects.toMatchObject({
      code: 'SHOPPING_ITEM_INVALID'
    });
    await expect(shopping.updateItem('it-x', { ingredientId: 123 as any })).rejects.toMatchObject({
      code: 'SHOPPING_ITEM_INVALID'
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // shopping.add 显式 category 透传，名称/规格契约不变；未给则不带该字段
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(shoppingJson(shoppingListDto(2, [target])));
    await shopping.add({ name: '葱', amount: '适量', category: '蔬菜' });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/v1/shopping-lists/sl1/items');
    expect(lastBody()).toEqual({
      version: 2,
      ingredientName: '葱',
      sourceType: 'MANUAL',
      sourceId: null,
      completed: false,
      quantity: null,
      unit: null,
      amountText: '适量',
      category: '蔬菜'
    });
    fetchMock.mockClear();
    await shopping.add({ name: '葱', amount: '适量' });
    expect(lastBody()).not.toHaveProperty('category');
  });

  it('recipe form 未编辑保存：食材行自身 ID 与库存 ingredientId 不同时不丢关联与 flags（P1 返修回归）', async () => {
    // 渲染层契约：addRecipeIngRow 必须把行自身 ID 与库存 ID 分键保存（两个 ID 语义不同），
    // 混用一个 dataset 键时，两个 ID 不同即匹配不到旧行，未编辑保存会丢 ingredientId/optional/isPrimary
    expect(html).toContain('row.dataset.ingredientRowId = meta.id;');
    expect(html).toContain('row.dataset.ingredientId = meta.ingredientId;');

    document.body.innerHTML = `<form><input id="formRecipeId" value="r12"><input id="formRecipeName" value="关联菜"><input id="formRecipeTime" value="20"><input id="formRecipeCalories" value=""><div id="formRecipeIngList"></div><div id="formRecipeStepList"></div></form>`;
    const okJson = (data: unknown) => ({ ok: true, text: async () => JSON.stringify({ success: true, data }) });
    const dto = {
      id: 'r12',
      version: 3,
      name: '关联菜',
      cookingTimeMinutes: 20,
      ingredients: [
        {
          id: 'row-1',
          ingredientId: 'inv-9',
          ingredientNameSnapshot: '鸡蛋',
          quantity: 2,
          unit: 'PIECE',
          amountText: null,
          optional: true,
          isPrimary: true
        },
        {
          id: 'row-2',
          ingredientId: null,
          ingredientNameSnapshot: '香菜',
          quantity: null,
          unit: null,
          amountText: '适量',
          optional: false,
          isPrimary: false
        }
      ],
      steps: [{ id: 'step-1', stepNo: 1, content: '打散', title: null, timerMinutes: null }],
      mealTypes: [{ mealType: 'DINNER' }],
      mealRoles: [{ mealRole: 'MAIN' }],
      tags: [],
      tools: []
    };
    const fetchMock = vi.fn(async (url: any, options?: any) => {
      const method = options?.method || 'GET';
      if (String(url) === '/api/v1/recipes/r12' && method === 'PUT') return okJson({ ...dto, version: 4 });
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);
    (window as any).BentoModal = { open: vi.fn(), close: vi.fn(), handleRecipeFormSubmit: vi.fn() };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] } };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));

    (window as any).BentoService.recipes.data = [(window as any).DafanDomainAdapter.mapRecipe(dto)];
    const linkedRow = (rowId: string, inventoryId: string | null, name: string, amount: string) =>
      `<div class="recipe-ing-row" data-ingredient-row-id="${rowId}"${
        inventoryId ? ` data-ingredient-id="${inventoryId}"` : ''
      }><input class="recipe-ing-name" value="${name}"><input class="recipe-ing-amount" value="${amount}"></div>`;
    // 与 addRecipeIngRow 的真实行为一致：行自身 ID 与库存 ID 分键；第二行的库存关联为 null
    document.querySelector('#formRecipeIngList')!.innerHTML = [
      linkedRow('row-1', 'inv-9', '鸡蛋', '2个'),
      linkedRow('row-2', null, '香菜', '适量')
    ].join('');
    document.querySelector('#formRecipeStepList')!.innerHTML =
      `<div class="recipe-step-row" data-step-id="step-1"><input class="recipe-step-title" value=""><textarea class="recipe-step-desc">打散</textarea></div>`;
    const button = document.createElement('button');
    document.querySelector('form')!.append(button);
    await (window as any).BentoModal.handleRecipeFormSubmit({ preventDefault: vi.fn(), submitter: button });

    const putBody = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url) === '/api/v1/recipes/r12')?.[1].body);
    // 未编辑行原样重存：关联、可选/主料 flags、结构化数量与原文全部保真
    expect(putBody.ingredients).toEqual([
      {
        ingredientId: 'inv-9',
        name: '鸡蛋',
        quantity: 2,
        unit: 'PIECE',
        amountText: null,
        optional: true,
        isPrimary: true
      },
      {
        ingredientId: null,
        name: '香菜',
        quantity: null,
        unit: null,
        amountText: '适量',
        optional: false,
        isPrimary: false
      }
    ]);
    expect(putBody.steps).toEqual([{ content: '打散', title: null, timerMinutes: null, imagePath: null }]);
  });

  it('recipe form 用量「2根」「2块」保存原文并可无损读回、再次保存（P1 返修回归）', async () => {
    document.body.innerHTML = `<form><input id="formRecipeId" value=""><input id="formRecipeName" value="回归菜二"><input id="formRecipeTime" value="20"><input id="formRecipeCalories" value=""><div id="formRecipeIngList"></div><div id="formRecipeStepList"></div></form>`;
    const okJson = (data: unknown) => ({ ok: true, text: async () => JSON.stringify({ success: true, data }) });
    const cases: Array<[string, string]> = [
      ['葱', '2根'],
      ['豆腐', '2块'],
      ['酱油', '2汤匙'],
      ['香菜', '适量'],
      ['面粉', '300g'],
      ['鸡蛋', '2个']
    ];
    const createdDto = {
      id: 'r13',
      version: 1,
      name: '回归菜二',
      cookingTimeMinutes: 20,
      ingredients: [] as any[],
      steps: [] as any[],
      mealTypes: [{ mealType: 'DINNER' }],
      mealRoles: [{ mealRole: 'MAIN' }],
      tags: [],
      tools: []
    };
    const fetchMock = vi.fn(async (url: any, options?: any) => {
      const method = options?.method || 'GET';
      if (String(url) === '/api/v1/recipes' && method === 'POST') return okJson(createdDto);
      if (String(url) === '/api/v1/recipes/r13' && method === 'PUT') return okJson({ ...createdDto, version: 2 });
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);
    (window as any).BentoModal = { open: vi.fn(), close: vi.fn(), handleRecipeFormSubmit: vi.fn() };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] } };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));

    document.querySelector('#formRecipeIngList')!.innerHTML = cases
      .map(
        ([name, amount]) =>
          `<div class="recipe-ing-row"><input class="recipe-ing-name" value="${name}"><input class="recipe-ing-amount" value="${amount}"></div>`
      )
      .join('');
    document.querySelector('#formRecipeStepList')!.innerHTML =
      `<div class="recipe-step-row"><input class="recipe-step-title" value=""><textarea class="recipe-step-desc">拌匀</textarea></div>`;
    const button = document.createElement('button');
    document.querySelector('form')!.append(button);
    await (window as any).BentoModal.handleRecipeFormSubmit({ preventDefault: vi.fn(), submitter: button });

    const postBody = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url) === '/api/v1/recipes')?.[1].body);
    // 有损映射（根/块→OTHER）与不可映射单位（汤匙）以及非数字（适量）必须整段保留原文，
    // 绝不写 quantity+unit 后丢弃 amountText；只有无损还原的单位（g/个）才允许结构化
    expect(postBody.ingredients.map((row: any) => [row.name, row.quantity, row.unit, row.amountText])).toEqual([
      ['葱', null, null, '2根'],
      ['豆腐', null, null, '2块'],
      ['酱油', null, null, '2汤匙'],
      ['香菜', null, null, '适量'],
      ['面粉', 300, 'GRAM', null],
      ['鸡蛋', 2, 'PIECE', null]
    ]);

    // 后端逐行原样落库后读回（服务端契约：quantity/unit/amountText 原样存储），UI 重开不得退化
    const stored = {
      ...createdDto,
      ingredients: postBody.ingredients.map((row: any, index: number) => ({
        id: `row-${index + 1}`,
        ingredientId: null,
        ingredientNameSnapshot: row.name,
        quantity: row.quantity ?? null,
        unit: row.unit ?? null,
        amountText: row.amountText ?? null,
        optional: false,
        isPrimary: false
      }))
    };
    const mapped = (window as any).DafanDomainAdapter.mapRecipe(stored);
    expect(mapped.ingredients.map((i: any) => i.amount)).toEqual(['2根', '2块', '2汤匙', '适量', '300g', '2个']);

    // 重开后再保存：未编辑行原样重存，原文不丢、结构化行不漂移
    (window as any).BentoService.recipes.data = [mapped];
    (document.querySelector('#formRecipeId') as HTMLInputElement).value = 'r13';
    document.querySelector('#formRecipeIngList')!.innerHTML = mapped.ingredients
      .map(
        (i: any, index: number) =>
          `<div class="recipe-ing-row" data-ingredient-row-id="row-${index + 1}"><input class="recipe-ing-name" value="${
            i.name
          }"><input class="recipe-ing-amount" value="${i.amount}"></div>`
      )
      .join('');
    await (window as any).BentoModal.handleRecipeFormSubmit({ preventDefault: vi.fn(), submitter: button });
    const putBody = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url) === '/api/v1/recipes/r13')?.[1].body);
    expect(putBody.ingredients.map((row: any) => [row.name, row.quantity, row.unit, row.amountText])).toEqual([
      ['葱', null, null, '2根'],
      ['豆腐', null, null, '2块'],
      ['酱油', null, null, '2汤匙'],
      ['香菜', null, null, '适量'],
      ['面粉', 300, 'GRAM', null],
      ['鸡蛋', 2, 'PIECE', null]
    ]);
  });

  it('PIN 401 并发请求复用单例解锁，成功后各自仅重试一次且不重放禁区', async () => {
    document.body.innerHTML = '';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ success: true, data: {} })
    });
    vi.stubGlobal('fetch', fetchMock);
    window.eval(adapter);
    document.body.innerHTML =
      '<div id="modalPinUnlock"><form id="google2PinUnlockForm"><input id="google2PinInput"><p id="google2PinError"></p><button id="google2PinSubmit" type="submit"></button><button id="google2PinCancel" type="button"></button></form></div>';
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        text: async () => JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: '需要 PIN' } })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        text: async () => JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: '需要 PIN' } })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({ success: true, data: { valid: true, required: true, token: 'test-token' } })
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({ success: true, data: { ok: true } })
      });
    const first = (window as any).DafanApiClient.get('/recipes');
    const second = (window as any).DafanApiClient.get('/stores');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.getElementById('modalPinUnlock')?.classList.contains('hidden')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    (document.getElementById('google2PinInput') as HTMLInputElement).value = '1234';
    document
      .getElementById('google2PinUnlockForm')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/settings/pin/verify'))).toHaveLength(1);
    const retriedCalls = fetchMock.mock.calls.filter(
      ([, init]) => typeof init?.headers?.['X-App-Pin-Token'] === 'string' && init.headers['X-App-Pin-Token']
    );
    expect(retriedCalls).toHaveLength(2);
  });

  it('FormData 恢复请求保留浏览器 boundary，且恢复端点 401 不自动重放', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: '需要 PIN' } })
    });
    vi.stubGlobal('fetch', fetchMock);
    document.body.innerHTML = '<div id="modalPinUnlock" class="hidden"></div>';
    window.eval(adapter);
    fetchMock.mockClear();
    const form = new FormData();
    form.append('file', new Blob(['zip']), 'backup.zip');
    await expect(
      (window as any).DafanApiClient.request('/backups/restore', { method: 'POST', body: form, _skipPinRetry: true })
    ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Content-Type');
  });
  it('PIN 验证 200 valid:false 时弹窗保持打开、清空输入并挂起业务请求，正确 PIN 解锁后各自只重试一次', async () => {
    document.body.innerHTML = pinMarkup();
    const unlockToken = 'test-token-unlock';
    let verifyCount = 0;
    let gateArmed = false;
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const target = String(url);
      if (target.endsWith('/settings/pin/verify')) {
        verifyCount += 1;
        return verifyCount === 1
          ? jsonOk({ valid: false, required: true, token: null })
          : jsonOk({ valid: true, required: true, token: unlockToken });
      }
      const token = init?.headers?.['X-App-Pin-Token'];
      if (gateArmed && !token) return jsonFail(401, 'UNAUTHORIZED', '需要 PIN');
      return jsonOk({ endpoint: target, token: token || null });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.eval(adapter);
    await flush();
    await flush();
    expect(document.getElementById('google2PinUnlockForm')).not.toBeNull();
    gateArmed = true;
    fetchMock.mockClear();
    verifyCount = 0;

    let settled = 0;
    const recipe = (window as any).DafanApiClient.get('/recipes').finally(() => (settled += 1));
    const store = (window as any).DafanApiClient.get('/stores').finally(() => (settled += 1));
    await waitFor(() => document.getElementById('modalPinUnlock')?.classList.contains('hidden') === false);
    expect(settled).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const input = document.getElementById('google2PinInput') as HTMLInputElement;
    input.value = '1111';
    document
      .getElementById('google2PinUnlockForm')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => (document.getElementById('google2PinError')?.textContent || '') === 'PIN 不正确，请重试');
    expect(document.getElementById('modalPinUnlock')?.classList.contains('hidden')).toBe(false);
    expect(input.value).toBe('');
    expect(document.getElementById('google2PinError')?.textContent).toBe('PIN 不正确，请重试');
    expect(settled).toBe(0);
    expect(localStorage.length).toBe(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/settings/pin/verify'))).toHaveLength(1);

    input.value = '1234';
    document
      .getElementById('google2PinUnlockForm')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const [recipeResult, storeResult] = await Promise.all([recipe, store]);
    expect(settled).toBe(2);
    expect(recipeResult).toEqual({ endpoint: '/api/v1/recipes', token: expect.any(String) });
    expect(storeResult).toEqual({ endpoint: '/api/v1/stores', token: expect.any(String) });
    expect(document.getElementById('modalPinUnlock')?.classList.contains('hidden')).toBe(true);
    expect(input.value).toBe('');

    const tokens = storedValues();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toBe(unlockToken);
    expect(recipeResult.token).toBe(unlockToken);
    expect(storeResult.token).toBe(unlockToken);
    const businessCalls = fetchMock.mock.calls.filter(([url]) => !String(url).includes('/settings/pin/verify'));
    expect(businessCalls).toHaveLength(4);
    expect(businessCalls.filter(([url]) => String(url).endsWith('/recipes'))).toHaveLength(2);
    expect(businessCalls.filter(([url]) => String(url).endsWith('/stores'))).toHaveLength(2);
    expect(businessCalls.filter(([, init]) => init?.headers?.['X-App-Pin-Token'])).toHaveLength(2);
  });

  it('PIN 验证 429 PIN_ATTEMPTS_EXCEEDED 按 retry-after 禁用提交并倒计时，结束后可再试且只重试一次', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = '';
      let verifyCount = 0;
      const fetchMock = vi.fn(async (url: any, init?: any) => {
        const target = String(url);
        if (target.endsWith('/settings/pin/verify')) {
          verifyCount += 1;
          if (verifyCount === 1)
            return jsonFail(429, 'PIN_ATTEMPTS_EXCEEDED', '尝试次数过多', new Headers({ 'retry-after': '2' }));
          return jsonOk({ valid: true, required: true, token: 'test-token' });
        }
        return init?.headers?.['X-App-Pin-Token'] ? jsonOk({ ok: true }) : jsonFail(401, 'UNAUTHORIZED', '需要 PIN');
      });
      vi.stubGlobal('fetch', fetchMock);
      window.eval(adapter);
      document.body.innerHTML = pinMarkup();
      fetchMock.mockClear();
      verifyCount = 0;

      let settled = false;
      const pending = (window as any).DafanApiClient.get('/recipes').then((value: unknown) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(0);
      const input = document.getElementById('google2PinInput') as HTMLInputElement;
      const submit = document.getElementById('google2PinSubmit') as HTMLButtonElement;
      const error = () => document.getElementById('google2PinError')?.textContent || '';
      expect(document.getElementById('modalPinUnlock')?.classList.contains('hidden')).toBe(false);

      input.value = '1111';
      document
        .getElementById('google2PinUnlockForm')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(submit.disabled).toBe(true);
      expect(error()).toBe('尝试次数过多，请 2 秒后再试');
      expect(settled).toBe(false);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/settings/pin/verify'))).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(submit.disabled).toBe(true);
      expect(error()).toBe('尝试次数过多，请 1 秒后再试');

      await vi.advanceTimersByTimeAsync(1000);
      expect(submit.disabled).toBe(false);
      expect(error()).toBe('可以再次尝试验证');
      expect(settled).toBe(false);

      input.value = '1234';
      document
        .getElementById('google2PinUnlockForm')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toEqual({ ok: true });
      expect(settled).toBe(true);
      expect(document.getElementById('modalPinUnlock')?.classList.contains('hidden')).toBe(true);
      const businessCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/recipes'));
      expect(businessCalls).toHaveLength(2);
      expect(businessCalls[1][1].headers['X-App-Pin-Token']).toBe(storedValues()[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('syncPinSession 200 valid:true 写入 token 且不弹窗，401 UNAUTHORIZED 才拉起解锁窗且不自动重放', async () => {
    document.body.innerHTML = '';
    const sessionToken = 'session-token-valid';
    const unlockToken = 'unlock-token-after-401';
    let sessionResponse: any = jsonOk({ valid: true, required: true, token: sessionToken });
    const fetchMock = vi.fn(async (url: any) => {
      if (String(url).endsWith('/settings/pin/session')) return sessionResponse;
      if (String(url).endsWith('/settings/pin/verify'))
        return jsonOk({ valid: true, required: true, token: unlockToken });
      return jsonOk({});
    });
    vi.stubGlobal('fetch', fetchMock);
    window.eval(adapter);
    document.body.innerHTML = pinMarkup();
    fetchMock.mockClear();

    const session = await (window as any).DafanPinAdapter.syncPinSession();
    expect(session).toEqual({ valid: true, required: true, token: sessionToken });
    expect(storedValues()).toEqual([sessionToken]);
    expect(document.getElementById('modalPinUnlock')?.classList.contains('hidden')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    localStorage.clear();
    sessionResponse = jsonFail(401, 'UNAUTHORIZED', '需要 PIN');
    fetchMock.mockClear();
    const pending = (window as any).DafanPinAdapter.syncPinSession();
    await flush();
    expect(document.getElementById('modalPinUnlock')?.classList.contains('hidden')).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/settings/pin/session'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/settings/pin/verify'))).toHaveLength(0);

    (document.getElementById('google2PinInput') as HTMLInputElement).value = '1234';
    document
      .getElementById('google2PinUnlockForm')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await expect(pending).resolves.toBe(unlockToken);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/settings/pin/session'))).toHaveLength(1);
    expect(document.getElementById('modalPinUnlock')?.classList.contains('hidden')).toBe(true);
  });

  it('high-risk/authorize 401 与 503 MAINTENANCE 都不解锁也不自动重放', async () => {
    document.body.innerHTML = '';
    const fetchMock = vi.fn(async (url: any) => {
      if (String(url).endsWith('/settings/high-risk/authorize')) return jsonFail(401, 'UNAUTHORIZED', '需要 PIN');
      return jsonFail(503, 'MAINTENANCE', '维护中');
    });
    vi.stubGlobal('fetch', fetchMock);
    window.eval(adapter);
    document.body.innerHTML = pinMarkup();
    fetchMock.mockClear();

    await expect(
      (window as any).DafanApiClient.post('/settings/high-risk/authorize', { action: 'RESTORE', pin: '1234' })
    ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.getElementById('modalPinUnlock')?.classList.contains('hidden')).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/settings/pin/verify'))).toHaveLength(0);

    fetchMock.mockClear();
    await expect((window as any).DafanApiClient.get('/dashboard')).rejects.toMatchObject({
      status: 503,
      code: 'MAINTENANCE'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.getElementById('modalPinUnlock')?.classList.contains('hidden')).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/settings/pin/verify'))).toHaveLength(0);
  });

  it('真实 Settings 立即备份：携带 X-App-Pin-Token 且不设 Content-Type，触发 ZIP 下载', async () => {
    document.body.innerHTML = `${sourceSection('#page-settings')}${pinMarkup()}`;
    const blob = new Blob(['zip']);
    const fetchMock = vi.fn(async (url: any) => {
      if (String(url).endsWith('/backups/export'))
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Disposition': 'attachment; filename="backup.zip"' }),
          blob: async () => blob
        };
      if (String(url).endsWith('/settings/pin/verify'))
        return jsonOk({ valid: true, required: true, token: '{{SECRET_5o7wqx3l}}' });
      return jsonOk({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn().mockReturnValue('blob:dafan-backup');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const downloads: { href: string; download: string }[] = [];
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      downloads.push({ href: this.href, download: this.download });
    });
    const toast = vi.fn();
    (window as any).showToast = toast;
    try {
      window.eval(adapter);
      await flush();
      const backupButton = settingsButton('数据备份与导出') as HTMLButtonElement;
      expect(backupButton).not.toBeNull();

      // token 只通过真实解锁流程写入，不依赖硬编码本地存储键
      const pending = (window as any).DafanPinAdapter.ensurePinUnlock();
      (document.getElementById('google2PinInput') as HTMLInputElement).value = '1234';
      document
        .getElementById('google2PinUnlockForm')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      const unlockToken = await pending;
      expect(storedValues()).toEqual([unlockToken]);

      fetchMock.mockClear();
      backupButton.click();
      await waitFor(() => downloads.length === 1);
      const exportCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/backups/export'));
      expect(exportCalls).toHaveLength(1);
      expect(exportCalls[0][1].headers).toMatchObject({ 'X-App-Pin-Token': unlockToken });
      expect(exportCalls[0][1].headers).not.toHaveProperty('Content-Type');
      expect(exportCalls[0][1].method).toBeUndefined();
      expect(exportCalls[0][1].body).toBeUndefined();
      expect(downloads[0]).toEqual({ href: 'blob:dafan-backup', download: 'dafan-backup.zip' });
      expect(createObjectURL).toHaveBeenCalledWith(blob);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:dafan-backup');
      expect(toast).toHaveBeenCalledWith(expect.any(String), 'success');
      expect(backupButton.disabled).toBe(false);
    } finally {
      anchorClick.mockRestore();
    }
  });

  it('真实 index.html 恢复弹窗：pinEnabled=false 仅勾选确认，challenge+RESTORE_LOCAL_DATA 换 token 后完整上传 FormData 并刷新全部数据', async () => {
    const mounted = await mountBackupRestore({ pinEnabled: false });
    expect(document.getElementById('modalBackupRestore')).not.toBeNull();
    expect(document.getElementById('google2RestoreClose')).not.toBeNull();
    await openRestoreDialogWith(new File(['backup-bytes'], 'dafan-backup.zip', { type: 'application/zip' }));
    expect(document.getElementById('modalBackupRestore')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('google2RestoreFileName')?.textContent).toBe('dafan-backup.zip');
    expect(document.getElementById('google2RestorePinGroup')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('google2RestoreConfirmGroup')?.classList.contains('hidden')).toBe(false);
    expect((document.getElementById('google2RestoreSubmit') as HTMLButtonElement).disabled).toBe(false);

    mounted.fetchMock.mockClear();
    const submit = document.getElementById('google2RestoreSubmit') as HTMLButtonElement;
    submit.click();
    await waitFor(() => (document.getElementById('google2RestoreState')?.textContent || '') === '请先勾选恢复确认项');
    expect(document.getElementById('google2RestoreState')?.textContent).toBe('请先勾选恢复确认项');
    expect(
      mounted.fetchMock.mock.calls.filter(([url]) =>
        /\/settings\/high-risk\/authorize|\/backups\/restore/.test(String(url))
      )
    ).toHaveLength(0);

    (document.getElementById('google2RestoreConfirmation') as HTMLInputElement).checked = true;
    submit.click();
    await waitFor(() => mounted.reloadSpies.tools.mock.calls.length === 1);
    const authorizeCalls = mounted.fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/settings/high-risk/authorize')
    );
    expect(authorizeCalls).toHaveLength(2);
    expect(JSON.parse(String(authorizeCalls[0][1].body))).toEqual({ action: 'RESTORE' });
    expect(JSON.parse(String(authorizeCalls[1][1].body))).toEqual({
      action: 'RESTORE',
      challenge: mounted.challengeToken,
      confirmation: 'RESTORE_LOCAL_DATA'
    });
    const restoreCalls = mounted.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/backups/restore'));
    expect(restoreCalls).toHaveLength(1);
    const restoreInit = restoreCalls[0][1];
    expect(restoreInit.method).toBe('POST');
    expect(restoreInit.headers).toEqual({ 'X-High-Risk-Token': mounted.riskToken });
    expect(restoreInit.body).toBeInstanceOf(FormData);
    expect((restoreInit.body as FormData).getAll('file')).toHaveLength(1);
    expect(((restoreInit.body as FormData).get('file') as File).name).toBe('dafan-backup.zip');
    expect(((restoreInit.body as FormData).get('file') as File).size).toBe('backup-bytes'.length);
    expect(document.getElementById('modalBackupRestore')?.classList.contains('hidden')).toBe(true);
    Object.values(mounted.reloadSpies).forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    expect(mounted.dashboard).toHaveBeenCalledTimes(1);
    expect(storedValues()).toEqual([]);
    const sessionIndex = mounted.fetchMock.mock.calls.findIndex(([url]) =>
      String(url).endsWith('/settings/pin/session')
    );
    expect(sessionIndex).toBeGreaterThan(
      mounted.fetchMock.mock.calls.findIndex(([url]) => String(url).endsWith('/backups/restore'))
    );
    // 恢复后的设置刷新也必须排在 PIN 会话同步之后
    const settingsIndexes = mounted.fetchMock.mock.calls
      .map(([url], index) => (String(url).endsWith('/settings') ? index : -1))
      .filter((index) => index >= 0);
    expect(settingsIndexes[settingsIndexes.length - 1]).toBeGreaterThan(sessionIndex);
    expect(mounted.order).toEqual(['stores', 'recipes', 'pantry', 'shopping', 'plans', 'records', 'tools']);
  });

  it('真实 index.html 恢复弹窗：pinEnabled=true 仅 PIN，PIN 换 token；恢复后先同步 PIN 会话再刷新数据', async () => {
    const mounted = await mountBackupRestore({ pinEnabled: true, deferSession: true });
    await openRestoreDialogWith(new File(['backup-bytes'], 'dafan-backup.zip', { type: 'application/zip' }));
    expect(document.getElementById('google2RestorePinGroup')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('google2RestoreConfirmGroup')?.classList.contains('hidden')).toBe(true);
    const pinInput = document.getElementById('google2RestorePin') as HTMLInputElement;
    const submit = document.getElementById('google2RestoreSubmit') as HTMLButtonElement;

    submit.click();
    await waitFor(
      () => (document.getElementById('google2RestoreState')?.textContent || '') === '请输入 4～8 位数字 PIN'
    );
    expect(document.getElementById('google2RestoreState')?.textContent).toBe('请输入 4～8 位数字 PIN');
    expect(
      mounted.fetchMock.mock.calls.filter(([url]) => /high-risk\/authorize|\/backups\/restore/.test(String(url)))
    ).toHaveLength(0);
    // 打开弹窗读一次 /settings，提交时恢复流程再读一次用于判定 pinEnabled
    expect(mounted.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/settings'))).toHaveLength(2);

    pinInput.value = '4321';
    mounted.fetchMock.mockClear();
    submit.click();
    await waitFor(
      () => mounted.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/backups/restore')).length === 1
    );
    await flush();
    expect(
      mounted.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/settings/high-risk/authorize'))
    ).toHaveLength(1);
    expect(
      JSON.parse(
        String(
          mounted.fetchMock.mock.calls.find(([url]) => String(url).endsWith('/settings/high-risk/authorize'))![1].body
        )
      )
    ).toEqual({
      action: 'RESTORE',
      pin: '4321'
    });
    expect(mounted.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/settings/pin/session'))).toHaveLength(
      1
    );
    expect(Object.values(mounted.reloadSpies).every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(mounted.dashboard).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);

    mounted.resolveSession();
    await waitFor(() => mounted.reloadSpies.tools.mock.calls.length === 1);
    Object.values(mounted.reloadSpies).forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    expect(mounted.dashboard).toHaveBeenCalledTimes(1);
    expect(storedValues()).toEqual([mounted.sessionToken]);
    const restoreCall = mounted.fetchMock.mock.calls.find(([url]) => String(url).endsWith('/backups/restore'))!;
    expect((restoreCall[1].body as FormData).get('file')).toBeInstanceOf(File);
    expect((restoreCall[1].body as FormData).get('file')).toMatchObject({ name: 'dafan-backup.zip' });
    expect(restoreCall[1].headers).toEqual({ 'X-High-Risk-Token': mounted.riskToken });
  });

  it('恢复弹窗底部取消与右上关闭都完整清空 PIN/勾选/文件/状态，且不发起恢复请求', async () => {
    const mounted = await mountBackupRestore({ pinEnabled: false });
    const cancel = document.getElementById('google2RestoreCancel') as HTMLButtonElement;
    const close = document.getElementById('google2RestoreClose') as HTMLButtonElement;
    const confirmation = document.getElementById('google2RestoreConfirmation') as HTMLInputElement;
    const state = () => document.getElementById('google2RestoreState')?.textContent || '';
    const fileInput = () => document.getElementById('google2RestoreFile') as HTMLInputElement;

    for (const button of [cancel, close]) {
      expect(document.getElementById('modalBackupRestore')?.classList.contains('hidden')).toBe(true);
      await openRestoreDialogWith(new File(['backup-bytes'], 'dafan-backup.zip', { type: 'application/zip' }));
      expect(document.getElementById('modalBackupRestore')?.classList.contains('hidden')).toBe(false);
      expect(fileInput().files?.length).toBe(1);
      (document.getElementById('google2RestorePin') as HTMLInputElement).value = '1234';
      document.getElementById('google2RestoreSubmit')?.click();
      await waitFor(() => state() === '请先勾选恢复确认项');
      confirmation.checked = true;
      expect(fileInput().files?.length).toBe(1);

      mounted.fetchMock.mockClear();
      button.click();
      expect(document.getElementById('modalBackupRestore')?.classList.contains('hidden')).toBe(true);
      expect((document.getElementById('google2RestorePin') as HTMLInputElement).value).toBe('');
      expect(confirmation.checked).toBe(false);
      expect(fileInput().value).toBe('');
      expect(fileInput().files?.length).toBe(0);
      expect(state()).toBe('');
      expect((document.getElementById('google2RestoreSubmit') as HTMLButtonElement).disabled).toBe(false);
      expect(mounted.fetchMock).not.toHaveBeenCalled();
    }
  });

  it('恢复弹窗设置加载失败时禁用提交并显示错误，且不显示 PIN/勾选分组', async () => {
    const mounted = await mountBackupRestore({ pinEnabled: false, settingsFailure: true });
    await openRestoreDialogWith(new File(['backup-bytes'], 'dafan-backup.zip', { type: 'application/zip' }));
    expect(document.getElementById('modalBackupRestore')?.classList.contains('hidden')).toBe(false);
    expect((document.getElementById('google2RestoreSubmit') as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById('google2RestoreState')?.textContent).toBe('设置读取失败');
    expect(document.getElementById('google2RestorePinGroup')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('google2RestoreConfirmGroup')?.classList.contains('hidden')).toBe(true);
    expect(
      mounted.fetchMock.mock.calls.filter(([url]) => /high-risk\/authorize|\/backups\/restore/.test(String(url)))
    ).toHaveLength(0);
    expect(mounted.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/settings'))).toHaveLength(1);

    document.getElementById('google2RestoreSubmit')?.click();
    await flush();
    expect(mounted.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/backups/restore'))).toHaveLength(0);
  });
  it('恢复后的新库要求 PIN 时，先清旧 token 并完成解锁，再用新 token 刷新设置及全部模块', async () => {
    const mounted = await mountBackupRestore({ pinEnabled: true });
    document.body.insertAdjacentHTML('beforeend', pinMarkup());
    await (window as any).DafanPinAdapter.syncPinSession();
    expect(storedValues()).toEqual([mounted.sessionToken]);
    const originalFetch = mounted.fetchMock.getMockImplementation()!;
    const newToken = 'new-library-test-session';
    mounted.fetchMock.mockImplementation(async (url: any, init?: any) => {
      if (String(url).endsWith('/settings/pin/session')) return jsonFail(401, 'UNAUTHORIZED', '需要新库 PIN');
      if (String(url).endsWith('/settings/pin/verify')) return jsonOk({ valid: true, required: true, token: newToken });
      return originalFetch(url, init);
    });
    await openRestoreDialogWith(new File(['backup'], 'pin-backup.zip', { type: 'application/zip' }));
    (document.getElementById('google2RestorePin') as HTMLInputElement).value = '4321';
    (document.getElementById('google2RestoreConfirmation') as HTMLInputElement).checked = true;
    mounted.fetchMock.mockClear();
    document.getElementById('google2RestoreSubmit')?.click();
    await waitFor(() => document.getElementById('modalPinUnlock')?.classList.contains('hidden') === false);

    expect(document.getElementById('modalBackupRestore')?.classList.contains('hidden')).toBe(true);
    expect((document.getElementById('google2RestorePin') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('google2RestoreConfirmation') as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById('google2RestoreFile') as HTMLInputElement).value).toBe('');
    expect(document.getElementById('google2RestoreState')?.textContent).toBe('');
    expect(storedValues()).toEqual([]);
    expect(mounted.dashboard).not.toHaveBeenCalled();
    Object.values(mounted.reloadSpies).forEach((spy) => expect(spy).not.toHaveBeenCalled());
    const sessionCall = mounted.fetchMock.mock.calls.find(([url]) => String(url).endsWith('/settings/pin/session'))!;
    expect(sessionCall[1]?.headers).not.toHaveProperty('X-App-Pin-Token');

    (document.getElementById('google2PinInput') as HTMLInputElement).value = '9876';
    document
      .getElementById('google2PinUnlockForm')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => mounted.reloadSpies.tools.mock.calls.length === 1);
    expect(storedValues()).toEqual([newToken]);
    expect(mounted.dashboard).toHaveBeenCalledTimes(1);
    Object.values(mounted.reloadSpies).forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    const verifyIndex = mounted.fetchMock.mock.calls.findIndex(([url]) => String(url).endsWith('/settings/pin/verify'));
    const settingsCalls = mounted.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/settings'));
    expect(settingsCalls).toHaveLength(2);
    expect(settingsCalls[1][1]?.headers).toMatchObject({ 'X-App-Pin-Token': newToken });
    expect(mounted.fetchMock.mock.calls.indexOf(settingsCalls[1])).toBeGreaterThan(verifyIndex);
  });

  it('恢复成功但会话同步失败时保持弹窗重置、提示恢复已完成，并暂停后续刷新', async () => {
    const mounted = await mountBackupRestore({ pinEnabled: false });
    const originalFetch = mounted.fetchMock.getMockImplementation()!;
    mounted.fetchMock.mockImplementation(async (url: any, init?: any) =>
      String(url).endsWith('/settings/pin/session')
        ? jsonFail(503, 'MAINTENANCE', '会话暂不可用')
        : originalFetch(url, init)
    );
    await openRestoreDialogWith(new File(['backup'], 'backup.zip', { type: 'application/zip' }));
    (document.getElementById('google2RestoreConfirmation') as HTMLInputElement).checked = true;
    document.getElementById('google2RestoreSubmit')?.click();
    const toast = (window as any).showToast;
    await waitFor(() => toast.mock.calls.some(([, kind]: [string, string]) => kind === 'warning'));
    expect(toast).toHaveBeenCalledWith('本地备份已恢复，正在重新加载数据', 'success');
    expect(toast).toHaveBeenCalledWith('备份已恢复，会话尚未同步：会话暂不可用', 'warning');
    expect(document.getElementById('modalBackupRestore')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('google2RestoreState')?.textContent).toBe('');
    expect((document.getElementById('google2RestoreFile') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('google2RestoreConfirmation') as HTMLInputElement).checked).toBe(false);
    expect(mounted.dashboard).not.toHaveBeenCalled();
    Object.values(mounted.reloadSpies).forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it('关闭恢复弹窗后忽略尚未返回的设置响应，保持状态清空', async () => {
    const mounted = await mountBackupRestore({ pinEnabled: false });
    const pendingSettings = deferred<ReturnType<typeof jsonOk>>();
    const originalFetch = mounted.fetchMock.getMockImplementation()!;
    mounted.fetchMock.mockImplementation(async (url: any, init?: any) =>
      String(url).endsWith('/settings') ? pendingSettings.promise : originalFetch(url, init)
    );
    const input = setRestoreFile(new File(['backup'], 'backup.zip', { type: 'application/zip' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect((document.getElementById('google2RestoreSubmit') as HTMLButtonElement).disabled).toBe(true);
    document.getElementById('google2RestoreCancel')?.click();
    pendingSettings.resolve(jsonOk({ pinEnabled: true }));
    await flush();
    expect(document.getElementById('modalBackupRestore')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('google2RestoreState')?.textContent).toBe('');
    expect(document.getElementById('google2RestorePinGroup')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('google2RestoreConfirmGroup')?.classList.contains('hidden')).toBe(true);
    expect(input.value).toBe('');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
