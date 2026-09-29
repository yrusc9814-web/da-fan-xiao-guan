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
    document.body.innerHTML = `<div data-binding="recommendedRecipes"><div><b data-business-value="name"></b><i data-business-value="tags"></i><i data-business-value="time"></i><i data-business-value="rating"></i></div></div><div data-binding="todayRecords"><div data-binding="todayRecord-0"><span data-business-value="title"></span><span data-business-value="status"></span></div></div><span data-binding="todayRecordsCount"></span><span data-binding="inventory-totalIngredients"></span><span data-binding="weeklyStat-totalMeals"></span><div data-binding="calendarDays"><div data-binding="calendarDay-0"><span data-business-value="weekday"></span><span data-business-value="dayOfMonth"></span><span data-business-value="label"></span></div></div><div data-binding="expiringIngredients"><div data-binding="expiringIngredient-0"><span data-business-value="name"></span><span data-business-value="expiry"></span></div></div>`;
    window.eval(adapter);
    const map = (window as any).DafanDashboardAdapter.mapDashboard;
    map({
      recommendedRecipes: [{ id: 'r', name: '菜', tags: ['快手'], cookingTimeMinutes: 10, rating: 4.5 }],
      todayRecords: [{ title: '午餐', recorded: true }],
      inventory: { totalIngredients: 3, expiringIngredients: [{ id: 'i', name: '葱', expireDaysLeft: 2 }] },
      weeklyStats: { totalMeals: 8 },
      calendarDays: [{ weekday: '周一', dayOfMonth: 1, label: '今天', date: '2026-09-28', status: 'done' }]
    });
    expect(document.querySelector('[data-business-value="name"]')?.textContent).toBe('菜');
    expect(document.querySelector('[data-business-value="tags"]')?.textContent).toBe('快手');
    expect(document.querySelector('[data-business-value="time"]')?.textContent).toContain('10');
    expect(document.querySelector('[data-business-value="rating"]')?.textContent).toContain('4.5');
    expect(document.querySelector('[data-binding="todayRecordsCount"]')?.textContent).toBe('1/1 餐');
    expect(document.querySelector('[data-binding="inventory-totalIngredients"]')?.textContent).toBe('3');
    expect(document.querySelector('[data-binding="weeklyStat-totalMeals"]')?.textContent).toBe('8');
    expect(document.querySelector('[data-binding="calendarDay-0"]')?.dataset.date).toBe('2026-09-28');
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
      calendarDays: [{ date: '2026-09-01', weekday: '周二', dayOfMonth: '1', label: '旧' }],
      inventory: { expiringIngredients: [{ id: 'old-id', name: '旧食材', expireDaysLeft: 1 }] }
    });
    map({
      ...base,
      calendarDays: [{ date: '2026-09-02', weekday: '周三', dayOfMonth: '2', label: '新' }],
      inventory: { expiringIngredients: [{ id: 'new-id', name: '新食材', expireDaysLeft: 2 }] }
    });
    document.querySelector('[data-binding="calendarDay-0"]')?.dispatchEvent(new MouseEvent('click'));
    document.querySelector('[data-binding="expiringIngredient-0"]')?.dispatchEvent(new MouseEvent('click'));
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, 'dailyDiary', '2026-09-02');
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

  it('Settings 通过真实备份响应触发下载并在失败时显示 error toast', async () => {
    document.body.innerHTML =
      '<section id="page-settings"><h4>忌口：不吃香菜、少糖</h4><p>最近备份：2026-09-07 Mochi_Bento_v1.3_Backup.json</p><button onclick="showToast(\'备份成功\', \'success\')">下载</button></section>';
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
    window.eval(adapter);
    await (window as any).DafanSettingsAdapter.wireSettings();
    const button = document.querySelector('#page-settings button') as HTMLButtonElement;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const backupCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/backups/export'));
    expect(backupCall?.[0]).toBe('/api/v1/backups/export');
    expect(backupCall?.[1].headers).toMatchObject({ 'X-App-Pin-Token': '' });
    expect(backupCall?.[1].headers).not.toHaveProperty('Content-Type');
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
    expect(button.disabled).toBe(false);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('403'), 'error');
    expect(button.disabled).toBe(false);
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
    expect(toast).toHaveBeenCalledTimes(Object.values(methods).reduce((sum, names) => sum + names.length, 0));
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

  it('recipes create 精确发送后端字段并拒绝 calories gap', async () => {
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
      ingredients: [{ ingredientId: 'i1', name: '盐', quantity: 2, unit: '克', optional: true, isPrimary: true }],
      steps: [{ content: '翻炒', imagePath: '/x' }],
      tags: ['家常'],
      mealTypes: ['晚餐'],
      mealRoles: ['主菜'],
      toolIds: ['t1'],
      icon: 'x',
      random: 1
    });
    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/v1/recipes');
    const body = JSON.parse(call?.[1].body);
    expect(body).toMatchObject({
      name: '新菜',
      ingredients: [{ ingredientId: 'i1', name: '盐', quantity: 2, unit: '克', optional: true, isPrimary: true }],
      steps: [{ content: '翻炒', imagePath: '/x' }],
      tags: ['家常'],
      mealTypes: ['晚餐'],
      mealRoles: ['主菜'],
      toolIds: ['t1']
    });
    expect(body).not.toHaveProperty('icon');
    await expect((window as any).BentoService.recipes.save({ name: '坏菜', calories: 300 })).rejects.toMatchObject({
      code: 'RECIPE_CALORIES_UNSUPPORTED'
    });
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
    expect(body.ingredients).toEqual([
      { ingredientId: 'i1', name: '旧', quantity: 1, unit: '个', optional: true, isPrimary: true }
    ]);
    expect(body.steps).toEqual([{ content: '切好', imagePath: '/step.jpg' }]);
    expect(body).toMatchObject({
      tags: ['标签'],
      mealTypes: ['晚餐'],
      mealRoles: ['主菜'],
      toolIds: ['t1'],
      imagePath: '/cover.jpg',
      enabledForRecommendation: false
    });
    expect(body).not.toHaveProperty('calories');
    const recipeCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/v1/recipes')).length;
    (document.querySelector('#formRecipeCalories') as HTMLInputElement).value = '300';
    await modal.handleRecipeFormSubmit({ preventDefault: vi.fn(), submitter: button });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/v1/recipes')).length).toBe(recipeCalls);
    expect(button.disabled).toBe(false);
  });

  it('stores menuItems gap 不发请求且不改变数据', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store: any = { data: [{ id: 's1' }] };
    (window as any).BentoService = { stores: store, recipes: { data: [] } };
    window.eval(adapter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockReset();
    store.data = [{ id: 's1' }];
    (window as any).DafanDomainAdapter.replaceStoreService(store);
    await expect(store.save({ name: '店', menuItems: [{ name: '菜' }] })).rejects.toMatchObject({
      code: 'STORE_MENU_UNSUPPORTED'
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.data).toEqual([{ id: 's1' }]);
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
    await expect(second).resolves.toBe(false);
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
    await expect(second).resolves.toBe(false);
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
      favorite: false
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
    expect(service[method]({ id: 'r1' })).toBe(false);
    expect(toast).toHaveBeenCalledWith('该功能尚未接通真实后端', 'error');
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
    expect(toast).toHaveBeenCalledWith('该功能尚未接通真实后端', 'error');
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
      .mockResolvedValueOnce(shoppingJson({ id: 'ing-new', name: '鸡腿肉', quantity: 600, unit: 'GRAM', version: 1 }))
      .mockResolvedValueOnce(
        shoppingJson(
          shoppingListDto(
            3,
            loadedItems.map((x) => ({ ...x, completed: true }))
          )
        )
      )
      .mockResolvedValueOnce(
        shoppingJson(
          shoppingListDto(
            4,
            loadedItems.map((x) => ({ ...x, completed: true }))
          )
        )
      )
      .mockResolvedValueOnce(shoppingJson({ list: shoppingListDto(5, []), cleared: 2 }));

    await shopping.importCheckedToPantry();

    const ingredientCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/v1/ingredients');
    expect(ingredientCalls).toHaveLength(1);
    expect(JSON.parse(ingredientCalls[0][1].body)).toEqual({
      name: '鸡腿肉',
      imagePath: null,
      category: null,
      unit: 'GRAM',
      minStock: null,
      maxStock: null,
      notes: null,
      batches: [
        {
          quantity: 600,
          unit: 'GRAM',
          purchaseDate: null,
          expiryDate: null,
          location: null,
          opened: false,
          consumePriority: false,
          notes: null
        }
      ]
    });
    const putCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/v1/shopping-list-items/'));
    expect(putCalls.map(([url]) => url)).toEqual([
      '/api/v1/shopping-list-items/it1',
      '/api/v1/shopping-list-items/it2'
    ]);
    expect(JSON.parse(putCalls[0][1].body)).toEqual({ version: 2, completed: true });
    expect(JSON.parse(putCalls[1][1].body)).toEqual({ version: 3, completed: true });
    const clearCall = fetchMock.mock.calls.at(-1);
    expect(clearCall[0]).toBe('/api/v1/shopping-lists/sl1/clear-completed');
    expect(JSON.parse(clearCall[1].body)).toEqual({ version: 4 });
    expect(shopping.data).toEqual([]);
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
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/ingredients']);
    expect(shopping.data).toEqual(before);
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
    imagePath: null,
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
      time: '',
      isCompleted: false,
      targetType: 'recipe',
      channel: 'cook',
      targetId: 'r1',
      title: '红烧肉',
      icon: '🥘',
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
              store: { id: 's1', name: '老店', imagePath: null, supportsTakeout: false, supportsDineIn: true }
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
      title: '老店',
      icon: '🍽️'
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
              store: { id: 's1', name: '老店', imagePath: null, supportsTakeout: true, supportsDineIn: false }
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

    expect(plans.uncheckin('p1')).toBe(false);
    expect(toast).toHaveBeenLastCalledWith('该功能尚未接通真实后端', 'error');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await plans.toggleCheckin('p1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      calories: '',
      cost: '',
      rating: 4.5,
      notes: '好吃',
      photos: [],
      version: 2
    });
    expect(records.data[1]).toMatchObject({ id: 'rec2', type: '外卖', icon: '🛵', title: '', photos: ['/p2.jpg'] });
    expect(changed).toHaveBeenCalledWith('records:changed');
  });

  it('records add 发送精确请求且无本地 id/date；不支持字段或不可映射枚举 422 阻断', async () => {
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
      notes: null,
      imagePath: '/new.jpg',
      items: [{ itemType: 'CUSTOM', customName: '豆浆油条', sortOrder: 0 }]
    });
    expect(records.data[0]).toMatchObject({ id: 'rec-new', type: '堂食', icon: '🍽️' });
    expect(changed).toHaveBeenCalledWith('records:changed');

    await expect(records.add({ slot: '午餐', type: '自烹', title: 'x', calories: '550' })).rejects.toMatchObject({
      code: 'RECORD_EXTRA_FIELDS_UNSUPPORTED'
    });
    await expect(records.add({ slot: '午餐', type: '自烹', title: 'x', cost: '12' })).rejects.toMatchObject({
      code: 'RECORD_EXTRA_FIELDS_UNSUPPORTED'
    });
    await expect(records.add({ slot: '午餐', type: '自烹', title: 'x', satiety: '8' })).rejects.toMatchObject({
      code: 'RECORD_EXTRA_FIELDS_UNSUPPORTED'
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
    expect(JSON.parse(call[1].body)).toEqual({
      version: 2,
      mealType: 'DINNER',
      sourceType: 'TAKEOUT',
      items: [{ itemType: 'CUSTOM', customName: '新标题', sortOrder: 0 }],
      rating: 3,
      notes: '改'
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

    await expect(records.update('rec1', { calories: '500', slot: '', type: '' })).rejects.toMatchObject({
      code: 'RECORD_EXTRA_FIELDS_UNSUPPORTED'
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it('legacy record 表单真实 submit：清空不支持字段后提交并关闭 Modal，预填卡路里阻断且不关闭', async () => {
    document.body.innerHTML = `<form><input id="formRecordId" value=""><select id="formRecordSlot"><option selected>午餐</option></select><select id="formRecordType"><option selected>自烹</option></select><input id="formRecordTitle" value="手冲咖啡配贝果"><input id="formRecordCalories" value=""><input id="formRecordCost" value=""><input id="formRecordSatiety" value=""><input id="formRecordRating" value="5"><input id="formRecordNotes" value="好"><div id="photoSlotView-0"><img src="/slot0.jpg"></div></form>`;
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
      notes: '好',
      imagePath: '/slot0.jpg',
      items: [{ itemType: 'CUSTOM', customName: '手冲咖啡配贝果', sortOrder: 0 }]
    });
    expect(close).toHaveBeenCalledWith(true);
    expect(button.disabled).toBe(false);
    expect(records.data[0]).toMatchObject({ id: 'rec-form' });

    (document.querySelector('#formRecordCalories') as HTMLInputElement).value = '550';
    const callsAfterSuccess = fetchMock.mock.calls.length;
    await modal.handleRecordFormSubmit({ preventDefault: vi.fn(), submitter: button });
    expect(fetchMock.mock.calls.length).toBe(callsAfterSuccess);
    expect(close).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('后端饮食记录不支持卡路里/花费/饱腹度字段，请清空后保存', 'error');
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
      arrayJson([toolDto(), toolDto({ id: 't2', name: '平底锅', imagePath: '/pan.jpg', category: '快炒', version: 3 })])
    );
    await second;
    stale.resolve(arrayJson([toolDto({ id: 'stale' })]));
    await first;
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/tools', '/api/v1/tools']);
    expect(tools.data).toHaveLength(2);
    expect(tools.data[0]).toMatchObject({ id: 't1', name: '电炖锅', icon: '🍲', version: 1 });
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

    fetchMock.mockResolvedValueOnce(arrayJson(toolDto({ id: 't9', name: '华夫饼机', category: '烘烤' })));
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
      imagePath: null,
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
      imagePath: null,
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
    expect(JSON.parse(saveCall?.[1].body)).not.toHaveProperty('icon');
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
      arrayJson(toolDto({ id: 't-form', name: '空气炸锅', category: '烘烤', notes: '刚到手' }))
    );
    await (window as any).handleToolFormSubmit({ preventDefault: vi.fn(), submitter: button });
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/v1/tools');
    expect(call?.[1].method).toBe('POST');
    expect(JSON.parse(call?.[1].body)).toEqual({
      name: '空气炸锅',
      imagePath: null,
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
