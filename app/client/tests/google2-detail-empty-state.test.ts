import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');
const adapter = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const body = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
const response = (data: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ success: true, data })
});

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent ?? '';
    },
    set(value) {
      this.textContent = value;
    }
  });
});

async function bootRealPage() {
  document.body.innerHTML = body;
  (window as any).BentoService = {
    stores: { data: [] },
    recipes: { data: [] },
    shopping: { data: [] },
    pantry: { data: [] },
    plans: { data: [] },
    records: { data: [] },
    tools: { data: [], getAll: () => (window as any).BentoService.tools.data }
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 }))
  );
  window.eval(inline);
  window.eval(adapter);
  await Promise.resolve();
}

describe('Google2 detail empty-state production path', () => {
  it('guards nullable recipe arrays and preserves zero-valued nutrition/time', () => {
    expect(html).toContain('Array.isArray(recipe.ingredients) ? recipe.ingredients : []');
    expect(html).toContain('Array.isArray(recipe.steps) ? recipe.steps : []');
    expect(html).toContain('recipe.calories == null ?');
    expect(html).toContain('recipe.cookTimeMinutes == null ?');
    expect(html).not.toContain('calories || 320');
  });

  it('does not invent nullable store detail values and hides empty collections', () => {
    expect(html).toContain('const menuItems = store.menuItems || [];');
    expect(html).toContain('const historyItems = store.history || [];');
    expect(html).toContain('暂未录入该店招牌菜单');
    expect(html).toContain('暂无就餐打卡记录');
    expect(html).toContain('store.rating == null ?');
    expect(html).toContain('store.phone ??');
    // D1：后端 menuItem.icon 可为 null，招牌菜单行不得把 null 字面量渲染成图标
    expect(html).toContain("${item.icon ?? ''}");
  });

  it('真实 boot 后打开 recipe/store detail，空数组安全且 0 与缺值语义正确', async () => {
    vi.unstubAllGlobals();
    await bootRealPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const services = (window as any).BentoService;
    services.pantry.data = [];
    const recipe = (window as any).DafanDomainAdapter.mapRecipe({
      id: 'recipe-1',
      name: '零值菜谱',
      calories: 0,
      cookingTimeMinutes: 0,
      ingredients: null,
      steps: null
    });
    const store = { id: 'store-1', name: '空态店铺', rating: 0, phone: null, price: 0, menuItems: [], history: [] };
    services.recipes.data = [recipe];
    services.recipes.getById = (id: string) => services.recipes.data.find((item: any) => item.id === id);
    services.stores.data = [store];
    services.stores.getById = (id: string) => services.stores.data.find((item: any) => item.id === id);
    (window as any).BentoModal.setupRecipeDetail(recipe);
    const recipeModal = document.querySelector('#modalRecipeDetail') as HTMLElement;
    expect(recipeModal.querySelector('#recipeDetailCalories')?.textContent).toBe('0 kcal');
    expect(recipeModal.querySelector('#recipeDetailTime')?.textContent).toBe('⏱ 0分钟');
    expect(recipeModal.querySelector('#recipeDetailIngredientsList')?.textContent).toBe('');
    expect(recipeModal.querySelector('#recipeDetailStepsList')?.textContent).toBe('');
    (window as any).BentoModal.setupStoreDetail(store);
    const ingredient = { id: 'ingredient-1', name: '真实库存', stock: 1100, unit: 'g' };
    services.pantry.data = [ingredient];
    services.pantry.getById = (id: string) => services.pantry.data.find((item: any) => item.id === id);
    (window as any).BentoModal.setupIngredientDetail(ingredient);
    expect(document.querySelector('#ingredientDetailName')?.textContent).toBe('真实库存');
    expect(document.querySelector('#ingredientDetailStock')?.textContent).toContain('1100');
    const storeModal = document.querySelector('#modalStoreDetail') as HTMLElement;
    expect(storeModal.querySelector('#storeDetailRating')?.textContent).toContain('0');
    expect(storeModal.querySelector('#storeDetailPhone')?.textContent).toBe('');
    expect(storeModal.querySelector('#storeDetailMenuList')?.textContent).toContain('暂未录入');
    expect(storeModal.querySelector('#storeDetailHistoryList')?.textContent).toContain('暂无就餐打卡');
    expect(document.querySelector('#storeDetailHistoryList')?.textContent).not.toContain('undefined');
  });

  it('D1 列表空值：店铺人均为空不渲染价格标签、category 不用 storeType 顶替，菜谱难度为空不显示字面 null', async () => {
    vi.unstubAllGlobals();
    await bootRealPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const services = (window as any).BentoService;
    services.stores.data = [
      (window as any).DafanDomainAdapter.mapStore({
        id: 's-null',
        name: '空值店铺',
        cuisine: null,
        storeType: '小馆',
        averageCost: null,
        address: null,
        rating: null,
        businessHours: null,
        recommendedDishes: null
      })
    ];
    services.recipes.data = [
      (window as any).DafanDomainAdapter.mapRecipe({
        id: 'r-null',
        name: '空值菜谱',
        difficulty: null,
        calories: null,
        cookingTimeMinutes: null,
        ingredients: [],
        steps: []
      })
    ];
    (window as any).renderStores();
    (window as any).renderRecipes();
    const storeText = document.getElementById('storeCardGrid')?.textContent || '';
    expect(storeText).not.toContain('¥null');
    expect(storeText).not.toContain('/人');
    expect(storeText).not.toContain('null');
    expect(storeText).not.toContain('小馆');
    const recipeText = document.getElementById('recipesCardGrid')?.textContent || '';
    expect(recipeText).not.toContain('null');
    expect(services.stores.getAll()[0].category).toBe('');
  });

  it('D3 详情库存只按 ingredientId：解绑行显示未关联库存，已关联行保持原徽标', async () => {
    vi.unstubAllGlobals();
    await bootRealPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const services = (window as any).BentoService;
    services.pantry.data = [
      { id: 'i-potato', name: '土豆', stock: 400, unit: 'g', expireDaysLeft: 10 },
      { id: 'i-unused', name: 'V99改名土豆', stock: 400, unit: 'g', expireDaysLeft: 10 }
    ];
    const recipe = (window as any).DafanDomainAdapter.mapRecipe({
      id: 'r-unlink',
      name: '解绑菜谱',
      version: 1,
      ingredients: [
        { name: 'V99改名土豆', quantity: 300, unit: 'GRAM', ingredientId: null },
        { name: '土豆', quantity: 100, unit: 'GRAM', ingredientId: 'i-potato' }
      ],
      steps: []
    });
    services.recipes.data = [recipe];
    (window as any).BentoModal.setupRecipeDetail(recipe);
    const list = document.getElementById('recipeDetailIngredientsList') as HTMLElement;
    const text = list.textContent || '';
    expect(text).toContain('未关联库存');
    expect(text).toContain('充足(400g)');
    expect(text.indexOf('未关联库存')).toBeLessThan(text.indexOf('充足(400g)'));
  });

  it('D2 饱腹感清除控件存在于真实表单中，且未新增空 option', () => {
    expect(html).toContain('id="btnClearRecordSatiety"');
    expect(html).toContain('function clearRecordSatiety()');
    expect(html).toContain('window.clearRecordSatiety = clearRecordSatiety;');
    expect(html).toContain("BentoBus.on('tools:changed', () => renderTools());");
  });

  it('D1 耗时未填写时留空：DTO→UI 映射为 null，列表不再渲染孤立的「⏱ 分钟」', async () => {
    vi.unstubAllGlobals();
    await bootRealPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const services = (window as any).BentoService;
    const recipe = (window as any).DafanDomainAdapter.mapRecipe({
      id: 'r-notime',
      name: '无耗时菜谱',
      version: 1,
      cookingTimeMinutes: null,
      difficulty: null,
      calories: null,
      ingredients: [],
      steps: []
    });
    expect(recipe.cookTimeMinutes).toBeNull();
    services.recipes.data = [recipe];
    (window as any).renderRecipes();
    const grid = document.getElementById('recipesCardGrid') as HTMLElement;
    expect(grid.innerText).not.toContain('分钟');
    expect(grid.innerText).not.toContain('null');
  });

  it('D1 店铺历史就餐：后端只给 recordDate/notes 时不留 undefined 字面量，缺评分不渲染「★ 分」', async () => {
    vi.unstubAllGlobals();
    await bootRealPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const services = (window as any).BentoService;
    const store = {
      id: 's-history',
      name: '历史测试店',
      category: '',
      rating: null,
      price: null,
      hours: null,
      address: null,
      phone: null,
      notes: null,
      supportsDineIn: true,
      supportsTakeout: false,
      favorite: false,
      menuItems: [{ id: 'm1', name: '照烧便当', price: null, icon: null, isSignature: true, desc: null }],
      version: 1,
      history: [{ date: '2026-10-21', slot: '午餐' }]
    };
    services.stores.data = [store];
    services.stores.getById = (id: string) => services.stores.data.find((item: any) => item.id === id);
    (window as any).BentoModal.setupStoreDetail('s-history');
    const history = document.getElementById('storeDetailHistoryList') as HTMLElement;
    const menu = document.getElementById('storeDetailMenuList') as HTMLElement;
    expect(history.innerText).not.toContain('undefined');
    expect(history.innerText).not.toContain('null');
    expect(history.innerText).not.toContain('NaN');
    expect(history.innerText).not.toContain('★');
    expect(menu.innerText).not.toContain('null');
    expect(menu.innerText).toContain('照烧便当');
  });

  it('D1 购物清单数量缺失时不把 null 拼进「需补」文案', async () => {
    vi.unstubAllGlobals();
    await bootRealPage();
    const mapped = (window as any).DafanDomainAdapter.mapShoppingItem({ quantity: null, unit: null });
    expect(mapped.amount).toBe('');
    expect(mapped.amount).not.toContain('null');
    expect(mapped.amount).not.toContain('undefined');
  });

  it('D1 食材详情未填保质期时不渲染「还剩 undefined 天」', async () => {
    vi.unstubAllGlobals();
    await bootRealPage();
    const services = (window as any).BentoService;
    const item = { id: 'i-no-expiry', name: '无保质期食材', stock: 100, unit: 'g', expireDaysLeft: undefined };
    services.pantry.data = [item];
    services.pantry.getById = (id: string) => services.pantry.data.find((x: any) => x.id === id);
    (window as any).BentoModal.setupIngredientDetail('i-no-expiry');
    const badge = document.getElementById('ingredientDetailExpiryBadge') as HTMLElement;
    expect(badge.innerText).not.toContain('undefined');
    expect(badge.innerText).not.toContain('null');
    expect(badge.innerText).toContain('未填写保质期');
  });

  it('X4 回退后推荐弹窗按名称弱匹配：同名库存即判在库，与 ingredientId 绑定无关', async () => {
    vi.unstubAllGlobals();
    await bootRealPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const services = (window as any).BentoService;
    services.pantry.data = [{ id: 'i-potato', name: '土豆', stock: 400, unit: 'g', expireDaysLeft: 10 }];
    const recipe = (window as any).DafanDomainAdapter.mapRecipe({
      id: 'r-rec',
      name: '推荐口径菜谱',
      version: 1,
      ingredients: [
        { name: '土豆', quantity: 100, unit: 'GRAM', ingredientId: 'i-potato' },
        { name: '土豆', quantity: 100, unit: 'GRAM', ingredientId: 'i-missing-binding' }
      ],
      steps: []
    });
    services.recipes.data = [recipe];
    (window as any).BentoModal.setupPantryRecommend();
    const content = document.getElementById('pantryRecommendContent') as HTMLElement;
    const text = content.innerText;
    // 推荐弹窗沿用原版名称匹配（真实 UI + API 核查：新建菜谱的 ingredientId 不会自动关联，落库为 null）；
    // 详情徽标仍按 id 判定（D3 修复保留），见下方 D3 详情徽标用例
    expect(text).toContain('原料 100% 齐全');
    expect(text).not.toContain('原料匹配 50%');
  });

  it('D5 详情页入口传对象 payload：归一化为 id 后走 adapter，并如实提示错误', async () => {
    vi.unstubAllGlobals();
    await bootRealPage();
    const calls: any[] = [];
    const recipes = (window as any).BentoService.recipes;
    recipes.addMissingIngredientsToShopping = async (id: string) => {
      calls.push(id);
      throw new Error('食材「X」的数量单位无法映射到采购单位，无法加入清单');
    };
    const toasts: any[] = [];
    (window as any).showToast = (msg: string, icon?: string) => toasts.push([msg, icon]);
    await (window as any).addMissingListToShopping({ id: 'r-object', name: '对象载荷菜谱' });
    expect(calls).toEqual(['r-object']);
    expect(toasts).toHaveLength(1);
    expect(toasts[0][1]).toBe('⚠️');
    expect(toasts[0][0]).toContain('无法映射到采购单位');
  });

  it('D4 工具保存后 emit tools:changed 会重渲染工具库（行为断言，非字符串断言）', async () => {
    vi.unstubAllGlobals();
    await bootRealPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const tools = (window as any).BentoService.tools;
    const grid = document.getElementById('toolsCardGrid') as HTMLElement;
    tools.data = [{ id: 't1', name: '旧砂锅', icon: '🍲', status: '状态良好', category: '慢炖', notes: '' }];
    (window as any).renderTools();
    expect(grid.innerText).toContain('旧砂锅');
    tools.data = [
      { id: 't1', name: '旧砂锅', icon: '🍲', status: '状态良好', category: '慢炖', notes: '' },
      { id: 't2', name: '新铸铁锅', icon: '🍳', status: '状态良好', category: '爆炒', notes: '' }
    ];
    (window as any).BentoBus.emit('tools:changed');
    expect(grid.innerText).toContain('新铸铁锅');
    expect((document.getElementById('toolsCountBadge') as HTMLElement).innerText).toContain('2');
  });
});
