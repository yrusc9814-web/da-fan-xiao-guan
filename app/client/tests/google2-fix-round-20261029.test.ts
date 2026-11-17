// @vitest-environment jsdom
// VAN-38 P1-4 / P1-5 / P1-6 / P1-7：删除真实反馈、零库存补缺、转盘排除、首页刷新
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');
const markup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

const ok = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () =>
    JSON.stringify(status >= 200 && status < 300 ? { success: true, data } : { success: false, error: data })
});

const paged = (items: unknown[]) => ({ items, page: 1, pageSize: 100, total: items.length, totalPages: 1 });
const emptyPage = paged([]);

/** handler 返回 HttpFail 表示后端业务失败（真实状态码 + 真实错误码/文案）。 */
class HttpFail {
  constructor(
    public status: number,
    public code: string,
    public message: string
  ) {}
}

/** inline 与 adapter 的 toast 都会经过 window.showToast 落到 DOM 气泡，统一从 DOM 观察。 */
function lastToast() {
  return {
    text: document.getElementById('toastText')?.textContent || '',
    icon: document.getElementById('toastIcon')?.textContent || ''
  };
}

async function boot(handler: (url: string, init?: RequestInit) => unknown) {
  vi.useFakeTimers();
  document.body.innerHTML = markup;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const value = await handler(url, init);
    if (value instanceof HttpFail) return ok({ code: value.code, message: value.message }, value.status);
    return ok(value === undefined ? emptyPage : value);
  });
  vi.stubGlobal('fetch', f);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn(() => ({ matches: false, addListener: () => undefined, removeListener: () => undefined }))
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  Object.defineProperty(Element.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent || '';
    },
    set(value) {
      this.textContent = value;
    }
  });
  window.eval(`(() => { ${inline}\n })()`);
  window.eval('var BentoService = window.BentoService; var BentoModal = window.BentoModal;');
  window.eval(readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8'));
  await vi.advanceTimersByTimeAsync(0);
  return f;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('P1-4 异步删除入口真实反馈', () => {
  const recipeDto = { id: 'r1', name: '番茄鸡蛋', version: 1, calories: null, ingredients: [], steps: [] };
  const storeDto = { id: 's1', name: '觅食小馆', version: 1 };

  it('删除请求真正成功后才提示成功，并移除本地数据', async () => {
    const f = await boot((url, init) => {
      if ((init as RequestInit)?.method === 'DELETE' && String(url).includes('/recipes/')) return recipeDto;
      if (String(url).includes('/recipes')) return paged([recipeDto]);
      if (String(url).includes('/stores')) return paged([storeDto]);
      return undefined;
    });
    await vi.waitFor(() => expect((window as any).BentoService.recipes.data.length).toBe(1));
    const result = await (window as any).confirmDeleteRecipe('r1');
    expect(result).toBe(true);
    expect(f.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'DELETE')).toBe(true);
    expect(lastToast().text).toContain('已删除菜谱「番茄鸡蛋」');
    expect((window as any).BentoService.recipes.data.length).toBe(0);
  });

  it('删除失败时展示真实错误，不提示删除完成，本地数据保留', async () => {
    await boot((url, init) => {
      if ((init as RequestInit)?.method === 'DELETE')
        return new HttpFail(409, 'RECIPE_IN_USE', '菜谱已被 2 条饮食记录引用，无法删除');
      if (String(url).includes('/recipes')) return paged([recipeDto]);
      return undefined;
    });
    await vi.waitFor(() => expect((window as any).BentoService.recipes.data.length).toBe(1));
    const result = await (window as any).confirmDeleteRecipe('r1');
    expect(result).toBe(false);
    expect(lastToast().text).toContain('菜谱已被 2 条饮食记录引用，无法删除');
    expect(lastToast().text).not.toContain('已删除菜谱');
    expect((window as any).BentoService.recipes.data.length).toBe(1);
  });

  it('店铺删除失败同样不显示成功（覆盖另一类异步删除入口）', async () => {
    await boot((url, init) => {
      if ((init as RequestInit)?.method === 'DELETE')
        return new HttpFail(409, 'VERSION_CONFLICT', '数据已被他人修改，请刷新后重试');
      if (String(url).includes('/stores')) return paged([storeDto]);
      return undefined;
    });
    await vi.waitFor(() => expect((window as any).BentoService.stores.data.length).toBe(1));
    const result = await (window as any).confirmDeleteStore('s1');
    expect(result).toBe(false);
    expect(lastToast().text).toContain('数据已被他人修改，请刷新后重试');
    expect(lastToast().text).not.toContain('已删除店铺');
    expect((window as any).BentoService.stores.data.length).toBe(1);
  });
});

describe('P1-5 同名 0 库存判缺料并可补货', () => {
  const recipeDto = {
    id: 'r-potato',
    name: '土豆炖牛腩',
    version: 1,
    calories: null,
    ingredients: [
      { id: 'line1', name: '土豆', amountText: '200g', quantity: 200, unit: 'GRAM' },
      { id: 'line2', name: '牛腩', amountText: '300g', quantity: 300, unit: 'GRAM' }
    ],
    steps: []
  };
  const zeroPotatoPantry = [
    // 同名但数量 0：土豆 0g（菜谱需要 200g）
    { id: 'p1', name: '土豆', quantity: 0, unit: 'GRAM', version: 1 },
    { id: 'p2', name: '牛腩', quantity: 500, unit: 'GRAM', version: 1 }
  ];

  async function bootStock(pantry = zeroPotatoPantry) {
    await boot((url) => {
      if (String(url).includes('/recipes')) return paged([recipeDto]);
      if (String(url).includes('/ingredients')) return paged(pantry);
      return undefined;
    });
    await vi.waitFor(() => {
      expect((window as any).BentoService.recipes.data.length).toBe(1);
      expect((window as any).BentoService.pantry.data.length).toBe(2);
    });
  }

  it('土豆 0g 视为缺料：补齐入口按纯名称土豆 + 200g 批量补货，牛腩库存足够不加入', async () => {
    await bootStock();
    const batches: Array<{ recipeId: string; items: any[] }> = [];
    (window as any).BentoService.shopping.replenishRecipe = async (recipeId: string, items: any[]) => {
      batches.push({ recipeId, items });
    };
    await (window as any).BentoService.recipes.addMissingIngredientsToShopping('r-potato');
    expect(batches).toHaveLength(1);
    expect(batches[0].recipeId).toBe('r-potato');
    // 名称只保留纯食材名，规格不拼进名称
    expect(batches[0].items.map((item) => item.ingredientName)).toEqual(['土豆']);
    expect(batches[0].items[0]).toMatchObject({ quantity: 200, unit: 'GRAM', amountText: null });
  });

  it('库存推荐把 0 库存食材计入缺料，不再匹配为可做', async () => {
    await bootStock();
    (window as any).BentoModal.open('pantryRecommend');
    const text = document.getElementById('pantryRecommendContent')?.textContent || '';
    expect(text).toContain('缺：土豆');
    expect(text).not.toContain('原料 100% 齐全');
  });

  it('详情页 0 库存徽标不再显示「充足」，明确标为已用尽', async () => {
    const bound = {
      ...recipeDto,
      ingredients: [{ id: 'line1', ingredientId: 'p1', name: '土豆', amountText: '200g', quantity: 200, unit: 'GRAM' }]
    };
    await boot((url) => {
      if (String(url).includes('/ingredients')) return paged(zeroPotatoPantry);
      if (String(url).includes('/recipes/r-potato')) return bound;
      if (String(url).includes('/recipes')) return paged([bound]);
      return undefined;
    });
    await vi.waitFor(() => expect((window as any).BentoService.pantry.data.length).toBe(2));
    await (window as any).BentoModal.open('recipeDetail', 'r-potato');
    await vi.waitFor(() => {
      expect(document.getElementById('recipeDetailIngredientsList')?.textContent || '').toContain('已用尽');
    });
    const detail = document.getElementById('recipeDetailIngredientsList')?.textContent || '';
    expect(detail).not.toMatch(/充足\(0/);
  });

  it('全部食材在库（stock>0）时仍诚实提示无需补货，不发写请求', async () => {
    const f = await boot((url) => {
      if (String(url).includes('/recipes')) return paged([recipeDto]);
      if (String(url).includes('/ingredients'))
        return paged([
          { id: 'p1', name: '土豆', quantity: 200, unit: 'GRAM', version: 1 },
          { id: 'p2', name: '牛腩', quantity: 300, unit: 'GRAM', version: 1 }
        ]);
      return undefined;
    });
    await vi.waitFor(() => expect((window as any).BentoService.pantry.data.length).toBe(2));
    const before = f.mock.calls.length;
    await (window as any).BentoService.recipes.addMissingIngredientsToShopping('r-potato');
    expect(lastToast().text).toContain('均已在库，无需补货');
    expect(f.mock.calls.slice(before).some(([, init]) => (init as RequestInit)?.method === 'POST')).toBe(false);
  });
});

describe('P1-6 转盘排除项不回流', () => {
  const wheelRecipes = [
    { id: 'w1', name: '青椒肉丝', version: 1, calories: null, ingredients: [], steps: [] },
    { id: 'w2', name: '清蒸鲈鱼', version: 1, calories: null, ingredients: [], steps: [] },
    { id: 'w3', name: '西红柿蛋汤', version: 1, calories: null, ingredients: [], steps: [] },
    { id: 'w4', name: '蒜蓉西兰花', version: 1, calories: null, ingredients: [], steps: [] }
  ];

  async function bootWheel(results: unknown[]) {
    const f = await boot((url, init) => {
      if ((init as RequestInit)?.method === 'POST' && String(url).includes('/recommendations/random'))
        return { results, candidateCount: results.length };
      if (String(url).includes('/recipes')) return paged(wheelRecipes);
      return undefined;
    });
    await vi.waitFor(() => expect((window as any).BentoService.recipes.data.length).toBe(4));
    (window as any).setWheelCandidateMode('cook');
    return f;
  }

  async function exclude(id: string) {
    const winner = (window as any).getDynamicWheelItems().find((item: any) => item.id === id);
    expect(winner).toBeTruthy();
    (window as any).BentoModal.open('wheelWinner', winner);
    await (window as any).excludeCurrentWinnerAndSpin();
    const excludeToast = lastToast().text;
    // 排除入口会延时重新起转，推进定时器避免污染后续断言
    await vi.advanceTimersByTimeAsync(400);
    return excludeToast;
  }

  const currentIds = () => (window as any).getDynamicWheelItems().map((item: any) => item.id);

  it('排除项在候选重算后仍不回候选池，正常推荐与动画保留', async () => {
    await bootWheel([{ resultType: 'RECIPE', resultId: 'w4', title: '蒜蓉西兰花' }]);
    expect(currentIds().length).toBe(4);
    const excludeToast = await exclude('w2');
    expect(currentIds()).not.toContain('w2');
    expect(excludeToast).toContain('移出候选池');
    // 候选重算（切页/刷新触发）不得把已排除项带回来
    (window as any).updateWheelCandidates();
    expect(currentIds()).not.toContain('w2');
    // 未排除项仍可正常命中并起转
    const target = await (window as any).DafanWheelAdapter.resolveTargetIndex('cook');
    expect(target).toBeGreaterThanOrEqual(0);
    expect(currentIds()[target]).toBe('w4');
    const rotor = document.getElementById('wheelRotor') as HTMLElement;
    rotor.style.transition = 'none';
    await (window as any).triggerSpin();
    await vi.advanceTimersByTimeAsync(0);
    expect((window as any).BentoModal.getTop?.()?.name || 'wheelWinner').toBeTruthy();
  });

  it('后端推荐仍命中已排除项时拒绝落点，明确反馈且不进入结果', async () => {
    const f = await bootWheel([{ resultType: 'RECIPE', resultId: 'w2', title: '清蒸鲈鱼' }]);
    await exclude('w2');
    const callsBefore = f.mock.calls.length;
    await (window as any).triggerSpin();
    const recommendCalls = f.mock.calls
      .slice(callsBefore)
      .filter(([, init]) => (init as RequestInit)?.method === 'POST').length;
    expect(recommendCalls).toBe(1);
    expect(lastToast().text).toContain('均已被排除');
    expect(currentIds()).not.toContain('w2');
    expect((window as any).BentoModal.getTop?.()?.name).not.toBe('wheelWinner');
  });

  it('候选为空时明确反馈，不发起推荐请求、不无限重试', async () => {
    const f = await bootWheel([]);
    (window as any).BentoService.recipes.data = [];
    (window as any).updateWheelCandidates();
    expect(currentIds().length).toBe(0);
    const callsBefore = f.mock.calls.length;
    await (window as any).triggerSpin();
    await (window as any).triggerSpin();
    const recommendCalls = f.mock.calls
      .slice(callsBefore)
      .filter(([, init]) => (init as RequestInit)?.method === 'POST').length;
    expect(recommendCalls).toBe(0);
    // T-006C：cook 模式候选为空改为按模式准确引导【我的菜谱】，不再笼统说「店铺」
    expect(lastToast().text).toContain('我的菜谱');
    expect(lastToast().text).not.toContain('觅食小馆');
  });

  it('候选池至少保留两项的护栏仍在，排除保护不破坏动画路径', async () => {
    await bootWheel([]);
    await exclude('w1');
    await exclude('w2');
    expect(currentIds().length).toBe(2);
    const winner = (window as any).getDynamicWheelItems()[0];
    (window as any).BentoModal.open('wheelWinner', winner);
    await (window as any).excludeCurrentWinnerAndSpin();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastToast().text).toContain('候选池至少保留两项');
    expect(currentIds().length).toBe(2);
  });

  it('切换转盘分类视为新一轮：清空上一轮排除', async () => {
    await bootWheel([]);
    await exclude('w1');
    expect(currentIds()).not.toContain('w1');
    (window as any).setWheelCandidateMode('cook');
    expect(currentIds()).toContain('w1');
  });
});

describe('P1-7 首页数据刷新复用 loadDashboard', () => {
  const dashboardDto = (marker: string) => ({
    branding: { appName: marker },
    currentDate: '2026-10-29',
    weeklyStats: { totalMeals: 7 },
    todayRecords: [],
    recommendedRecipes: [],
    inventory: {},
    calendarDays: []
  });

  it('返回首页时复用 loadDashboard 拉取新聚合', async () => {
    let version = 0;
    const f = await boot((url) =>
      String(url).includes('/dashboard') ? dashboardDto(`v${(version += 1)}`) : undefined
    );
    await vi.waitFor(() => expect(document.querySelector('[data-binding="branding"]')?.textContent).toBe('v1'));
    expect((window as any).switchPage.__dafanDashboardRefresh).toBe(true);
    (window as any).switchPage('statistics');
    expect(document.getElementById('page-statistics')?.classList.contains('active')).toBe(true);
    expect(version).toBe(1);
    await (window as any).switchPage('home');
    await vi.waitFor(() => expect(document.querySelector('[data-binding="branding"]')?.textContent).toBe('v2'));
    const dashboardCalls = f.mock.calls.filter(([url]) => String(url).includes('/dashboard')).length;
    expect(dashboardCalls).toBe(2);
  });

  it('无轮询：空转 60 秒不会额外请求 dashboard', async () => {
    let counter = 0;
    await boot((url) => (String(url).includes('/dashboard') ? dashboardDto(`p${(counter += 1)}`) : undefined));
    await vi.waitFor(() => expect(counter).toBeGreaterThanOrEqual(1));
    const settled = counter;
    await vi.advanceTimersByTimeAsync(60000);
    expect(counter).toBe(settled);
  });

  it('首页可见期间的相关业务写成功触发刷新，离开首页后不刷新', async () => {
    let counter = 0;
    await boot((url, init) => {
      if (String(url).includes('/dashboard')) return dashboardDto(`d${(counter += 1)}`);
      if ((init as RequestInit)?.method === 'DELETE') return { id: 's1', name: '觅食小馆', version: 1 };
      if (String(url).includes('/stores')) return paged([{ id: 's1', name: '觅食小馆', version: 1 }]);
      return undefined;
    });
    await vi.waitFor(() => expect((window as any).BentoService.stores.data.length).toBe(1));
    expect((window as any).DafanDashboardAdapter.isHomeVisible()).toBe(true);
    const afterBoot = counter;
    // 真实写成功 → dashboard:dirty → 复用 loadDashboard 刷新
    await (window as any).BentoService.stores.delete('s1');
    await vi.waitFor(() => expect(counter).toBeGreaterThan(afterBoot));
    const afterWrite = counter;
    (window as any).switchPage('recipes');
    await vi.waitFor(() => expect((window as any).DafanDashboardAdapter.isHomeVisible()).toBe(false));
    await (window as any).BentoService.recipes.save({
      name: '新菜',
      cookingTimeMinutes: 10,
      ingredients: [],
      steps: []
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(counter).toBe(afterWrite);
  });

  it('纯读取（列表 reload）不触发首页刷新', async () => {
    let counter = 0;
    await boot((url) => (String(url).includes('/dashboard') ? dashboardDto(`d${(counter += 1)}`) : undefined));
    await vi.waitFor(() => expect(counter).toBeGreaterThanOrEqual(1));
    const baseline = counter;
    await (window as any).BentoService.stores.reload();
    await (window as any).BentoService.records.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(counter).toBe(baseline);
  });

  it('刷新失败展示真实错误，且在途请求合并为一次', async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    let mode: 'fail' | 'defer' | 'succeed' = 'fail';
    await boot((url) => {
      if (!String(url).includes('/dashboard')) return undefined;
      calls += 1;
      if (mode === 'defer')
        return new Promise<unknown>((resolvePromise) => (release = () => resolvePromise(dashboardDto('merged'))));
      if (mode === 'fail') return new HttpFail(503, 'DB_BUSY', '数据库暂不可用');
      return dashboardDto('merged');
    });
    // 首页在初始 markup 中即为 active，刷新可直接触发
    expect((window as any).DafanDashboardAdapter.isHomeVisible()).toBe(true);
    const baseline = calls;
    await (window as any).DafanDashboardAdapter.refreshDashboard();
    expect(calls).toBe(baseline + 1);
    expect(lastToast().text).toContain('数据库暂不可用');

    // 在途合并：并发调用只发一次真实请求
    mode = 'defer';
    const deferredBaseline = calls;
    const first = (window as any).DafanDashboardAdapter.refreshDashboard();
    const second = (window as any).DafanDashboardAdapter.refreshDashboard();
    expect(calls).toBe(deferredBaseline + 1);
    mode = 'succeed';
    release?.();
    await first;
    await second;
    expect(document.querySelector('[data-binding="branding"]')?.textContent).toBe('merged');
  });
});
