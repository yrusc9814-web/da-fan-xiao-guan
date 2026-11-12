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
    fetchMock.mockResolvedValueOnce(
      arrayJson({ historyId: 'h1', type: 'SINGLE', results: [{ resultType: 'RECIPE', resultId: 'r2', title: '菜二' }] })
    );
    const randomSpy = vi.spyOn(Math, 'random');
    const index = await (window as any).DafanWheelAdapter.resolveTargetIndex('all');
    expect(index).toBe(2);
    expect(randomSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/recommendations/random');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
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
    fetchMock.mockResolvedValueOnce(
      arrayJson({
        historyId: 'h2',
        type: 'SINGLE',
        results: [{ resultType: 'STORE', resultId: 's9', title: '推荐新店' }]
      })
    );
    const index = await (window as any).DafanWheelAdapter.resolveTargetIndex('takeout');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/recommendations/random');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
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
    fetchMock.mockResolvedValueOnce(arrayJson({ historyId: 'h3', type: 'SINGLE', results: [] }));
    const emptyIndex = await (window as any).DafanWheelAdapter.resolveTargetIndex('cook');
    expect(emptyIndex).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/recommendations/random');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ sourceTypes: ['RECIPE'] });
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('暂无符合条件'), 'info');
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ success: false, error: { code: 'UNAVAILABLE' } })
    });
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

    // 忌口按钮：不宣称已修改、不发任何写请求、导出不被触发
    fetchMock.mockClear();
    toast.mockClear();
    tabooButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Google 2.0 暂无可用的忌口编辑入口', 'warning');
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

  it('pantry 编辑提交批次字段或未知单位时明确阻断且不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const pantry: any = { data: [{ id: 'i1', name: '旧', version: 2, location: '冷藏室' }] };
    (window as any).BentoService = { stores: { data: [] }, recipes: { data: [] }, pantry };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockClear();
    (window as any).DafanDomainAdapter.replacePantryService(pantry);
    const before = structuredClone(pantry.data);
    await expect(
      pantry.save({ id: 'i1', version: 2, name: '改', unit: '个', unitKey: 'PIECE', batches: [{ quantity: 1 }] })
    ).rejects.toMatchObject({ code: 'INGREDIENT_BATCHES_UNSUPPORTED' });
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
        category: ''
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

  it('shopping add 名称或数量单位不可映射时 422 阻断且无请求', async () => {
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
    await expect(shopping.add({ name: '奇怪', amount: '1斗' })).rejects.toMatchObject({
      code: 'SHOPPING_AMOUNT_UNSUPPORTED'
    });
    await expect(shopping.add({ name: '奇怪', amount: '一堆' })).rejects.toMatchObject({
      code: 'SHOPPING_AMOUNT_UNSUPPORTED'
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shopping.data).toEqual([]);
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

  it('pantry addToShopping 解封后映射购物清单写端点，OTHER 单位阻断', async () => {
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
        shoppingListDto(3, [shoppingItemDto({ ingredientNameSnapshot: '生菜 (手动补货)', quantity: 1, unit: 'PIECE' })])
      )
    );
    await pantry.addToShopping('i1');
    const call = fetchMock.mock.calls.at(-1);
    expect(call[0]).toBe('/api/v1/shopping-lists/sl1/items');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({
      version: 2,
      ingredientName: '生菜 (手动补货)',
      quantity: 1,
      unit: 'PIECE',
      sourceType: 'MANUAL',
      sourceId: null,
      completed: false
    });
    expect(close).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('已将「生菜」加入购物清单！', 'success');

    close.mockClear();
    toast.mockClear();
    await expect(pantry.addToShopping('i2')).rejects.toMatchObject({ code: 'SHOPPING_AMOUNT_UNSUPPORTED' });
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(close).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
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
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      version: 1,
      planDate: '2026-10-03',
      mealType: 'DINNER',
      time: null,
      title: null,
      subtext: null,
      icon: null,
      dinerCount: 1,
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
    expect(toast).toHaveBeenCalledWith('打卡成功！已在日记中生成就餐记录', 'success');

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
    expect(toast).toHaveBeenLastCalledWith('打卡成功！已在日记中恢复就餐记录', 'success');
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

  it('recipes.addMissingIngredientsToShopping 解封：缺料项经清单端点补齐（RECIPE 来源），在库项跳过', async () => {
    const fetchMock = vi.fn();
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
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(arrayJson([shoppingListDto(2, [])]))
      .mockResolvedValueOnce(
        arrayJson(
          shoppingListDto(3, [
            shoppingItemDto({
              id: 'it-tomato',
              ingredientNameSnapshot: '番茄 (2个)',
              quantity: 2,
              unit: 'PIECE',
              sourceType: 'RECIPE'
            })
          ])
        )
      )
      .mockResolvedValueOnce(arrayJson({ id: 'r1', name: '番茄炒蛋', version: 2, ingredients: [], steps: [] }));
    (window as any).DafanDomainAdapter.replaceRecipeService(recipes);
    (window as any).DafanDomainAdapter.replacePantryService(pantry);
    (window as any).DafanDomainAdapter.replaceShoppingService(shopping);
    fetchMock.mockClear();
    recipes.data = [
      (window as any).DafanDomainAdapter.mapRecipe({
        id: 'r1',
        name: '番茄炒蛋',
        version: 1,
        ingredients: [
          { name: '番茄', quantity: 2, unit: '个' },
          { name: '盐', quantity: 1, unit: '克' }
        ],
        steps: []
      })
    ];
    pantry.data = [{ id: 'i1', name: '盐', stock: 500 }];

    await (window as any).BentoService.recipes.addMissingIngredientsToShopping('r1');
    const addCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/v1/shopping-lists/sl1/items');
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0][1].method).toBe('POST');
    expect(JSON.parse(addCalls[0][1].body)).toEqual({
      version: 2,
      ingredientName: '番茄 (2个)',
      quantity: 2,
      unit: 'PIECE',
      sourceType: 'RECIPE',
      sourceId: null,
      completed: false
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(open).toHaveBeenCalledWith('recipeDetail', expect.objectContaining({ id: 'r1', name: '番茄炒蛋' }));
    expect(toast).toHaveBeenCalledWith('已成功将 1 项食材加入购物清单！', 'success');
  });

  it('recipes.addMissingIngredientsToShopping：数量单位不可映射时阻断、全部在库时仅提示且无请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    (window as any).showToast = toast;
    const recipes: any = { data: [] };
    const pantry: any = { data: [] };
    const shopping: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes, pantry, shopping };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(arrayJson([shoppingListDto(2, [])]));
    (window as any).DafanDomainAdapter.replaceRecipeService(recipes);
    (window as any).DafanDomainAdapter.replacePantryService(pantry);
    (window as any).DafanDomainAdapter.replaceShoppingService(shopping);
    fetchMock.mockClear();

    recipes.data = [
      (window as any).DafanDomainAdapter.mapRecipe({
        id: 'r1',
        name: '暗黑料理',
        version: 1,
        ingredients: [{ name: '神秘食材', quantity: 1, unit: '斗' }],
        steps: []
      })
    ];
    await expect((window as any).BentoService.recipes.addMissingIngredientsToShopping('r1')).rejects.toMatchObject({
      code: 'SHOPPING_AMOUNT_UNSUPPORTED'
    });
    expect(fetchMock).not.toHaveBeenCalled();

    recipes.data = [
      (window as any).DafanDomainAdapter.mapRecipe({
        id: 'r2',
        name: '家常小炒',
        version: 1,
        ingredients: [{ name: '鸡蛋', quantity: 2, unit: '个' }],
        steps: []
      })
    ];
    pantry.data = [{ id: 'i2', name: '鸡蛋', stock: 10 }];
    await (window as any).BentoService.recipes.addMissingIngredientsToShopping('r2');
    expect(toast).toHaveBeenCalledWith('菜谱食材均已在库，无需补货', 'success');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('D5 补齐缺料部分失败：如实报告已加入与失败项，不报整批成功', async () => {
    const toast = vi.fn();
    (window as any).showToast = toast;
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      const path = String(url);
      if (path.startsWith('/api/v1/shopping-lists?status=ACTIVE')) return arrayJson([shoppingListDto(2, [])]);
      if (path === '/api/v1/shopping-lists/sl1/items') {
        const body = JSON.parse(init.body);
        if (String(body.ingredientName).startsWith('鸡蛋')) throw new Error('网络中断');
        return arrayJson(shoppingListDto(3, [shoppingItemDto({ id: 'ok' })]));
      }
      return arrayJson({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const recipes: any = { data: [] };
    const pantry: any = { data: [] };
    const shopping: any = { data: [] };
    (window as any).BentoService = { stores: { data: [] }, recipes, pantry, shopping };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    (window as any).DafanDomainAdapter.replaceRecipeService(recipes);
    (window as any).DafanDomainAdapter.replacePantryService(pantry);
    (window as any).DafanDomainAdapter.replaceShoppingService(shopping);
    recipes.data = [
      (window as any).DafanDomainAdapter.mapRecipe({
        id: 'r-partial',
        name: '两道缺料',
        version: 1,
        ingredients: [
          { name: '番茄', quantity: 2, unit: '个' },
          { name: '鸡蛋', quantity: 2, unit: '个' }
        ],
        steps: []
      })
    ];

    const error = await (window as any).BentoService.recipes.addMissingIngredientsToShopping('r-partial').then(
      () => null,
      (reason: any) => reason
    );
    expect(error).toMatchObject({ code: 'SHOPPING_ADD_PARTIAL_FAILED' });
    expect(error.message).toContain('已加入：番茄 (2个)');
    expect(error.message).toContain('未加入：鸡蛋 (2个)');
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('已成功将'), 'success');
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
