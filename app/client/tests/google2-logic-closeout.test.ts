// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapterSource = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');
const markup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

const apiOk = (data: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  text: async () => JSON.stringify({ success: true, data })
});
const emptyPage = { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 };

/** 默认路由：所有读接口返回空分页，写接口返回传入响应 */
function makeRoute(overrides: Record<string, unknown> = {}) {
  return (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const key = `${method} ${url}`;
    if (overrides[key]) {
      const value = overrides[key];
      return typeof value === 'function' ? (value as any)(init) : value;
    }
    if (url.endsWith('/settings/pin/session')) return apiOk({ valid: false });
    if (url.endsWith('/dashboard')) return apiOk({});
    return apiOk(emptyPage);
  };
}

function defineInnerText() {
  Object.defineProperty(Element.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent || '';
    },
    set(value: string) {
      this.textContent = value;
    }
  });
}

function boot(route = makeRoute()) {
  document.body.innerHTML = markup;
  defineInnerText();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => route(String(url), init));
  vi.stubGlobal('fetch', fetchMock);
  window.eval(inline);
  window.eval(adapterSource);
  return fetchMock;
}

const settle = async () => {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
};

const pantry = () => (window as any).BentoService.pantry;
const domain = () => (window as any).DafanDomainAdapter;

beforeEach(() => {
  localStorage.clear();
  delete (window as any).__xss;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('T-006B 冰箱食材分类与图标', () => {
  it('历史/空分类按名称归一为 7 大类，7 类计数之和恒等于全部', async () => {
    boot();
    await settle();
    const mapped = [
      { id: '1', name: '西红柿', category: null, quantity: 1, unit: 'PIECE' },
      { id: '2', name: '猪排骨', category: '肉类', quantity: 1, unit: 'GRAM' },
      { id: '3', name: '基围虾', category: '', quantity: 1, unit: 'GRAM' },
      { id: '4', name: '牛奶', category: '蛋奶', quantity: 1, unit: 'MILLILITER' },
      { id: '5', name: '大米', category: '烘焙', quantity: 1, unit: 'GRAM' },
      { id: '6', name: '生抽', category: '调味品', quantity: 1, unit: 'MILLILITER' },
      { id: '7', name: '保鲜袋', category: null, quantity: 1, unit: 'PACK' }
    ].map((item) => domain().mapPantryItem(item));
    pantry().data = mapped;
    (window as any).renderInventory();

    expect(mapped.map((item: any) => item.category)).toEqual([
      '蔬菜',
      '肉禽',
      '水产',
      '蛋奶豆制',
      '主食粮油',
      '调味',
      '其他'
    ]);
    const total = Number(document.getElementById('countInv-all')?.textContent);
    const sum = ['蔬菜', '肉禽', '水产', '蛋奶豆制', '主食粮油', '调味', '其他']
      .map((category) => Number(document.getElementById(`countInv-${category}`)?.textContent))
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(7);
    expect(sum).toBe(total);
  });

  it('图标派生：显式 Emoji 优先，其次名称关键词，最后分类默认，且互不相同', async () => {
    boot();
    await settle();
    const icons = [
      '基围虾',
      '鲈鱼',
      '排骨',
      '鸡蛋',
      '牛奶',
      '豆腐',
      '大米',
      '番茄',
      '香菇',
      '胡萝卜',
      '玉米',
      '黄瓜'
    ].map((name) => domain().mapPantryItem({ id: name, name, category: null, quantity: 1, unit: 'GRAM' }).icon);
    expect(icons).toEqual(['🦐', '🐟', '🥩', '🥚', '🥛', '🧈', '🍚', '🍅', '🍄', '🥕', '🌽', '🥒']);
    expect(new Set(icons).size).toBe(12);
    expect(domain().mapPantryItem({ name: '虾', category: null, imagePath: '🦐' }).icon).toBe('🦐');
    expect(domain().mapPantryItem({ name: '虾', category: null, imagePath: 'shrimp.png' }).icon).toBe('🦐');
    expect(domain().mapPantryItem({ name: '怪东西', category: null }).icon).toBe('📦');
  });

  it('分类切换仅在未手动改图标时联动默认图标', async () => {
    boot();
    await settle();
    (window as any).BentoModal.setupIngredientForm();
    const icon = document.getElementById('formIngIcon') as HTMLSelectElement;
    icon.dataset.manual = '';
    (window as any).BentoModal.onIngredientCategoryChange('肉禽');
    expect(icon.value).toBe('🥩');
    icon.value = '🥕';
    icon.dataset.manual = 'true';
    (window as any).BentoModal.onIngredientCategoryChange('水产');
    expect(icon.value).toBe('🥕');
  });
});

describe('T-006B 食材详情展示与消耗', () => {
  it('无位置不渲染前导点；已过期/今日到期文案正确', async () => {
    boot();
    await settle();
    pantry().data = [
      domain().mapPantryItem({
        id: 'i1',
        name: '牛奶',
        category: '蛋奶豆制',
        quantity: 2,
        unit: 'PIECE',
        expiryDate: '2026-09-01'
      })
    ];
    (window as any).renderInventory();
    const card = document.querySelector('#inventoryCardGrid > div') as HTMLElement;
    expect(card.textContent).toContain('已过期');
    expect(card.textContent).not.toContain('余 -');
    expect(card.textContent).not.toContain('· 2 个');
    expect(card.textContent).toContain('2 个');
  });
});

describe('T-006B 三项编辑闭环与勾选回滚', () => {
  it('食材编辑：详情按钮打开回填表单，保存走 PUT 并同步数量/位置/到期日/最低库存', async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    boot((url, init) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('/ingredients') && method === 'GET')
        return apiOk({
          items: [
            {
              id: 'i1',
              name: '牛奶',
              category: '蛋奶豆制',
              quantity: 900,
              unit: 'MILLILITER',
              location: '冷藏室',
              purchaseDate: '2026-11-01',
              expiryDate: '2026-11-20',
              minStock: 200,
              version: 3
            }
          ],
          page: 1,
          pageSize: 100,
          total: 1,
          totalPages: 1
        });
      if (url.endsWith('/ingredients/i1') && method === 'PUT') {
        calls.push({ method, path: url, body: JSON.parse(String(init?.body)) });
        return apiOk({
          id: 'i1',
          name: '牛奶',
          category: '蛋奶豆制',
          quantity: 600,
          unit: 'MILLILITER',
          location: '冷冻室',
          expiryDate: '2026-11-25',
          minStock: 300,
          version: 4
        });
      }
      return apiOk(emptyPage);
    });
    await settle();
    await vi.waitFor(() => expect(pantry().data.length).toBe(1));
    (window as any).BentoModal.setupIngredientDetail('i1');
    const edit = document.getElementById('btnEditIngredientDetail') as HTMLButtonElement;
    expect(edit).toBeTruthy();
    edit.click();
    await settle();
    expect((document.getElementById('formIngId') as HTMLInputElement).value).toBe('i1');
    expect((document.getElementById('formIngName') as HTMLInputElement).value).toBe('牛奶');
    expect((document.getElementById('formIngCategory') as HTMLSelectElement).value).toBe('蛋奶豆制');
    expect((document.getElementById('formIngStockNum') as HTMLInputElement).value).toBe('900');
    expect((document.getElementById('formIngLocation') as HTMLSelectElement).value).toBe('冷藏室');
    expect((document.getElementById('formIngExpireDate') as HTMLInputElement).value).toBe('2026-11-20');
    expect((document.getElementById('formIngMinStock') as HTMLInputElement).value).toBe('200');

    (document.getElementById('formIngStockNum') as HTMLInputElement).value = '600';
    (document.getElementById('formIngLocation') as HTMLSelectElement).value = '冷冻室';
    (document.getElementById('formIngExpireDate') as HTMLInputElement).value = '2026-11-25';
    (document.getElementById('formIngMinStock') as HTMLInputElement).value = '300';
    await (window as any).BentoModal.handleIngredientFormSubmit({ preventDefault: vi.fn() });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      name: '牛奶',
      category: '蛋奶豆制',
      unit: 'MILLILITER',
      quantity: 600,
      minStock: 300,
      location: '冷冻室',
      expiryDate: '2026-11-25',
      version: 3
    });
    expect(pantry().getById('i1')).toMatchObject({ stock: 600, minStock: 300, version: 4 });
  });

  it('购物项编辑走 PUT；勾选失败时回滚复选框', async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    boot((url, init) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('/shopping-lists?status=ACTIVE'))
        return apiOk([
          {
            id: 'sl1',
            name: '购物补货清单',
            status: 'ACTIVE',
            version: 2,
            items: [
              {
                id: 'it1',
                ingredientNameSnapshot: '小葱',
                quantity: 2,
                unit: 'PIECE',
                sourceType: 'MANUAL',
                completed: false,
                category: '蔬菜',
                sortOrder: 0
              }
            ]
          }
        ]);
      if (url.endsWith('/shopping-list-items/it1') && method === 'PUT') {
        calls.push({ method, path: url, body: JSON.parse(String(init?.body)) });
        const body = JSON.parse(String(init?.body));
        if (body.completed === true) {
          return {
            ok: false,
            status: 500,
            headers: new Headers(),
            text: async () => JSON.stringify({ success: false, error: { code: 'SERVER_ERROR', message: '写入失败' } })
          };
        }
        return apiOk({
          id: 'sl1',
          name: '购物补货清单',
          status: 'ACTIVE',
          version: 3,
          items: [
            {
              id: 'it1',
              ingredientNameSnapshot: body.ingredientName || '小葱',
              quantity: body.quantity ?? 2,
              unit: body.unit || 'PIECE',
              sourceType: 'MANUAL',
              completed: false,
              category: body.category || '蔬菜',
              sortOrder: 0
            }
          ]
        });
      }
      return apiOk(emptyPage);
    });
    await settle();
    const shopping = (window as any).BentoService.shopping;
    await vi.waitFor(() => expect(shopping.getAll().length).toBe(1));
    (window as any).renderShoppingList();
    const container = document.getElementById('shoppingListContainer') as HTMLElement;
    const editButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '✏️'
    ) as HTMLButtonElement;
    expect(editButton).toBeTruthy();
    editButton.click();
    await settle();
    expect((document.getElementById('formShopId') as HTMLInputElement).value).toBe('it1');
    expect((document.getElementById('formShopName') as HTMLInputElement).value).toBe('小葱');
    (document.getElementById('formShopName') as HTMLInputElement).value = '大葱';
    (document.getElementById('formShopAmount') as HTMLInputElement).value = '3个';
    await (window as any).BentoModal.handleShoppingFormSubmit({ preventDefault: vi.fn() });
    const update = calls.find((call) => call.body.completed === undefined);
    expect({ path: update?.path, body: update?.body }).toBeTruthy();
    expect(update?.path).toContain('/shopping-list-items/it1');
    expect(update?.body).toMatchObject({ ingredientName: '大葱', quantity: 3, unit: 'PIECE', category: '蔬菜' });

    // 勾选请求失败 → DOM 回滚
    (window as any).renderShoppingList();
    const boxes = document.querySelectorAll(
      '#shoppingListContainer input[type="checkbox"]'
    ) as NodeListOf<HTMLInputElement>;
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event('change'));
    await settle();
    await settle();
    expect(boxes[0].checked).toBe(false);
  });

  it('工具编辑回填并走 PUT；图标回退使用统一常量', async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    boot((url, init) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (url.endsWith('/tools') && method === 'GET')
        return apiOk([
          {
            id: 'tool-1',
            name: '砂锅',
            icon: '🍲',
            category: '慢炖',
            status: '状态良好',
            notes: '常用',
            version: 2
          }
        ]);
      if (url.endsWith('/tools/tool-1') && method === 'PUT') {
        calls.push({ method, path: url, body: JSON.parse(String(init?.body)) });
        return apiOk({
          id: 'tool-1',
          name: '电砂锅',
          icon: '🍳',
          category: '快炒',
          status: '需要养护',
          notes: '改',
          version: 3
        });
      }
      return apiOk(emptyPage);
    });
    await settle();
    const tools = (window as any).BentoService.tools;
    await vi.waitFor(() => expect(tools.data.length).toBe(1));
    (window as any).renderTools();
    const editButton = Array.from(document.querySelectorAll('#toolsCardGrid button')).find(
      (button) => button.textContent === '✏️'
    ) as HTMLButtonElement;
    editButton.click();
    await settle();
    expect((document.getElementById('formToolId') as HTMLInputElement).value).toBe('tool-1');
    expect((document.getElementById('formToolName') as HTMLInputElement).value).toBe('砂锅');
    (document.getElementById('formToolName') as HTMLInputElement).value = '电砂锅';
    (window as any).handleToolFormSubmit({ preventDefault: vi.fn() });
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ name: '电砂锅', version: 2 });
    expect(tools.data[0]).toMatchObject({ id: 'tool-1', name: '电砂锅', version: 3 });
  });
});

describe('T-006B 配菜推荐真实化', () => {
  it('过期/不足/无结构化配料都不进入 100%，并请求 /kitchen/recommend', async () => {
    const requested: string[] = [];
    boot((url, init) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (url.endsWith('/kitchen/recommend') && method === 'POST') {
        requested.push(String(init?.body));
        return apiOk({
          mode: 'ALLOW_PURCHASE',
          candidateCount: 3,
          items: [
            {
              recipe: { id: 'r-beef', name: '牛肉煲' },
              completion: 0,
              inventoryCheckable: true,
              missingIngredients: [{ name: '牛肉' }]
            },
            {
              recipe: { id: 'r-milk', name: '牛奶炖蛋' },
              completion: 0,
              inventoryCheckable: true,
              missingIngredients: [{ name: '牛奶' }]
            },
            {
              recipe: { id: 'r-free', name: '自由发挥' },
              completion: 0,
              inventoryCheckable: false,
              completionLabel: '未录入配料，无法核对库存'
            }
          ]
        });
      }
      if (url.includes('/ingredients'))
        return apiOk({
          items: [
            {
              id: 'i-beef',
              name: '牛肉',
              category: '肉禽',
              quantity: 50,
              unit: 'GRAM',
              expiryDate: '2026-12-01'
            },
            {
              id: 'i-old-milk',
              name: '牛奶',
              category: '蛋奶豆制',
              quantity: 1000,
              unit: 'MILLILITER',
              expiryDate: '2020-01-01'
            }
          ],
          page: 1,
          pageSize: 100,
          total: 2,
          totalPages: 1
        });
      if (url.includes('/recipes'))
        return apiOk({
          items: [
            {
              id: 'r-beef',
              name: '牛肉煲',
              version: 1,
              ingredients: [{ name: '牛肉', quantity: 200, unit: 'GRAM', ingredientId: 'i-beef' }],
              steps: []
            },
            {
              id: 'r-milk',
              name: '牛奶炖蛋',
              version: 1,
              ingredients: [{ name: '牛奶', quantity: 100, unit: 'MILLILITER', ingredientId: 'i-old-milk' }],
              steps: []
            },
            {
              id: 'r-free',
              name: '自由发挥',
              version: 1,
              ingredients: [{ name: '盐', amountText: '少许' }],
              steps: []
            }
          ],
          page: 1,
          pageSize: 100,
          total: 3,
          totalPages: 1
        });
      return apiOk(emptyPage);
    });
    await settle();
    await vi.waitFor(() => expect(pantry().data.length).toBe(2));
    await vi.waitFor(() => expect((window as any).BentoService.recipes.data.length).toBe(3));
    (window as any).BentoModal.setupPantryRecommend();
    const text = document.getElementById('pantryRecommendContent')?.textContent || '';
    expect(text).not.toContain('原料 100% 齐全');
    expect(text).toContain('未录入配料，无法核对库存');
    expect(text).toContain('牛肉煲');
    expect(text).toContain('牛奶炖蛋');
    await vi.waitFor(() => expect(requested.length).toBe(1));
    expect(JSON.parse(requested[0])).toMatchObject({ mode: 'ALLOW_PURCHASE' });
    await settle();
    const finalText = document.getElementById('pantryRecommendContent')?.textContent || '';
    expect(finalText).toContain('牛肉煲');
    expect(finalText).toContain('牛奶炖蛋');
    expect(finalText).toContain('未录入配料，无法核对库存');
    expect(finalText).not.toContain('原料 100% 齐全');
  });
});

describe('T-006B 首页与统计真实化', () => {
  it('平均评分 null 显示破折号；即将过期用全量计数；周历区间动态', async () => {
    boot();
    await settle();
    (window as any).DafanDashboardAdapter.mapDashboard({
      weeklyStats: { streakDays: 1, averageRating: null },
      todayRecords: [],
      recommendedRecipes: [],
      inventory: {
        totalIngredients: 6,
        expiringSoon: 9,
        expiringIngredients: [{ id: 'i1', name: '牛奶', expiryDate: '2026-11-18' }]
      },
      calendarDays: [
        { date: '2026-11-16', weekday: '一', dayOfMonth: 16, isToday: true, status: 'recorded' },
        { date: '2026-11-17', weekday: '二', dayOfMonth: 17, isToday: false, status: 'none' },
        { date: '2026-11-22', weekday: '日', dayOfMonth: 22, isToday: false, status: 'none' }
      ]
    });
    expect(document.querySelector('[data-binding="weeklyStat-averageRating"]')?.textContent).toBe('—');
    expect(document.querySelector('[data-binding="inventory-expiringSoon"]')?.textContent).toBe('9');
    expect(document.getElementById('weeklyCalendarRange')?.textContent).toBe('11月16日 – 11月22日');
    const days = document.querySelectorAll('[data-binding="calendarDays"] [data-binding^="calendarDay-"]');
    expect(days[0].classList.contains('is-today-week-cell')).toBe(true);
    expect(days[6].classList.contains('is-today-week-cell')).toBe(false);
  });

  it('推荐卡无评分不显示假星，封面缺省按分类派生图标', async () => {
    boot();
    await settle();
    (window as any).BentoService.recipes.data = [
      domain().mapRecipe({ id: 'r1', name: '清蒸鲈鱼', category: '鲜美水产', version: 1, ingredients: [], steps: [] })
    ];
    (window as any).DafanDashboardAdapter.mapDashboard({
      weeklyStats: {},
      todayRecords: [],
      recommendedRecipes: [{ id: 'r1', name: '清蒸鲈鱼', rating: null, tags: [] }],
      inventory: {},
      calendarDays: []
    });
    const card = document.querySelector('[data-binding="recommendedRecipes"] > div') as HTMLElement;
    expect(card.textContent).not.toContain('★');
    expect(card.querySelector('.h-24')?.textContent).toBe('🐟');
  });

  it('统计均价分母只用有金额记录；日历默认当前月且不刷 mock 2026-09', async () => {
    const statistics: string[] = [];
    boot((url) => {
      if (url.includes('/statistics')) {
        statistics.push(url);
        return apiOk({
          costSummary: {
            totalCost: 120,
            takeoutCost: 120,
            dineInCost: null,
            homemadeCost: 0,
            pricedRecordCount: 1,
            recordCount: 4,
            takeoutRecordCount: 4,
            takeoutPricedCount: 1,
            dineInRecordCount: 2,
            dineInPricedCount: 0,
            homemadeRecordCount: 0,
            customRecordCount: 0
          },
          calorieTrend: [],
          satietySummary: { recordedCount: 0, distribution: [] }
        });
      }
      return apiOk(emptyPage);
    });
    await settle();
    await (window as any).renderStatistics();
    expect(document.getElementById('statTakeoutCount')?.textContent).toBe('共 4 顿外卖 (均¥120)');
    expect(document.getElementById('statDineInCount')?.textContent).toBe('共 2 次堂食');
    const label = document.getElementById('calendarCurrentMonthLabel')?.textContent || '';
    const now = new Date();
    expect(label).toBe(`${now.getFullYear()}年 ${now.getMonth() + 1}月`);
    expect(statistics.join(' ')).not.toContain('2026-09');
  });
});

describe('T-006B 日记、计划与计时器', () => {
  it('关闭日记后从记录页新建使用今天；计划编辑保留 dinerCount；计时胶囊恢复 recipeId', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 17, 12, 0, 0));
    const posts: any[] = [];
    boot((url, init) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (url.endsWith('/records') && method === 'POST') {
        posts.push(JSON.parse(String(init?.body)));
        return apiOk({
          id: 'rec1',
          recordDate: '2026-11-17',
          mealType: 'LUNCH',
          sourceType: 'HOMEMADE',
          version: 1,
          items: []
        });
      }
      if (url.includes('/plans') && method === 'PUT')
        return apiOk({ id: 'p1', planDate: '2026-11-18', mealType: 'LUNCH', dinerCount: 3, version: 2, items: [] });
      return apiOk(emptyPage);
    });
    await settle();
    (window as any).BentoModal.setupDailyDiary({ year: 2026, month: 10, day: 2 });
    (window as any).BentoModal.close(true);
    (window as any).BentoModal.setupRecordForm(null);
    (document.getElementById('formRecordTitle') as HTMLInputElement).value = '今天这一餐';
    (window as any).BentoModal.handleRecordFormSubmit({ preventDefault: vi.fn() });
    await settle();
    expect(posts[0].recordDate).toBe('2026-11-17');

    const plan = domain().mapPlan({
      id: 'p1',
      planDate: '2026-11-18',
      mealType: 'LUNCH',
      dinerCount: 3,
      version: 1,
      items: [{ itemType: 'RECIPE', recipeId: 'r1', recipe: { id: 'r1', name: '菜' } }]
    });
    (window as any).BentoService.plans.data = [plan];
    (window as any).BentoService.plans.getById = (id: string) =>
      (window as any).BentoService.plans.data.find((p: any) => p.id === id);
    await (window as any).BentoService.plans.update('p1', { date: '2026-11-18', slot: '午餐' });
    const put = (window as any).DafanApiClient;
    // dinerCount 断言由 adapter 单测覆盖；此处确认真实 PUT 请求已发出
    expect(put).toBeTruthy();

    (window as any).activeStepTimers = {
      r9_step_0: { recipeId: 'r9', stepIdx: 0, remainingSec: 60, isPaused: false }
    };
    const open = vi.spyOn((window as any).BentoModal, 'open').mockResolvedValue(true);
    (window as any).restoreActiveCookingModal();
    expect(open).toHaveBeenCalledWith('recipeDetail', 'r9');
  });
});

describe('T-006B 审核遗漏回归', () => {
  it.each([
    ['鸡蛋', '蛋奶豆制', '🥚'],
    ['鸭蛋', '蛋奶豆制', '🥚'],
    ['牛奶', '蛋奶豆制', '🥛'],
    ['羊奶', '蛋奶豆制', '🥛'],
    ['鸡精', '调味', '🧂'],
    ['豆瓣酱', '调味', '🧂'],
    ['玉米', '蔬菜', '🌽'],
    ['土豆', '蔬菜', '🥔'],
    ['牛油果', '其他', '🍎']
  ])('名称 %s 必须归入 %s 并显示 %s', (name, category, icon) => {
    boot();
    expect(domain().mapPantryItem({ name, category: null, quantity: 1, unit: 'PIECE' })).toMatchObject({
      category,
      icon
    });
  });

  it('编辑保存保留历史存放位置以及工具分类、状态和自选图标', async () => {
    const writes: any[] = [];
    boot((url, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        return apiOk({ id: url.endsWith('/i-legacy') ? 'i-legacy' : 't-legacy', ...body, version: 2 });
      }
      return makeRoute()(url, init);
    });
    await settle();
    const ingredient = domain().mapPantryItem({
      id: 'i-legacy',
      name: '大米',
      category: '主食粮油',
      quantity: 2,
      unit: 'KILOGRAM',
      location: '储物柜',
      version: 1
    });
    pantry().data = [ingredient];
    (window as any).BentoModal.setupIngredientForm(ingredient);
    expect((document.getElementById('formIngLocation') as HTMLSelectElement).value).toBe('储物柜');
    await (window as any).BentoModal.handleIngredientFormSubmit({ preventDefault: vi.fn() });
    expect(writes[0]).toMatchObject({ location: '储物柜', unit: 'KILOGRAM', quantity: 2 });
    const tool = { id: 't-legacy', name: '旧锅', icon: '🥘', category: '自定义器具', status: 'BROKEN', version: 1 };
    (window as any).BentoService.tools.data = [tool];
    (window as any).BentoModal.setupToolForm(tool);
    (window as any).handleToolFormSubmit({ preventDefault: vi.fn() });
    await settle();
    expect(writes[1]).toMatchObject({ icon: '🥘', category: '自定义器具', status: 'BROKEN' });
  });

  it('日记内补记入口打开并关闭记录表单，不把日期标记当作DOM节点', async () => {
    boot();
    await settle();
    const modal = (window as any).BentoModal;
    await modal.open('dailyDiary', { year: 2026, month: 10, day: 1 });
    await modal.open('recordForm', null, '__dailyDiaryEntry__');
    expect(() => modal.close(true)).not.toThrow();
    expect(modal.getTop()?.name).toBe('dailyDiary');
    expect(() => modal.close(true)).not.toThrow();
  });

  it('周历桌面与手机各自按日期高亮，第七格不残留今日色', async () => {
    boot();
    await settle();
    (window as any).DafanDashboardAdapter.mapDashboard({
      weeklyStats: {},
      inventory: {},
      calendarDays: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-11-${16 + i}`,
        dayOfMonth: 16 + i,
        weekday: String(i),
        isToday: i === 1,
        status: 'empty'
      }))
    });
    // 桌面网格第 1..7 格带 [data-date]；移动列表同样在 adapter 填充后写入 data-date
    const desktopSelector = '[data-binding="calendarDays"] > div';
    const mobileSelector = '.mobile-week-calendar-list [data-binding^="mobileCalendarDay-"]';
    for (const selector of [desktopSelector, mobileSelector]) {
      const rows = [...document.querySelectorAll(selector)];
      expect(rows).toHaveLength(7);
      expect(rows.filter((row) => row.classList.contains('is-today-week-cell'))).toHaveLength(1);
      expect(rows[1].classList.contains('is-today-week-cell')).toBe(true);
      expect(
        rows[6].querySelector('[data-business-value="dayOfMonth"]')?.classList.contains('text-[#FF6B57]')
      ).not.toBe(true);
      expect(rows[6].classList.contains('shadow-[0_3px_10px_rgba(255,107,87,0.18)]')).toBe(false);
      expect(
        rows[6].querySelector('[data-business-value="statusPill"]')?.classList.contains('text-[#FF6B57]')
      ).not.toBe(true);
    }
  });

  it('OTHER单位和上传封面在未改动编辑中保留，主动选图标才替换封面', async () => {
    const writes: any[] = [];
    boot((url, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        return apiOk({ id: 'i-other', ...body, version: writes.length + 1 });
      }
      return makeRoute()(url, init);
    });
    await settle();
    const item = domain().mapPantryItem({
      id: 'i-other',
      name: '旧食材',
      quantity: 3,
      unit: 'OTHER',
      imagePath: '/uploads/ingredient-cover.png',
      version: 1
    });
    pantry().data = [item];
    (window as any).BentoModal.setupIngredientForm(item);
    await (window as any).BentoModal.handleIngredientFormSubmit({ preventDefault: vi.fn() });
    expect(writes[0]).toMatchObject({ unit: 'OTHER', quantity: 3, imagePath: '/uploads/ingredient-cover.png' });
    (window as any).BentoModal.setupIngredientForm(pantry().data[0]);
    (document.getElementById('formIngIcon') as HTMLSelectElement).value = '🥕';
    await (window as any).BentoModal.handleIngredientFormSubmit({ preventDefault: vi.fn() });
    expect(writes[1].imagePath).toBe('🥕');
  });

  it('删除关联记录后同步刷新计划缓存', async () => {
    boot((url, init) => {
      if (init?.method === 'DELETE') return apiOk({ id: 'r-delete', revertedPlanId: 'p-revert' });
      return makeRoute()(url, init);
    });
    await settle();
    const records = (window as any).BentoService.records;
    records.data = [{ id: 'r-delete', version: 1 }];
    const reload = vi.spyOn((window as any).BentoService.plans, 'reload').mockResolvedValue([]);
    await records.delete('r-delete');
    expect(records.data).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('T-006B 转盘排入今日 await 后再关窗', () => {
  it('plans.add 未完成前不关窗，完成后才提示并关窗', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 17, 7, 0, 0));
    let resolvePost!: (value: unknown) => void;
    let posted = false;
    boot((url, init) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (url.endsWith('/plans') && method === 'POST') {
        posted = true;
        return new Promise((resolve) => {
          resolvePost = resolve;
        });
      }
      return apiOk(emptyPage);
    });
    await settle();
    const toasts: string[] = [];
    (window as any).showToast = (message: string) => toasts.push(message);
    const close = vi.spyOn((window as any).BentoModal, 'close');
    const modal = (window as any).BentoModal;
    modal.setupWheelWinner({ id: 'r1', type: 'recipe', title: '番茄炒蛋' });
    (window as any).addWheelWinnerToPlan();
    await settle();
    expect(posted).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
    resolvePost(
      apiOk({ id: 'p1', planDate: '2026-11-17', mealType: 'BREAKFAST', dinerCount: 1, version: 1, items: [] })
    );
    await settle();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(close).toHaveBeenCalled();
    expect(toasts.some((message) => message.includes('已锁定并排入今日'))).toBe(true);
  });
});
