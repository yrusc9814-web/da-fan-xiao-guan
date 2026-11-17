// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapter = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');
const markup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

const json = (data: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ success: true, data })
});
const page = (items: unknown[] = []) => ({ items, page: 1, pageSize: 100, total: items.length, totalPages: 1 });
const shoppingList = (version: number, items: unknown[] = []) => ({
  id: 'sl1',
  name: '购物补货清单',
  status: 'ACTIVE',
  version,
  items
});

async function settle() {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

function boot(
  fetchImpl: (url: string, init?: RequestInit) => unknown = (url) =>
    String(url).startsWith('/api/v1/shopping-lists?status=ACTIVE') ? shoppingList(1) : page(),
  calendar?: [number, number]
) {
  document.body.innerHTML = markup;
  Object.defineProperty(Element.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent || '';
    },
    set(value) {
      this.textContent = value;
    }
  });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => json(await fetchImpl(url, init)));
  vi.stubGlobal('fetch', fetchMock);
  (window as any).fetch = fetchMock;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  window.eval(scripts);
  if (calendar) window.eval(`currentCalendarYear = ${calendar[0]}; currentCalendarMonth = ${calendar[1]};`);
  window.eval(adapter);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 1, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('VAN-38 final closeout: inventory expiry mapping', () => {
  it.each([
    [null, '未填写保质期', []],
    [undefined, '未填写保质期', []],
    ['', '未填写保质期', []],
    ['not-a-date', '未填写保质期', []],
    ['2026-09-05', '余 4 天', ['建议尽快']],
    ['2026-09-09', '余 8 天', ['新鲜']],
    // C1：今日到期单独文案；已过期绝不出现负天数或「临期预警」
    ['2026-09-01', '今日到期', ['今日到期']],
    ['2026-08-31', '已过期 1 天', ['已过期']]
  ])('真实 pantry 映射后由 renderInventory 输出 %s', async (expiryDate, expectedDays, badges) => {
    boot();
    await settle();
    const mapped = (window as any).DafanDomainAdapter.mapPantryItem({
      id: 'i1',
      name: '牛奶',
      category: '蔬菜',
      quantity: 2,
      unit: 'PIECE',
      expiryDate
    });
    (window as any).BentoService.pantry.data = [mapped];
    (window as any).renderInventory();
    const card = document.querySelector('#inventoryCardGrid > div') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain(expectedDays);
    for (const badge of ['新鲜', '临期预警', '建议尽快', '今日到期', '已过期']) {
      if (badges.includes(badge)) expect(card.textContent).toContain(badge);
      else expect(card.textContent).not.toContain(badge);
    }
  });
});

describe('VAN-38 final closeout: calendar real HTML and adapter', () => {
  it('uses Sunday-first offsets and navigates through the real rendered grid', async () => {
    const apiGet = vi.fn(async () => page([]));
    boot((url) => (String(url).includes('/calendar') ? page([]) : page([])), [2026, 9]);
    (window as any).DafanApiClient.get = apiGet;
    await (window as any).renderCalendar();
    const grid = () => document.getElementById('calendarDaysGrid') as HTMLElement;
    expect(
      Array.from(document.querySelectorAll('#page-calendar .calendar-weekdays span')).map((n) => n.textContent)
    ).toEqual(['日', '一', '二', '三', '四', '五', '六']);
    expect(grid().children[2]?.textContent).toContain('1');
    (window as any).changeCalendarMonth(-7);
    await vi.waitFor(() =>
      expect(document.getElementById('calendarCurrentMonthLabel')?.textContent).toContain('2026年 2月')
    );
    const febFirst = Array.from(grid().querySelectorAll(':scope > [onclick]')).find((node) =>
      node.textContent?.trim().startsWith('1')
    );
    expect(febFirst).toBeTruthy();
    (window as any).changeCalendarMonth(4);
    await vi.waitFor(() =>
      expect(document.getElementById('calendarCurrentMonthLabel')?.textContent).toContain('2026年 6月')
    );
    expect(
      Array.from(grid().querySelectorAll(':scope > [onclick]')).find((node) => node.textContent?.trim().startsWith('1'))
    ).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/records?from=2026-06-01&to=2026-06-30'));
  });

  it('captures the requested leap month before adapter boot and sends click payload from onclick day', async () => {
    const open = vi.fn();
    boot(() => page([]), [2028, 2]);
    (globalThis as any).BentoModal = { open };
    (window as any).BentoModal = (globalThis as any).BentoModal;
    await (window as any).renderCalendar();
    const days = Array.from(document.querySelectorAll('#calendarDaysGrid > [onclick]')) as HTMLElement[];
    const leap = days.find((node) => node.textContent?.trim().startsWith('29')) as HTMLElement;
    expect(leap).toBeTruthy();
    const onclick = leap.getAttribute('onclick')!;
    leap.onclick = () => new Function('BentoModal', onclick)(window.BentoModal);
    leap.click();
    expect(open).toHaveBeenCalledWith('dailyDiary', { year: 2028, month: 2, day: 29 });
    expect(document.querySelector('#calendarDaysGrid [data-date]')).toBeNull();
  });
});

describe('VAN-38 final closeout: recipe missing-ingredient wire contract', () => {
  function setupServices() {
    boot((url) => (String(url).startsWith('/api/v1/shopping-lists?status=ACTIVE') ? shoppingList(2) : page([])));
    (window as any).BentoService = {
      stores: { data: [] },
      recipes: { data: [] },
      pantry: { data: [] },
      shopping: { data: [] }
    };
    window.eval(adapter);
    return settle().then(() => {
      (window.fetch as any).mockReset();
      // 详情弹窗不属本组契约，stub 掉避免详情渲染异常掩盖补货成功回报
      (window as any).BentoModal = { open: vi.fn(), close: vi.fn() };
      (window as any).DafanDomainAdapter.replaceRecipeService((window as any).BentoService.recipes);
      (window as any).DafanDomainAdapter.replacePantryService((window as any).BentoService.pantry);
      (window as any).DafanDomainAdapter.replaceShoppingService((window as any).BentoService.shopping);
      vi.mocked(window.fetch).mockClear();
    });
  }

  const replenishPost = (fetchMock: any) =>
    fetchMock.mock.calls.find(([url, init]) => init?.method === 'POST' && String(url).endsWith('/replenish-recipe'));
  const replenishBody = (fetchMock: any) => JSON.parse(String(replenishPost(fetchMock)?.[1]?.body));

  it('replenishes a recipe in one batch request with pure ingredientName and structured demand', async () => {
    await setupServices();
    // setupServices 内的真实 HTML 脚本会重挂 window.showToast，必须在 boot 之后再接管
    const toast = vi.fn();
    (window as any).showToast = toast;
    const fetchMock = window.fetch as any;
    fetchMock.mockResolvedValue(json(shoppingList(3, [{ id: 'it1' }])));
    const services = (window as any).BentoService;
    services.recipes.data = [
      (window as any).DafanDomainAdapter.mapRecipe({
        id: 'r1',
        name: '番茄炒蛋',
        version: 1,
        ingredients: [{ name: '鸡蛋', quantity: 2, unit: 'PIECE', amountText: '2 个' }],
        steps: []
      })
    ];
    await services.recipes.addMissingIngredientsToShopping('r1');
    const post = replenishPost(fetchMock);
    expect(post).toBeTruthy();
    expect(String(post?.[0])).toBe('/api/v1/shopping-lists/sl1/replenish-recipe');
    expect(replenishBody(fetchMock)).toEqual({
      version: expect.any(Number),
      recipeId: 'r1',
      items: [{ ingredientId: null, ingredientName: '鸡蛋', quantity: 2, unit: 'PIECE', amountText: '2 个' }]
    });
    // 名称绝不再拼 (2 个)，也不再逐项 POST /items
    expect(replenishBody(fetchMock).items[0].ingredientName).toBe('鸡蛋');
    expect(
      fetchMock.mock.calls.filter(([url, init]) => init?.method === 'POST' && String(url).endsWith('/items'))
    ).toHaveLength(0);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('已成功'), 'success');
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('失败'), 'error');
  });

  it('replenishes free-text spec 适量 as amountText instead of failing SHOPPING_AMOUNT_UNSUPPORTED', async () => {
    await setupServices();
    // setupServices 内的真实 HTML 脚本会重挂 window.showToast，必须在 boot 之后再接管
    const toast = vi.fn();
    (window as any).showToast = toast;
    const fetchMock = window.fetch as any;
    fetchMock.mockResolvedValue(json(shoppingList(3, [{ id: 'it1' }])));
    const services = (window as any).BentoService;
    const original = { name: '盐', quantity: 1, unit: 'OTHER', amountText: '适量' };
    services.recipes.data = [
      (window as any).DafanDomainAdapter.mapRecipe({
        id: 'r2',
        name: '家常菜',
        version: 1,
        ingredients: [original],
        steps: []
      })
    ];
    await services.recipes.addMissingIngredientsToShopping('r2');
    expect(replenishBody(fetchMock)).toEqual({
      version: expect.any(Number),
      recipeId: 'r2',
      items: [{ ingredientId: null, ingredientName: '盐', quantity: null, unit: null, amountText: '适量' }]
    });
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('已成功'), 'success');
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('失败'), 'error');
  });

  it('skips items fully covered by convertible pantry stock and keeps convertible deficits exact', async () => {
    await setupServices();
    // setupServices 内的真实 HTML 脚本会重挂 window.showToast，必须在 boot 之后再接管
    const toast = vi.fn();
    (window as any).showToast = toast;
    const fetchMock = window.fetch as any;
    fetchMock.mockResolvedValue(json(shoppingList(3, [{ id: 'it1' }])));
    const services = (window as any).BentoService;
    services.pantry.data = [
      { id: 'p-onion', name: '洋葱', stock: 500, unitKey: 'GRAM' },
      { id: 'p-potato', name: '土豆', stock: 50, unitKey: 'GRAM' }
    ];
    services.recipes.data = [
      (window as any).DafanDomainAdapter.mapRecipe({
        id: 'r3',
        name: 'test',
        version: 1,
        ingredients: [
          { name: '葱', quantity: 2, unit: 'PIECE', amountText: '2个' },
          { name: '土豆', quantity: 0.2, unit: 'KILOGRAM', amountText: '200g' }
        ],
        steps: []
      })
    ];
    await services.recipes.addMissingIngredientsToShopping('r3');
    const body = replenishBody(fetchMock);
    // 洋葱库存不得命中葱（禁止 includes 子串模糊匹配）
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      ingredientId: null,
      ingredientName: '葱',
      quantity: 2,
      unit: 'PIECE'
    });
    // 土豆库存 50g 对需求 0.2kg 精确补差额（0.15kg === 150g，单位可换算即等价）
    const potato = body.items[1];
    expect(potato).toMatchObject({ ingredientId: 'p-potato', ingredientName: '土豆' });
    const inGrams = potato.unit === 'KILOGRAM' ? potato.quantity * 1000 : potato.quantity;
    expect(potato.unit === 'GRAM' || potato.unit === 'KILOGRAM').toBe(true);
    expect(inGrams).toBe(150);
    // 标准展示与原文一致的规格不再重复写 amountText
    expect(potato.amountText).toBeNull();
  });

  it('skips a recipe entirely when convertible pantry stock covers the demand', async () => {
    await setupServices();
    // setupServices 内的真实 HTML 脚本会重挂 window.showToast，必须在 boot 之后再接管
    const toast = vi.fn();
    (window as any).showToast = toast;
    const fetchMock = window.fetch as any;
    const services = (window as any).BentoService;
    services.pantry.data = [{ id: 'p-potato', name: '土豆', stock: 0.5, unitKey: 'KILOGRAM' }];
    services.recipes.data = [
      (window as any).DafanDomainAdapter.mapRecipe({
        id: 'r4',
        name: '土豆丝',
        version: 1,
        ingredients: [{ name: '土豆', ingredientId: 'p-potato', quantity: 200, unit: 'GRAM', amountText: '200g' }],
        steps: []
      })
    ];
    await services.recipes.addMissingIngredientsToShopping('r4');
    expect(replenishPost(fetchMock)).toBeUndefined();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('无需补货'), 'success');
  });
});

describe('VAN-140 final closeout: shopping list safe DOM rendering', () => {
  const payloads = {
    img: '<img src=x onerror="window.__xss=1">',
    svg: '"><svg onload="window.__xss=2">',
    onclick: "' onclick='window.__xss=3"
  };
  // renderShoppingList 闭包引用模块内 BentoService 常量，必须原地替换数据与方法而非换 window 全局
  const setShopping = (items: unknown[], service: Record<string, unknown> = {}) => {
    const shopping = (window as any).BentoService.shopping;
    shopping.data = items;
    shopping.getAll = () => shopping.data;
    Object.assign(shopping, service);
  };
  const render = (items: unknown[], service: Record<string, unknown> = {}) => {
    setShopping(items, service);
    (window as any).renderShoppingList();
    return document.getElementById('shoppingListContainer') as HTMLElement;
  };
  const expectNoInjection = (root: HTMLElement) => {
    expect((window as any).__xss).toBeUndefined();
    expect(root.querySelectorAll('img, svg, script, iframe, object, embed')).toHaveLength(0);
    root.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
      }
    });
  };

  beforeEach(() => {
    delete (window as any).__xss;
  });

  it('renders malicious name/source/amount/category as inert text', async () => {
    boot();
    await settle();
    const container = render([
      {
        id: 'it-1',
        name: payloads.img,
        source: payloads.svg,
        amount: payloads.onclick,
        category: payloads.img,
        isChecked: false
      }
    ]);
    expectNoInjection(container);
    const text = container.textContent || '';
    expect(text).toContain(payloads.img);
    expect(text).toContain(payloads.svg);
    expect(text).toContain(payloads.onclick);
    // 悬空「需补」不出现，中文文案完整
    expect(text).toContain('需补');
    expect(container.querySelectorAll('.rounded-full')).toHaveLength(1);
  });

  it('omits the amount suffix and category pill when they are empty', async () => {
    boot();
    await settle();
    const container = render([{ id: 'it-2', name: '盐', source: '', amount: '', category: '' }]);
    const text = container.textContent || '';
    expect(text).toContain('盐');
    expect(text).toContain('备忘');
    expect(text).not.toContain('需补');
    expect(container.querySelectorAll('.rounded-full')).toHaveLength(0);
  });

  it('binds toggle and delete callbacks exactly for adversarial ids without inline attributes', async () => {
    boot();
    await settle();
    const toggle = vi.fn();
    const deleted: string[] = [];
    (window as any).confirm = () => true;
    const maliciousId = `it"'><img src=x>`;
    const secondId = `id-2'onclick='window.__xss=9`;
    const container = render(
      [
        { id: maliciousId, name: '异常 id', source: '手动备忘', amount: '1份', category: '蔬菜' },
        { id: secondId, name: '第二个', source: '手动备忘', amount: '', category: '' }
      ],
      { toggle, delete: async (id: string) => deleted.push(id) }
    );
    expectNoInjection(container);

    const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event('change'));
    expect(toggle).toHaveBeenCalledWith(maliciousId);
    expect(toggle).toHaveBeenCalledTimes(1);

    // 每行两个动作按钮（✏️ 编辑 + ✕ 删除），共 4 个
    const deleteButtons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[];
    expect(deleteButtons).toHaveLength(4);
    const rowDeleteButtons = deleteButtons.filter((button) => button.textContent === '✕');
    expect(rowDeleteButtons).toHaveLength(2);
    rowDeleteButtons[1].click();
    await settle();
    expect(deleted).toEqual([secondId]);
    expect((window as any).__xss).toBeUndefined();
  });

  it('keeps write failures from escaping as unhandled rejections', async () => {
    boot();
    await settle();
    const toast = vi.fn();
    (window as any).showToast = toast;
    const container = render([{ id: 'it-3', name: '盐', source: '备忘', amount: '', category: '' }], {
      toggle: () => Promise.reject(new Error('保存失败'))
    });
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await settle();
    expect(toast).toHaveBeenCalledWith('保存失败', 'error');
  });

  it('binds the page-level 清理已购 button to clearCompleted only (no pantry writes)', async () => {
    boot();
    await settle();
    const clearCompleted = vi.fn(async () => true);
    const pantrySave = vi.fn();
    (window as any).BentoService.pantry.save = pantrySave;
    (window as any).BentoService.shopping.clearCompleted = clearCompleted;
    const button = Array.from(document.querySelectorAll('#page-shopping button')).find((node) =>
      node.textContent?.includes('清理已购')
    ) as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.getAttribute('onclick')).toBe('clearCompletedShoppingItems()');
    // 直接调用全局入口：jsdom 内联 handler 与 window.eval 脚本的全局作用域不一致，不据此判失败
    expect(typeof (window as any).clearCompletedShoppingItems).toBe('function');
    await (window as any).clearCompletedShoppingItems();
    expect(clearCompleted).toHaveBeenCalledTimes(1);
    expect(pantrySave).not.toHaveBeenCalled();
  });
});

describe('VAN-201 final closeout: shopping check-in prompt bridge', () => {
  const maliciousName = '<img src=x onerror="window.__xss=1">';
  const maliciousAmount = '"><svg onload="window.__xss=2">';
  const maliciousId = `it-1' onclick='window.__xss=3`;

  const prompt = () => document.getElementById('modalShoppingCheckinPrompt') as HTMLElement;
  const rows = () =>
    Array.from(
      document.querySelectorAll('#shoppingCheckinPromptList input, #shoppingCheckinPromptList select')
    ) as HTMLElement[];
  const submitBtn = () => document.getElementById('shoppingCheckinPromptSubmitBtn') as HTMLButtonElement;
  const structuredBtn = () => document.getElementById('shoppingCheckinPromptStructuredBtn') as HTMLButtonElement;
  const cancelBtn = () => document.getElementById('shoppingCheckinPromptCancelBtn') as HTMLButtonElement;
  const errorText = () => document.getElementById('shoppingCheckinPromptError') as HTMLElement;
  const isOpen = () => !prompt().classList.contains('hidden');

  beforeEach(async () => {
    delete (window as any).__xss;
    boot();
    await settle();
    closePromptIfOpen();
  });

  function closePromptIfOpen() {
    if ((window as any).closeShoppingCheckinPrompt) (window as any).closeShoppingCheckinPrompt();
  }

  it('only builds and shows the modal on open, with no network request', async () => {
    const onSubmit = vi.fn(async () => true);
    const onStructuredOnly = vi.fn(async () => true);
    const fetchMock = window.fetch as any;
    fetchMock.mockClear();
    (window as any).openShoppingCheckinPrompt({
      items: [{ id: 'it-1', name: '盐', amount: '适量' }],
      hasStructuredItems: false,
      onSubmit,
      onStructuredOnly
    });
    expect(isOpen()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onStructuredOnly).not.toHaveBeenCalled();
    // 缺量行展示原规格提示
    expect(prompt().textContent).toContain('原规格：适量');
    expect(rows()).toHaveLength(2);
    const quantity = rows()[0] as HTMLInputElement;
    expect(quantity.type).toBe('number');
    expect(quantity.step).toBe('any');
    expect(Number(quantity.min)).toBe(0);
  });

  it('renders malicious item fields as inert text and never runs injected handlers', async () => {
    (window as any).openShoppingCheckinPrompt({
      items: [{ id: maliciousId, name: maliciousName, amount: maliciousAmount }],
      hasStructuredItems: false,
      onSubmit: async () => true,
      onStructuredOnly: async () => true
    });
    expect((window as any).__xss).toBeUndefined();
    const modal = prompt();
    expect(modal.querySelectorAll('img, svg, script, iframe, object, embed')).toHaveLength(0);
    modal.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
    });
    const text = modal.textContent || '';
    expect(text).toContain(maliciousName);
    expect(text).toContain(maliciousAmount);
    expect(text).toContain('原规格：');
  });

  it('disables structured-only action when every checked item needs filling', async () => {
    (window as any).openShoppingCheckinPrompt({
      items: [{ id: 'it-1', name: '盐', amount: '适量' }],
      hasStructuredItems: false,
      onSubmit: async () => true,
      onStructuredOnly: vi.fn(async () => true)
    });
    expect(structuredBtn().disabled).toBe(true);
    expect(structuredBtn().className).toContain('opacity-50');
    structuredBtn().click();
    await settle();
    expect(isOpen()).toBe(true);
  });

  it('rejects invalid input without calling the callback and shows a hint', async () => {
    const onSubmit = vi.fn(async () => true);
    (window as any).openShoppingCheckinPrompt({
      items: [
        { id: 'it-1', name: '盐', amount: '适量' },
        { id: 'it-2', name: '姜', amount: '2块' }
      ],
      hasStructuredItems: false,
      onSubmit,
      onStructuredOnly: async () => true
    });
    const [q1, u1, q2, u2] = rows() as [HTMLInputElement, HTMLSelectElement, HTMLInputElement, HTMLSelectElement];

    // 0 / 负数 / 未选单位 都必须拦下
    submitBtn().click();
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(errorText().classList.contains('hidden')).toBe(false);

    q1.value = '2';
    u1.value = 'GRAM';
    q2.value = '-2';
    u2.value = 'PIECE';
    submitBtn().click();
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();

    q2.value = '2';
    q2.dispatchEvent(new Event('input'));
    expect(errorText().classList.contains('hidden')).toBe(true);
    submitBtn().click();
    await settle();
    expect(errorText().textContent).toBe('');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('submits validated updates with closured ids and standard units, closing only on true', async () => {
    const submitted: unknown[] = [];
    const onSubmit = vi.fn(async (updates: unknown[]) => {
      submitted.push(updates);
      return false;
    });
    (window as any).openShoppingCheckinPrompt({
      items: [
        { id: maliciousId, name: '盐', amount: '适量' },
        { id: 'it/2', name: '姜', amount: '2块' }
      ],
      hasStructuredItems: true,
      onSubmit,
      onStructuredOnly: async () => true
    });
    const [q1, u1, q2, u2] = rows() as [HTMLInputElement, HTMLSelectElement, HTMLInputElement, HTMLSelectElement];
    q1.value = '250.5';
    u1.value = 'GRAM';
    q2.value = '3';
    u2.value = 'PORTION';
    submitBtn().click();
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submitted[0]).toEqual([
      { id: maliciousId, quantity: 250.5, unit: 'GRAM' },
      { id: 'it/2', quantity: 3, unit: 'PORTION' }
    ]);
    // 回调返回 false 时保持打开并提示可重试
    expect(isOpen()).toBe(true);
    expect(errorText().classList.contains('hidden')).toBe(false);
    expect(submitBtn().disabled).toBe(false);
  });

  it('keeps the modal open with a hint when the async callback throws, then allows a retry', async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('补填失败')).mockResolvedValueOnce(true);
    (window as any).openShoppingCheckinPrompt({
      items: [{ id: 'it-1', name: '盐', amount: '适量' }],
      hasStructuredItems: false,
      onSubmit,
      onStructuredOnly: async () => true
    });
    const [q1, u1] = rows() as [HTMLInputElement, HTMLSelectElement];
    q1.value = '2';
    u1.value = 'PACK';
    submitBtn().click();
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(true);
    expect(errorText().textContent).toContain('补填失败');
    expect(errorText().classList.contains('hidden')).toBe(false);
    expect(rowValue(q1)).toBe('2');
    expect(u1.value).toBe('PACK');

    submitBtn().click();
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(isOpen()).toBe(false);
  });

  it('guards against duplicate submission while the callback is in flight', async () => {
    let release: (value: boolean) => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        })
    );
    (window as any).openShoppingCheckinPrompt({
      items: [{ id: 'it-1', name: '盐', amount: '适量' }],
      hasStructuredItems: false,
      onSubmit,
      onStructuredOnly: async () => true
    });
    const [q1, u1] = rows() as [HTMLInputElement, HTMLSelectElement];
    q1.value = '2';
    u1.value = 'BAG';
    submitBtn().click();
    await settle();
    expect(submitBtn().disabled).toBe(true);
    expect((q1 as HTMLInputElement).disabled).toBe(true);
    submitBtn().click();
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    release(true);
    await settle();
    expect(isOpen()).toBe(false);
  });

  it('structured-only branch calls onStructuredOnly and closes on true', async () => {
    const onStructuredOnly = vi.fn(async () => true);
    const onSubmit = vi.fn(async () => true);
    (window as any).openShoppingCheckinPrompt({
      items: [{ id: 'it-1', name: '盐', amount: '适量' }],
      hasStructuredItems: true,
      onSubmit,
      onStructuredOnly
    });
    expect(structuredBtn().disabled).toBe(false);
    structuredBtn().click();
    await settle();
    expect(onStructuredOnly).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(isOpen()).toBe(false);
  });

  it('cancel closes the modal without any request or callback', async () => {
    const onSubmit = vi.fn(async () => true);
    const onStructuredOnly = vi.fn(async () => true);
    const fetchMock = window.fetch as any;
    fetchMock.mockClear();
    (window as any).openShoppingCheckinPrompt({
      items: [{ id: 'it-1', name: '盐', amount: '适量' }],
      hasStructuredItems: true,
      onSubmit,
      onStructuredOnly
    });
    cancelBtn().click();
    await settle();
    expect(isOpen()).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onStructuredOnly).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('real adapter: fills free-text items with PUT before a single check-in', async () => {
    const item = (id: string, extra: Record<string, unknown>) => ({
      id,
      ingredientId: null,
      ingredientNameSnapshot: id,
      quantity: null,
      unit: null,
      amountText: '适量',
      sourceType: 'MANUAL',
      sourceId: null,
      completed: true,
      notes: null,
      sortOrder: 0,
      category: null,
      ...extra
    });
    const free = item('it-free', { ingredientNameSnapshot: '盐' });
    const structured = item('it-structured', {
      ingredientNameSnapshot: '鸡蛋',
      quantity: 2,
      unit: 'PIECE',
      amountText: null
    });
    const calls: Array<{ url: string; method: string; body: any }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: String(url), method, body });
      if (String(url).includes('/check-in')) return shoppingList(5, []);
      if (method === 'PUT') return shoppingList(4, [free, structured]);
      return shoppingList(4, [free, structured]);
    };
    localStorage.clear();
    boot(fetchImpl);
    await settle();
    await (window as any).DafanDomainAdapter.replaceShoppingService((window as any).BentoService.shopping)();

    (window as any).importCheckedShoppingToPantry();
    await settle();
    // 缺量项 → 弹窗而不是直接 check-in
    expect(isOpen()).toBe(true);
    expect(calls.some((call) => call.url.includes('/check-in'))).toBe(false);
    expect(structuredBtn().disabled).toBe(false);

    const [q1, u1] = rows() as [HTMLInputElement, HTMLSelectElement];
    q1.value = '3';
    u1.value = 'GRAM';
    submitBtn().click();
    await settle();
    await settle();

    const writeIndex = calls.findIndex((call) => call.method === 'PUT');
    const checkinIndex = calls.findIndex((call) => call.url.includes('/check-in'));
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(checkinIndex).toBeGreaterThan(writeIndex);
    expect(calls[writeIndex].body).toMatchObject({ quantity: 3, unit: 'GRAM' });
    expect(calls[checkinIndex].body.itemIds).toEqual(['it-free', 'it-structured']);
    expect(isOpen()).toBe(false);
  });

  it('real adapter: structured-only branch checks in only structured ids and keeps free-text items', async () => {
    const free = {
      id: 'it-free',
      ingredientId: null,
      ingredientNameSnapshot: '盐',
      quantity: null,
      unit: null,
      amountText: '适量',
      sourceType: 'MANUAL',
      sourceId: null,
      completed: true,
      notes: null,
      sortOrder: 0,
      category: null
    };
    const structured = {
      ...free,
      id: 'it-structured',
      ingredientNameSnapshot: '鸡蛋',
      quantity: 2,
      unit: 'PIECE',
      amountText: null
    };
    const calls: Array<{ url: string; method: string; body: any }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const method = init?.method || 'GET';
      calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
      return shoppingList(4, [
        { ...free, completed: true },
        { ...structured, completed: true }
      ]);
    };
    localStorage.clear();
    boot(fetchImpl);
    await settle();
    await (window as any).DafanDomainAdapter.replaceShoppingService((window as any).BentoService.shopping)();
    (window as any).importCheckedShoppingToPantry();
    await settle();
    expect(isOpen()).toBe(true);
    structuredBtn().click();
    await settle();
    await settle();
    const checkin = calls.find((call) => call.url.includes('/check-in'));
    expect(checkin?.body.itemIds).toEqual(['it-structured']);
    // 自由规格项未被补填，仍在清单中且保持勾选完成态
    const remaining = (window as any).BentoService.shopping.getAll();
    expect(remaining.find((row: any) => row.id === 'it-free')).toMatchObject({ isChecked: true });
    expect(isOpen()).toBe(false);
  });
});

function rowValue(input: HTMLInputElement) {
  return input.value;
}
