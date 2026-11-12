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
    ['2026-09-01', '余 0 天', ['临期预警']],
    ['2026-08-31', '余 -1 天', ['临期预警']]
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
    for (const badge of ['新鲜', '临期预警', '建议尽快']) {
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
      (window as any).DafanDomainAdapter.replaceRecipeService((window as any).BentoService.recipes);
      (window as any).DafanDomainAdapter.replacePantryService((window as any).BentoService.pantry);
      (window as any).DafanDomainAdapter.replaceShoppingService((window as any).BentoService.shopping);
      vi.mocked(window.fetch).mockClear();
    });
  }

  it('adds missing ingredient with amountText 2 个 as quantity 2 PIECE', async () => {
    const toast = vi.fn();
    (window as any).showToast = toast;
    await setupServices();
    const fetchMock = window.fetch as any;
    fetchMock
      .mockResolvedValueOnce(json(shoppingList(2)))
      .mockResolvedValueOnce(json(shoppingList(3, [{ id: 'it1' }])));
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
    const post = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'POST' && String(init?.body).includes('鸡蛋')
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      ingredientName: '鸡蛋 (2 个)',
      quantity: 2,
      unit: 'PIECE'
    });
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('失败'), 'error');
  });

  it('preflights unsupported 适量, with no item POST, success toast, or recipe mutation', async () => {
    const toast = vi.fn();
    (window as any).showToast = toast;
    await setupServices();
    const fetchMock = window.fetch as any;
    const services = (window as any).BentoService;
    const original = { name: '盐', quantity: 1, unit: 'OTHER', amountText: '适量' };
    const recipe = (window as any).DafanDomainAdapter.mapRecipe({
      id: 'r2',
      name: '家常菜',
      version: 1,
      ingredients: [original],
      steps: []
    });
    services.recipes.data = [recipe];
    await expect(services.recipes.addMissingIngredientsToShopping('r2')).rejects.toMatchObject({
      code: 'SHOPPING_AMOUNT_UNSUPPORTED'
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('成功'), 'success');
    expect(recipe.ingredients).toEqual([expect.objectContaining(original)]);
  });
});
