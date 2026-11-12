import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapter = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n;\n');
const bodyMarkup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
const response = (data: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ success: true, data })
});
const dto = (overrides: Record<string, unknown> = {}) => ({
  id: 'record-old',
  recordDate: '2026-10-01',
  mealType: 'LUNCH',
  sourceType: 'HOMEMADE',
  rating: 0,
  satiety: 0,
  calories: 0,
  cost: 0,
  notes: null,
  version: 3,
  items: [{ itemType: 'CUSTOM', customName: '旧记录', sortOrder: 0 }],
  ...overrides
});

function boot(fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>) {
  document.body.innerHTML = bodyMarkup;
  Object.defineProperty(Element.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent || '';
    },
    set(value) {
      this.textContent = value;
    }
  });
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  window.eval(inlineScripts);
  window.eval(adapter);
}

const flush = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Google2 date/dashboard evidence chains', () => {
  it('uses selected diary date for a new record POST and preserves an old record date on PUT', async () => {
    let records = [dto()];
    const requests: Array<[string, RequestInit | undefined]> = [];
    boot(async (url, init) => {
      const path = String(url);
      requests.push([path, init]);
      if (path === '/api/v1/records' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return response(dto({ id: 'record-new', recordDate: body.recordDate, version: 1 }));
      }
      if (path === '/api/v1/records/record-old' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        records = [dto({ recordDate: body.recordDate || '2026-10-01', version: 4 })];
        return response(records[0]);
      }
      if (path.includes('/records?'))
        return response({ items: records, page: 1, pageSize: 100, total: records.length, totalPages: 1 });
      if (path.includes('/dashboard'))
        return response({
          weeklyStats: { streakDays: 1 },
          todayRecords: [],
          recommendedRecipes: [],
          inventory: { expiringIngredients: [] },
          calendarDays: []
        });
      return response([]);
    });
    await flush();
    const selectedDate = { year: 2026, month: 10, day: 2 };
    (window as any).BentoModal.setupDailyDiary(selectedDate);
    (window as any).BentoModal.setupRecordForm(null);
    (document.getElementById('formRecordTitle') as HTMLInputElement).value = '新记录';
    const slotField = document.getElementById('formRecordSlot') as HTMLSelectElement;
    const typeField = document.getElementById('formRecordType') as HTMLSelectElement;
    slotField.value = slotField.options[0]?.value || '';
    typeField.value = typeField.options[0]?.value || '';
    (window as any).BentoModal.handleRecordFormSubmit({ preventDefault: vi.fn() });
    await flush();
    const post = requests.find(([url, init]) => url.includes('/records') && init?.method === 'POST');
    expect(requests.map(([url, init]) => `${init?.method || 'GET'} ${url}`)).toContain('POST /api/v1/records');
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.[1].body)).recordDate).toBe('2026-10-02');

    const old = (window as any).DafanDomainAdapter.mapRecord(dto());
    (window as any).BentoService.records.data = [old];
    (window as any).BentoModal.setupRecordForm(old);
    await (window as any).BentoModal.handleRecordFormSubmit({ preventDefault: vi.fn() });
    const put = requests.find(([url, init]) => url.endsWith('/records/record-old') && init?.method === 'PUT');
    expect(put).toBeDefined();
    const putBody = JSON.parse(String(put?.[1].body));
    expect(putBody.recordDate).not.toBe('2026-10-02');
    expect(records[0].recordDate).toBe('2026-10-01');
  });

  it('clears previously rendered dashboard leaves after the real loadDashboard request rejects', async () => {
    let fail = false;
    boot(async (url) => {
      if (String(url).includes('/dashboard')) {
        if (fail) throw new Error('dashboard unavailable');
        return response({
          weeklyStats: { streakDays: 7, totalMeals: 4 },
          todayRecords: [],
          recommendedRecipes: [],
          inventory: { expiringIngredients: [] },
          calendarDays: []
        });
      }
      return response([]);
    });
    await (window as any).DafanDashboardAdapter.loadDashboard();
    const streak = document.querySelector('[data-binding="streakDays"]') as HTMLElement;
    const meals = document.querySelector('[data-binding="weeklyStat-totalMeals"]') as HTMLElement;
    expect(streak).toBeTruthy();
    expect(meals).toBeTruthy();
    expect(streak.textContent).toBe('7');
    expect(meals.textContent).toBe('4');
    fail = true;
    await expect((window as any).DafanDashboardAdapter.loadDashboard()).rejects.toThrow('dashboard unavailable');
    expect(streak.textContent).toBe('');
    expect(meals.textContent).toBe('');
  });

  it.each([
    ['2026-10-03', '1天后到期'],
    ['2026-10-02', '0天后到期'],
    ['2026-10-01', '-1天后到期']
  ])('derives expiry copy from local expiryDate (%s)', (expiryDate, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 2, 12, 0, 0));
    boot(async () => response([]));
    (window as any).DafanDashboardAdapter.mapDashboard({
      weeklyStats: { streakDays: 0 },
      todayRecords: [],
      recommendedRecipes: [],
      calendarDays: [],
      inventory: { expiringIngredients: [{ id: 'ingredient-1', name: '牛奶', expiryDate }] }
    });
    const row = document.querySelector('[data-binding^="expiringIngredient-"]') as HTMLElement;
    expect(row).toBeTruthy();
    const expiry = row.querySelector('[data-business-value="expiry"]') as HTMLElement;
    expect(expiry).toBeTruthy();
    expect(expiry.textContent).toBe(expected);
    expect(expiry.textContent).not.toBe('');
    expect(expiry.textContent).not.toBe('undefined');
    expect(expiry.textContent).not.toBe('null');
  });
});
