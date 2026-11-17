// @vitest-environment jsdom
// T-007 忌口弹窗回归：真实 index.html markup + inline 脚本 + 真实 google2-adapter.js。
// 断言围绕用户可见行为（分页全量、保存语义、409 保留输入、XSS 纯文本、推荐过滤与刷新），不镜像实现细节。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapterSource = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');
const markup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items,
  page: 1,
  pageSize: 100,
  total: items.length,
  totalPages: 1,
  ...extra
});
const jsonOk = (data: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  text: async () => JSON.stringify({ success: true, data })
});
const jsonFail = (status: number, code: string, message = code) => ({
  ok: false,
  status,
  headers: new Headers(),
  text: async () => JSON.stringify({ success: false, error: { code, message } })
});

type Diner = {
  id: string;
  name: string;
  active?: boolean;
  version: number;
  tabooText: string | null;
  allergyText: string | null;
  dislikesText: string | null;
};
const diner = (overrides: Partial<Diner> = {}): Diner => ({
  id: 'd1',
  name: '小夏',
  active: true,
  version: 3,
  tabooText: '香菜',
  allergyText: null,
  dislikesText: null,
  ...overrides
});

const dinersPath = (url: string) => String(url).startsWith('/api/v1/diners?');
const callsTo = (fetchMock: ReturnType<typeof vi.fn>, matcher: (url: string) => boolean) =>
  fetchMock.mock.calls.filter(([url]) => matcher(String(url)));

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

function stubCanvas() {
  const ctx = {
    clearRect: () => undefined,
    beginPath: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    rotate: () => undefined,
    fillRect: () => undefined
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
}

function stubMatchMedia() {
  const mql = {
    matches: false,
    media: '(prefers-color-scheme: dark)',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true
  };
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn(() => mql) });
  vi.stubGlobal('matchMedia', vi.fn(() => mql));
}

const settle = async () => {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
};

type BootOptions = {
  diners?: (url: string) => unknown;
  settings?: Record<string, unknown>;
  dashboard?: Record<string, unknown>;
};

function boot(options: BootOptions = {}) {
  document.body.innerHTML = markup;
  defineInnerText();
  stubCanvas();
  stubMatchMedia();
  const fetchMock = vi.fn((url: string) => {
    const target = String(url);
    if (target.endsWith('/settings/pin/session')) return Promise.resolve(jsonOk({ valid: false }));
    if (target.endsWith('/settings')) return Promise.resolve(jsonOk(options.settings ?? { version: 1, pinEnabled: false }));
    if (target.endsWith('/dashboard')) return Promise.resolve(jsonOk(options.dashboard ?? {}));
    if (dinersPath(target)) {
      if (options.diners) return Promise.resolve(options.diners(target));
      return Promise.resolve(jsonOk(page([])));
    }
    if (target.includes('/diners')) return Promise.resolve(jsonOk({}));
    return Promise.resolve(jsonOk(page([])));
  });
  vi.stubGlobal('fetch', fetchMock);
  window.eval(inline);
  window.eval(adapterSource);
  return fetchMock;
}

const openButton = () => document.getElementById('google2TabooEdit') as HTMLButtonElement;
const dialogRoot = () => document.getElementById('modalTabooSettings') as HTMLElement;
const modalOpen = () => !dialogRoot().classList.contains('hidden');
const dinerSelect = () => document.getElementById('google2TabooDiner') as HTMLSelectElement;
const field = (id: string) => document.getElementById(id) as HTMLTextAreaElement;
const errorText = () => document.getElementById('google2TabooError')?.textContent?.trim() || '';
const summaryText = () => document.getElementById('google2TabooDescription')?.textContent?.trim() || '';
const submitForm = async () => {
  document
    .getElementById('google2TabooForm')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
};
const openDialog = async () => {
  openButton().click();
  await settle();
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('T-007 忌口弹窗：读取与成员切换', () => {
  it('打开弹窗按 /diners?active=true 分页读取全量成员，并默认选中第一位', async () => {
    const fetchMock = boot({
      diners: (url) =>
        url.includes('page=1')
          ? jsonOk(page([diner({ id: 'd1', name: '小夏' })], { total: 2, totalPages: 2 }))
          : jsonOk(page([diner({ id: 'd2', name: '阿岚', tabooText: null, version: 1 })], { page: 2, total: 2, totalPages: 2 }))
    });
    await settle();
    await openDialog();

    const dinerCalls = callsTo(fetchMock, dinersPath).map(([url]) => String(url));
    expect(dinerCalls[0]).toBe('/api/v1/diners?active=true&page=1&pageSize=100');
    expect(dinerCalls).toContain('/api/v1/diners?active=true&page=2&pageSize=100');
    expect(dinerCalls.every((url) => url.includes('active=true'))).toBe(true);
    expect(Array.from(dinerSelect().options).map((option) => option.value)).toEqual(['d1', 'd2']);
    expect(dinerSelect().value).toBe('d1');
    expect(field('google2TabooText').value).toBe('香菜');
    expect(modalOpen()).toBe(true);
    // 读取成功后不再残留「正在读取」错误
    expect(errorText()).not.toContain('正在读取');
  });

  it('分页结果的非活跃成员被过滤，不出现在可编辑下拉里', async () => {
    boot({
      diners: () =>
        jsonOk(page([diner({ id: 'd1' }), diner({ id: 'd9', name: '已停用', active: false })], { total: 2, totalPages: 1 }))
    });
    await settle();
    await openDialog();
    expect(Array.from(dinerSelect().options).map((option) => option.value)).toEqual(['d1']);
  });

  it('切换成员回填该成员字段，多成员 PUT 只带自身真实 version 且不覆盖其它成员', async () => {
    const fetchMock = boot({
      diners: () =>
        jsonOk(
          page([
            diner({ id: 'd1', name: '小夏', version: 3, tabooText: '香菜' }),
            diner({ id: 'd2', name: '阿岚', version: 7, tabooText: '虾', allergyText: '花生', dislikesText: '蒜' })
          ])
        )
    });
    await settle();
    await openDialog();

    dinerSelect().value = 'd2';
    dinerSelect().dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(field('google2TabooText').value).toBe('虾');
    expect(field('google2AllergyText').value).toBe('花生');
    expect(field('google2DislikesText').value).toBe('蒜');

    field('google2DislikesText').value = '蒜、洋葱';
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url) === '/api/v1/diners/d2' && init?.method === 'PUT') {
        return Promise.resolve(jsonOk({ ...diner({ id: 'd2', name: '阿岚', version: 8, tabooText: '虾', allergyText: '花生', dislikesText: '蒜、洋葱' }) }));
      }
      if (dinersPath(String(url))) {
        return Promise.resolve(
          jsonOk(
            page([
              diner({ id: 'd1', name: '小夏', version: 3, tabooText: '香菜' }),
              diner({ id: 'd2', name: '阿岚', version: 8, tabooText: '虾', allergyText: '花生', dislikesText: '蒜、洋葱' })
            ])
          )
        );
      }
      if (String(url).endsWith('/dashboard')) return Promise.resolve(jsonOk({}));
      return Promise.resolve(jsonOk(page([])));
    });
    await submitForm();

    const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('/api/v1/diners/d2');
    const body = JSON.parse(String(puts[0][1].body));
    expect(body).toMatchObject({ version: 7, tabooText: '虾', allergyText: '花生', dislikesText: '蒜、洋葱' });
    // 不携带其它成员身份/数据
    expect(JSON.stringify(body)).not.toContain('d1');
    expect(JSON.stringify(body)).not.toContain('香菜');
    const d1Puts = puts.filter(([url]) => String(url).includes('d1'));
    expect(d1Puts).toHaveLength(0);
  });

  it('取消后重新打开：未保存的输入被丢弃，字段回到服务端值', async () => {
    let dinersPayload = [diner({ id: 'd1', version: 3, tabooText: '香菜', dislikesText: null })];
    const fetchMock = boot({ diners: () => jsonOk(page(dinersPayload)) });
    await settle();
    await openDialog();

    field('google2TabooText').value = '临时修改';
    field('google2DislikesText').value = '洋葱';
    (document.getElementById('google2TabooCancel') as HTMLButtonElement).click();
    await settle();
    expect(modalOpen()).toBe(false);
    const dinerWrites = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes('/diners') && (init?.method === 'PUT' || init?.method === 'POST')
    );
    expect(dinerWrites).toHaveLength(0);

    dinersPayload = [diner({ id: 'd1', version: 4, tabooText: '香菜、芹菜', dislikesText: null })];
    await openDialog();
    // 重开必然重新读取服务端最新值，而非沿用关闭前的缓存
    expect(field('google2TabooText').value).toBe('香菜、芹菜');
    expect(field('google2DislikesText').value).toBe('');
    expect(errorText()).toBe('');
  });
});

describe('T-007 忌口弹窗：保存语义', () => {
  it('无活跃成员时空保存不创建任何成员，也不发写请求', async () => {
    const fetchMock = boot({ diners: () => jsonOk(page([])) });
    await settle();
    await openDialog();
    await submitForm();

    const dinerWrites = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes('/diners') && (init?.method === 'PUT' || init?.method === 'POST')
    );
    expect(dinerWrites).toHaveLength(0);
    expect(modalOpen()).toBe(false);
  });

  it('无活跃成员但填写了偏好时，POST 使用服务端昵称作为成员名', async () => {
    const fetchMock = boot({
      diners: () => jsonOk(page([])),
      settings: { version: 2, pinEnabled: false, userNickname: '大明' }
    });
    await settle();
    await openDialog();
    field('google2TabooText').value = '香菜';
    await submitForm();

    const posts = fetchMock.mock.calls.filter(([url, init]) => String(url) === '/api/v1/diners' && init?.method === 'POST');
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0][1].body));
    expect(body).toEqual({ name: '大明', tabooText: '香菜', allergyText: null, dislikesText: null });
  });

  it('清空三字段保存发送 null，界面摘要回到未设置', async () => {
    const fetchMock = boot({
      diners: () => jsonOk(page([diner({ id: 'd1', version: 5, tabooText: '香菜', allergyText: '花生', dislikesText: '蒜' })]))
    });
    await settle();
    await openDialog();
    expect(summaryText()).toContain('香菜');

    field('google2TabooText').value = '';
    field('google2AllergyText').value = '';
    field('google2DislikesText').value = '';
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url) === '/api/v1/diners/d1' && init?.method === 'PUT')
        return Promise.resolve(jsonOk(diner({ id: 'd1', version: 6, tabooText: null, allergyText: null, dislikesText: null })));
      if (dinersPath(String(url)))
        return Promise.resolve(jsonOk(page([diner({ id: 'd1', version: 6, tabooText: null, allergyText: null, dislikesText: null })])));
      if (String(url).endsWith('/dashboard')) return Promise.resolve(jsonOk({}));
      return Promise.resolve(jsonOk(page([])));
    });
    await submitForm();

    const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String(puts[0][1].body))).toEqual({
      tabooText: null,
      allergyText: null,
      dislikesText: null,
      version: 5
    });
    expect(summaryText()).toBe('未设置忌口或过敏原');
  });

  it('409 时保留用户输入并提示冲突，不发第二次写请求', async () => {
    const fetchMock = boot({
      diners: () => jsonOk(page([diner({ id: 'd1', version: 3, tabooText: '香菜' })]))
    });
    await settle();
    await openDialog();
    field('google2TabooText').value = '香菜、芹菜';
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url) === '/api/v1/diners/d1' && init?.method === 'PUT')
        return Promise.resolve(jsonFail(409, 'VERSION_CONFLICT'));
      if (dinersPath(String(url))) return Promise.resolve(jsonOk(page([diner({ id: 'd1', version: 4, tabooText: '香菜' })])));
      return Promise.resolve(jsonOk({}));
    });
    await submitForm();

    expect(field('google2TabooText').value).toBe('香菜、芹菜');
    expect(modalOpen()).toBe(true);
    expect(errorText()).toMatch(/其他页面|冲突|修改/);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });
});

describe('T-007 忌口弹窗：纯文本与 XSS', () => {
  it('成员名与忌口词条按纯文本渲染，不产生 img/脚本节点', async () => {
    const evil = '<img src=x onerror=alert(1)>香菜';
    boot({
      diners: () =>
        jsonOk(
          page([
            diner({ id: 'd1', name: '<img src=x onerror=alert(2)>坏名', tabooText: evil, allergyText: '<script>alert(3)</script>' })
          ])
        )
    });
    await settle();
    await openDialog();

    const summary = document.getElementById('google2TabooDescription') as HTMLElement;
    expect(summary.querySelectorAll('img, script').length).toBe(0);
    expect(summary.textContent).toContain('<img src=x onerror=alert(1)>香菜');
    expect(summary.innerHTML).not.toContain('<img');
    const select = dinerSelect();
    expect(select.querySelectorAll('img, script').length).toBe(0);
    expect(select.options[0].textContent).toContain('坏名');
    expect(field('google2TabooText').value).toBe(evil);
    expect(dialogRoot().querySelectorAll('img, script').length).toBe(0);
  });
});

describe('T-007 忌口过滤：tokens 与推荐来源', () => {
  const seedCandidates = () => {
    const service = (window as any).BentoService;
    const mapRecipe = (window as any).DafanDomainAdapter.mapRecipe;
    service.recipes.data = [
      mapRecipe({ id: 'r-ok', name: '番茄炒蛋', ingredientsText: '番茄 鸡蛋', notes: '', ingredients: [], steps: [] }),
      mapRecipe({
        id: 'r-taboo',
        name: '香菜拌菜',
        ingredientsText: '',
        notes: '',
        ingredients: [{ ingredientNameSnapshot: '香菜' }],
        steps: []
      }),
      mapRecipe({
        id: 'r-allergy',
        name: '花生糖水',
        ingredientsText: '花生、冰糖',
        notes: '',
        ingredients: [{ ingredientNameSnapshot: '花生' }],
        steps: []
      })
    ];
    service.stores.data = [
      { id: 's-ok', name: '清汤面馆', cuisine: '面食', recommendedDishes: '牛肉面', notes: '' },
      { id: 's-dish', name: '街角小馆', cuisine: '家常', recommendedDishes: '蒜香排骨', notes: '' },
      { id: 's-cuisine', name: '香菜主题店', cuisine: '香菜料理', recommendedDishes: '', notes: '' },
      { id: 's-notes', name: '无名小馆', cuisine: '家常', recommendedDishes: '', notes: '招牌香菜锅' }
    ];
  };

  it('tokens 分词/大小写与后端 diner-rules 口径一致（顿号逗号分号空格、忽略大小写）', () => {
    boot({ diners: () => jsonOk(page([])) });
    const tokens = (window as any).DafanDinerAdapter.tokens;
    expect(tokens('香菜、虾，花生;蒜；Milk  milk\t鸡蛋')).toEqual([
      '香菜',
      '虾',
      '花生',
      '蒜',
      'milk',
      'milk',
      '鸡蛋'
    ]);
    expect(tokens(null)).toEqual([]);
    expect(tokens('   ')).toEqual([]);
  });

  it('菜谱按名称/配料快照文本过滤，店铺按名称/招牌菜/菜系/备注过滤后再进转盘与厨房推荐', async () => {
    const fetchMock = boot({
      diners: () =>
        jsonOk(
          page([
            diner({ id: 'd1', tabooText: '香菜', allergyText: '花生', dislikesText: '蒜' })
          ])
        )
    });
    await settle();
    seedCandidates();
    (window as any).setWheelCandidateMode('all');
    (window as any).updateWheelCandidates();
    await settle();

    const wheelIds = ((window as any).getDynamicWheelItems() as Array<{ id: string }>).map((item) => item.id);
    expect(wheelIds).toEqual(expect.arrayContaining(['r-ok', 's-ok']));
    for (const banned of ['r-taboo', 'r-allergy', 's-dish', 's-cuisine', 's-notes']) {
      expect(wheelIds).not.toContain(banned);
    }

    // 全部 dinerIds 参与推荐请求
    (window as any).getDynamicWheelItems = () => [
      { id: 'r-ok', title: '番茄炒蛋', type: 'recipe' },
      { id: 's-ok', title: '清汤面馆', type: 'store' }
    ];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/recommendations/random') && init?.method === 'POST')
        return Promise.resolve(
          jsonOk({
            results: [
              { resultType: 'RECIPE', resultId: 'r-taboo', title: '香菜拌菜' },
              { resultType: 'RECIPE', resultId: 'r-ok', title: '番茄炒蛋' }
            ]
          })
        );
      if (dinersPath(String(url)))
        return Promise.resolve(jsonOk(page([diner({ id: 'd1', tabooText: '香菜', allergyText: '花生', dislikesText: '蒜' })])));
      return Promise.resolve(jsonOk(page([])));
    });
    const index = await (window as any).DafanWheelAdapter.resolveTargetIndex('all');
    expect(index).toBe(0);
    const randomCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/recommendations/random'));
    expect(randomCalls).toHaveLength(1);
    expect(JSON.parse(String(randomCalls[0][1].body))).toMatchObject({ dinerIds: ['d1'] });

    // 厨房配菜后端推荐同样携带全部 dinerIds，并按忌口过滤返回项
    (window as any).BentoService.pantry.data = [
      { id: 'i1', name: '番茄', stock: 10, quantity: 10, unit: 'PIECE', unitKey: 'PIECE', expireDaysLeft: 5 }
    ];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/kitchen/recommend') && init?.method === 'POST')
        return Promise.resolve(
          jsonOk({
            items: [
              {
                recipe: { id: 'r-taboo', name: '香菜拌菜', cookingTimeMinutes: 5 },
                completion: 100,
                existingIngredients: [],
                missingIngredients: []
              },
              {
                recipe: { id: 'r-ok', name: '番茄炒蛋', cookingTimeMinutes: 8 },
                completion: 100,
                existingIngredients: [],
                missingIngredients: []
              }
            ]
          })
        );
      return Promise.resolve(jsonOk(page([])));
    });
    (window as any).BentoModal.setupPantryRecommend();
    await settle();

    const kitchenCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/kitchen/recommend'));
    expect(kitchenCalls).toHaveLength(1);
    expect(JSON.parse(String(kitchenCalls[0][1].body))).toEqual({
      mode: 'ALLOW_PURCHASE',
      limit: expect.any(Number),
      dinerIds: ['d1']
    });
    const text = document.getElementById('pantryRecommendContent')?.textContent || '';
    expect(text).toContain('番茄炒蛋');
    expect(text).not.toContain('香菜拌菜');
  });
});

describe('T-007 忌口保存后的即时刷新', () => {
  it('保存成功后立即刷新 summary、dashboard 与转盘候选（无需再次打开弹窗）', async () => {
    const dashboardCalls: string[] = [];
    const fetchMock = boot({
      diners: () => jsonOk(page([diner({ id: 'd1', version: 3, tabooText: null })]))
    });
    await settle();
    await openDialog();
    field('google2TabooText').value = '香菜';

    const updateCandidates = vi.fn();
    (window as any).updateWheelCandidates = updateCandidates;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const target = String(url);
      if (target === '/api/v1/diners/d1' && init?.method === 'PUT')
        return Promise.resolve(jsonOk(diner({ id: 'd1', version: 4, tabooText: '香菜' })));
      if (dinersPath(target)) return Promise.resolve(jsonOk(page([diner({ id: 'd1', version: 4, tabooText: '香菜' })])));
      if (target.endsWith('/dashboard')) {
        dashboardCalls.push(target);
        return Promise.resolve(jsonOk({}));
      }
      return Promise.resolve(jsonOk(page([])));
    });
    await submitForm();

    expect(summaryText()).toContain('香菜');
    expect(dashboardCalls.length).toBeGreaterThanOrEqual(1);
    expect(updateCandidates).toHaveBeenCalled();
    expect(modalOpen()).toBe(false);
  });
});
