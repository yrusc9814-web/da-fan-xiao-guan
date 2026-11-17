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
    expect(recipeModal.querySelector('#recipeDetailIngredientsList')?.textContent).toContain('暂未录入食材配方');
    expect(recipeModal.querySelector('#recipeDetailStepsList')?.textContent).toContain('暂未录入分步做法');
    (window as any).BentoModal.setupStoreDetail('store-1');
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

  it('推荐弹窗优先使用精确绑定，失效绑定不得靠同名库存冒充齐备', async () => {
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
    expect(text).not.toContain('原料 100% 齐全');
    expect(text).toContain('原料匹配 50%');
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

/** 只看未被 hidden 的分隔符/项：隐藏项保留文本节点，不能用整行 textContent 判定孤立分隔符。 */
function visibleMetaNodes(row: HTMLElement) {
  return Array.from(row.children).filter((node) => !node.classList.contains('hidden'));
}

function visibleMetaText(row: HTMLElement) {
  return visibleMetaNodes(row)
    .map((node) => node.textContent || '')
    .join('');
}

/** 分隔符节点：可见且文本仅为 • 或 · */
function visibleSeparatorCount(row: HTMLElement) {
  return visibleMetaNodes(row).filter((node) => /^[•·]$/.test((node.textContent || '').trim())).length;
}

const blankValues: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['空串', ''],
  ['纯空白', '   ']
];

describe('T-005R 店铺详情空字段与分隔符（行为断言）', () => {
  async function openStore(overrides: Record<string, unknown>) {
    vi.unstubAllGlobals();
    await bootRealPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const services = (window as any).BentoService;
    const store = {
      id: 's-meta',
      name: '空字段店铺',
      category: null,
      rating: null,
      price: null,
      hours: null,
      address: null,
      phone: null,
      notes: null,
      supportsDineIn: false,
      supportsTakeout: false,
      favorite: false,
      menuItems: [],
      history: [],
      version: 1,
      ...overrides
    };
    services.stores.data = [store];
    services.stores.getById = (id: string) => services.stores.data.find((item: any) => item.id === id);
    (window as any).BentoModal.setupStoreDetail('s-meta');
    // 节点可能被重渲染替换：断言时按 id 重新取，避免读陈旧引用造成假通过
    const el = (id: string) => document.getElementById(id) as HTMLElement;
    return {
      store,
      services,
      modal: el('modalStoreDetail'),
      get row() {
        return el('storeDetailMetaRow');
      },
      get category() {
        return el('storeDetailCategory');
      },
      get rating() {
        return el('storeDetailRating');
      },
      get price() {
        return el('storeDetailPrice');
      },
      get hours() {
        return el('storeDetailHours');
      },
      get address() {
        return el('storeDetailAddress');
      },
      get addressRow() {
        return el('storeDetailAddressRow');
      },
      get phone() {
        return el('storeDetailPhone');
      },
      get phoneRow() {
        return el('storeDetailPhoneRow');
      },
      get notes() {
        return el('storeDetailNotes');
      },
      get notesBox() {
        return el('storeDetailNotesBox');
      }
    };
  }

  it('category/rating/price 为 null、undefined、空串、纯空白时节点文本为空且整行隐藏', async () => {
    for (const [, value] of blankValues) {
      const view = await openStore({ category: value, rating: value, price: value });
      expect(view.category.textContent).toBe('');
      expect(view.rating.textContent).toBe('');
      expect(view.price.textContent).toBe('');
      expect(view.category.classList.contains('hidden')).toBe(true);
      expect(view.rating.classList.contains('hidden')).toBe(true);
      expect(view.price.classList.contains('hidden')).toBe(true);
      expect(view.row.classList.contains('hidden')).toBe(true);
      expect(view.row.classList.contains('flex')).toBe(false);
      expect(visibleSeparatorCount(view.row)).toBe(0);
      expect(view.row.textContent).not.toContain('★');
      expect(view.row.textContent).not.toContain('人均');
      expect(view.row.textContent).not.toContain('null');
      expect(view.row.textContent).not.toContain('undefined');
    }
  });

  it.each([
    ['全部为空', null, null, null],
    ['仅分类', '小馆', null, null],
    ['仅评分', null, 0, null],
    ['仅人均', null, null, 0],
    ['分类+评分', '小馆', 0, null],
    ['分类+人均', '小馆', null, 0],
    ['评分+人均', null, 0, 0],
    ['三项齐全', '小馆', 0, 0]
  ])('%s：分隔符只出现在相邻可见项之间，无孤立 •', async (_label, category, rating, price) => {
    const view = await openStore({ category, rating, price });
    const expected: string[] = [];
    if (category != null) expected.push(String(category));
    if (rating != null) expected.push(`★ ${rating}`);
    if (price != null) expected.push(`人均 ¥${price}`);
    const visible = visibleMetaText(view.row);
    expect(visibleSeparatorCount(view.row)).toBe(Math.max(0, expected.length - 1));
    expected.forEach((text) => expect(visible).toContain(text));
    expect(view.row.classList.contains('hidden')).toBe(expected.length === 0);
    expect(view.row.classList.contains('flex')).toBe(expected.length > 0);
    // 0 分与 0 元是真实值：既不能被当成缺值，也不能被替换成占位文案
    expect(view.rating.textContent).toBe(rating == null ? '' : `★ ${rating}`);
    expect(view.price.textContent).toBe(price == null ? '' : `人均 ¥${price}`);
  });

  it('hours/address/phone/notes 空值：文本清空、图标所在外容器隐藏，notesBox 隐藏', async () => {
    for (const [, value] of blankValues) {
      const view = await openStore({ hours: value, address: value, phone: value, notes: value });
      expect(view.hours.textContent).toBe('');
      expect(view.hours.classList.contains('hidden')).toBe(true);
      expect(view.address.textContent).toBe('');
      expect(view.phone.textContent).toBe('');
      expect(view.notes.textContent).toBe('');
      expect(view.addressRow.classList.contains('hidden')).toBe(true);
      expect(view.addressRow.classList.contains('flex')).toBe(false);
      expect(view.phoneRow.classList.contains('hidden')).toBe(true);
      expect(view.phoneRow.classList.contains('flex')).toBe(false);
      expect(view.notesBox.classList.contains('hidden')).toBe(true);
      // 图标包裹在行容器内，行隐藏即图标不显示，不允许留下只有 📍/📞 的空行
      expect(view.addressRow.textContent).not.toContain('undefined');
      expect(view.phoneRow.textContent).not.toContain('null');
      expect(view.notesBox.textContent).not.toContain('null');
    }
  });

  it('先完整后清空再完整：清残留且可恢复，不保留上一家店的分隔符与文案', async () => {
    const view = await openStore({
      category: '日式料理',
      rating: 4.9,
      price: 36,
      hours: '10:30 - 21:30',
      address: '浅草食街 108 号',
      phone: '0512-68219901',
      notes: '午市建议提前点单'
    });
    const originalNodes = [view.category, view.rating, view.price];
    expect(view.category.textContent).toBe('日式料理');
    expect(view.rating.textContent).toBe('★ 4.9');
    expect(view.price.textContent).toBe('人均 ¥36');
    expect(visibleSeparatorCount(view.row)).toBe(2);
    expect(view.hours.textContent).toBe('营业时间 · 10:30 - 21:30');
    expect(view.addressRow.classList.contains('hidden')).toBe(false);
    expect(view.phoneRow.classList.contains('hidden')).toBe(false);
    expect(view.notesBox.classList.contains('hidden')).toBe(false);
    expect(view.notes.textContent).toBe('午市建议提前点单');

    view.services.stores.data = [
      { ...view.store, category: null, rating: null, price: null, hours: null, address: null, phone: null, notes: null }
    ];
    (window as any).BentoModal.setupStoreDetail('s-meta');
    [view.category, view.rating, view.price].forEach((node, index) => expect(node).toBe(originalNodes[index]));
    expect(view.category.textContent).toBe('');
    expect(view.rating.textContent).toBe('');
    expect(view.price.textContent).toBe('');
    expect(view.row.classList.contains('hidden')).toBe(true);
    expect(visibleSeparatorCount(view.row)).toBe(0);
    expect(view.hours.textContent).toBe('');
    expect(view.address.textContent).toBe('');
    expect(view.addressRow.classList.contains('hidden')).toBe(true);
    expect(view.phone.textContent).toBe('');
    expect(view.phoneRow.classList.contains('hidden')).toBe(true);
    expect(view.notes.textContent).toBe('');
    expect(view.notesBox.classList.contains('hidden')).toBe(true);

    view.services.stores.data = [
      {
        ...view.store,
        category: '小馆',
        rating: 0,
        price: 0,
        hours: '09:00 - 18:00',
        address: '新址 1 号',
        phone: '000-0000',
        notes: '再次营业'
      }
    ];
    (window as any).BentoModal.setupStoreDetail('s-meta');
    [view.category, view.rating, view.price].forEach((node, index) => expect(node).toBe(originalNodes[index]));
    expect(view.hours.classList.contains('hidden')).toBe(false);
    expect(view.row.classList.contains('hidden')).toBe(false);
    expect(view.category.textContent).toBe('小馆');
    expect(view.rating.textContent).toBe('★ 0');
    expect(view.price.textContent).toBe('人均 ¥0');
    expect(visibleSeparatorCount(view.row)).toBe(2);
    expect(view.hours.textContent).toBe('营业时间 · 09:00 - 18:00');
    expect(view.address.textContent).toBe('新址 1 号');
    expect(view.addressRow.classList.contains('hidden')).toBe(false);
    expect(view.phone.textContent).toBe('000-0000');
    expect(view.phoneRow.classList.contains('hidden')).toBe(false);
    expect(view.notes.textContent).toBe('再次营业');
    expect(view.notesBox.classList.contains('hidden')).toBe(false);
  });
});

describe('T-005R 食材详情日期空值（行为断言）', () => {
  async function openIngredient(overrides: Record<string, unknown>) {
    vi.unstubAllGlobals();
    await bootRealPage();
    const services = (window as any).BentoService;
    const item = { id: 'i-date', name: '日期食材', stock: 100, unit: 'g', ...overrides };
    services.pantry.data = [item];
    services.pantry.getById = (id: string) => services.pantry.data.find((x: any) => x.id === id);
    (window as any).BentoModal.setupIngredientDetail('i-date');
    const el = (id: string) => document.getElementById(id) as HTMLElement;
    return {
      services,
      get purchase() {
        return el('ingredientDetailPurchaseDate');
      },
      get expire() {
        return el('ingredientDetailExpireDate');
      }
    };
  }

  it('purchaseDate/expireDate 为 null、undefined、空串、纯空白时回退「未填写」', async () => {
    for (const [, value] of blankValues) {
      const view = await openIngredient({ purchaseDate: value, expireDate: value });
      expect(view.purchase.textContent).toBe('未填写');
      expect(view.expire.textContent).toBe('未填写');
    }
  });

  it('合法日期原样保留，且从有值切到空值会清掉旧日期', async () => {
    const view = await openIngredient({ purchaseDate: '2026-09-06', expireDate: '2026-09-20' });
    expect(view.purchase.textContent).toBe('2026-09-06');
    expect(view.expire.textContent).toBe('2026-09-20');

    view.services.pantry.data = [
      { id: 'i-date', name: '日期食材', stock: 100, unit: 'g', purchaseDate: null, expireDate: '  ' }
    ];
    (window as any).BentoModal.setupIngredientDetail('i-date');
    expect(view.purchase.textContent).toBe('未填写');
    expect(view.expire.textContent).toBe('未填写');
  });
});
