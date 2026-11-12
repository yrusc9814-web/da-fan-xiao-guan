// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const adapter = readFileSync(resolve(process.cwd(), 'public/google2-adapter.js'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n;\n');
const markup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
const recipe = { id: 'r1', name: '番茄鸡蛋', version: 1, calories: null, ingredients: [], steps: [] };
const ok = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () =>
    JSON.stringify(status >= 200 && status < 300 ? { success: true, data } : { success: false, error: data })
});
function boot(fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>) {
  document.body.innerHTML = markup;
  (window as any).BentoService = (window as any).BentoService || {};
  const f = vi.fn(fetchImpl);
  vi.stubGlobal('fetch', f);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  Object.defineProperty(Element.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent || '';
    },
    set(v) {
      this.textContent = v;
    }
  });
  window.eval(`(() => { ${inline}\n })()`);
  window.eval('var BentoService = window.BentoService; var BentoModal = window.BentoModal;');
  window.eval(adapter);
  (window as any).BentoService.recipes.data = [(window as any).DafanDomainAdapter.mapRecipe(recipe)];
  return f;
}
function formEvent() {
  return {
    preventDefault: vi.fn(),
    currentTarget: document.querySelector('#modalRecordForm form'),
    submitter: document.querySelector('#modalRecordForm button[type="submit"]')
  };
}
function fillCook({ title = '自定义番茄鸡蛋' } = {}) {
  const slot = document.getElementById('formRecordSlot') as HTMLSelectElement;
  const type = document.getElementById('formRecordType') as HTMLSelectElement;
  slot.value = '晚餐';
  type.value = type.options[1]?.value || type.value;
  (document.getElementById('formRecordTitle') as HTMLInputElement).value = title;
  (document.getElementById('formRecordCalories') as HTMLInputElement).value = '';
  (document.getElementById('formRecordCost') as HTMLInputElement).value = '';
  (document.getElementById('formRecordSatiety') as HTMLSelectElement).value = '';
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
describe('真实 inline + adapter boot 菜谱打卡绑定', () => {
  it('真实菜谱打卡按钮打开表单，餐次确认后只发 cook-checkin 并保留 recipe/title/cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 2, 12, 0, 0));
    const record = {
      id: 'rec1',
      recordDate: '2026-10-02',
      mealType: 'DINNER',
      sourceType: 'TAKEOUT',
      title: '自定义番茄鸡蛋',
      calories: null,
      cost: null,
      satiety: null,
      rating: null,
      notes: null,
      photos: ['/uploads/cook.jpg'],
      version: 1,
      items: [{ itemType: 'RECIPE', recipeId: 'r1', recipe: { id: 'r1', name: '番茄鸡蛋' } }]
    };
    const f = boot(async (u, _i) =>
      String(u).includes('/cook-checkin')
        ? ok({ record })
        : String(u).includes('/recipes/r1')
          ? ok(recipe)
          : ok({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 })
    );
    await (window as any).BentoModal.open('recipeDetail', 'r1');
    const cookButton = document.querySelector('#modalRecipeDetail button[onclick*="cookCheckin"]') as HTMLButtonElement;
    expect(cookButton?.getAttribute('onclick')).toContain('cookCheckin');
    await (window as any).BentoService.recipes.cookCheckin('r1');
    await vi.waitFor(() => expect((window as any).BentoModal.__google2CookContext?.recipeId).toBe('r1'));
    await vi.waitFor(() =>
      expect(document.getElementById('modalRecordForm')?.classList.contains('hidden')).toBe(false)
    );
    const first = formEvent();
    await (window as any).BentoModal.handleRecordFormSubmit(first);
    expect(
      f.mock.calls.some(([u, i]) => String(u).includes('/cook-checkin') && (i as RequestInit)?.method === 'POST')
    ).toBe(false);
    fillCook();
    document.getElementById('photoSlotView-0')!.innerHTML = '<img src="/uploads/cook.jpg">';
    await (window as any).BentoModal.handleRecordFormSubmit(formEvent());
    await vi.waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes('/cook-checkin'))).toBe(true));
    const call = f.mock.calls.find(([u]) => String(u).includes('/cook-checkin'));
    expect(call).toBeTruthy();
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({
      recordDate: '2026-10-02',
      mealType: 'DINNER',
      sourceType: 'TAKEOUT',
      title: '自定义番茄鸡蛋',
      photos: ['/uploads/cook.jpg'],
      calories: null,
      satiety: null
    });
    expect((window as any).BentoService.records.data[0]).toMatchObject({
      id: 'rec1',
      title: '自定义番茄鸡蛋',
      recipeId: 'r1'
    });
  });
  it('选定日记日期进入菜谱打卡时发送选定业务日期', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 3, 12, 0, 0));
    const f = boot(async (u) =>
      String(u).includes('/cook-checkin')
        ? ok({ record: { id: 'diary-date-record', recordDate: '2026-10-02', items: [], version: 1 } })
        : String(u).endsWith('/recipes/r1')
          ? ok(recipe)
          : ok({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 })
    );
    await (window as any).BentoModal.setupDailyDiary({ year: 2026, month: 10, day: 2 });
    await (window as any).BentoService.recipes.cookCheckin('r1');
    fillCook();
    await (window as any).BentoModal.handleRecordFormSubmit(formEvent());
    await vi.waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes('/cook-checkin'))).toBe(true));
    const call = f.mock.calls.find(([u]) => String(u).includes('/cook-checkin'));
    expect(JSON.parse((call![1] as RequestInit).body as string).recordDate).toBe('2026-10-02');
  });

  it('菜谱打卡表单打开后跨午夜仍保持已选业务日期', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 2, 23, 59, 0));
    const f = boot(async (u) =>
      String(u).includes('/cook-checkin')
        ? ok({ record: { id: 'midnight-record', recordDate: '2026-10-02', items: [], version: 1 } })
        : String(u).endsWith('/recipes/r1')
          ? ok(recipe)
          : ok({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 })
    );
    await (window as any).BentoModal.setupDailyDiary({ year: 2026, month: 10, day: 2 });
    await (window as any).BentoService.recipes.cookCheckin('r1');
    vi.setSystemTime(new Date(2026, 9, 3, 0, 1, 0));
    fillCook();
    await (window as any).BentoModal.handleRecordFormSubmit(formEvent());
    await vi.waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes('/cook-checkin'))).toBe(true));
    const call = f.mock.calls.find(([u]) => String(u).includes('/cook-checkin'));
    expect(JSON.parse((call![1] as RequestInit).body as string).recordDate).toBe('2026-10-02');
  });

  it('409 保留 fields/photos/context 且可重试，成功前不关闭', async () => {
    let attempt = 0;
    const toasts: any[] = [];
    boot(async (u) => {
      if (String(u).includes('/cook-checkin')) {
        attempt += 1;
        return attempt === 1
          ? ok({ code: 'COOK_CHECKIN_CONFLICT', message: '已存在不同打卡' }, 409)
          : ok(
              {
                record: {
                  id: 'retry-record',
                  recordDate: '2026-10-02',
                  mealType: 'DINNER',
                  sourceType: 'TAKEOUT',
                  title: '自定义番茄鸡蛋',
                  photos: [],
                  items: [],
                  version: 1
                }
              },
              201
            );
      }
      return String(u).endsWith('/recipes/r1')
        ? ok(recipe)
        : ok({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 });
    });
    (window as any).showToast = (m: string, t: string) => toasts.push({ m, t });
    await (window as any).BentoService.recipes.cookCheckin('r1');
    fillCook();
    await (window as any).BentoModal.handleRecordFormSubmit(formEvent());
    expect({ attempt, toasts, context: (window as any).BentoModal.__google2CookContext }).toMatchObject({ attempt: 1 });
    await vi.waitFor(() => expect(toasts.some((x) => x.t === 'error')).toBe(true));
    expect(document.getElementById('modalRecordForm')?.classList.contains('hidden')).toBe(false);
    expect((document.getElementById('formRecordTitle') as HTMLInputElement).value).toBe('自定义番茄鸡蛋');
    expect(toasts.some((x) => x.t === 'success')).toBe(false);
    await (window as any).BentoModal.handleRecordFormSubmit(formEvent());
    await vi.waitFor(() => expect(attempt).toBe(2));
  });
  it('取消或普通 recordForm 不串 cook context，普通新建只发 records', async () => {
    const f = boot(async (u) =>
      String(u).includes('/records')
        ? ok({
            id: 'rec2',
            recordDate: '2026-10-02',
            mealType: 'DINNER',
            sourceType: 'TAKEOUT',
            title: '普通记录',
            items: [],
            version: 1
          })
        : ok({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 })
    );
    await (window as any).BentoService.recipes.cookCheckin('r1');
    (window as any).BentoModal.close(true);
    await (window as any).BentoModal.open('recordForm');
    fillCook({ title: '普通记录' });
    await (window as any).BentoModal.handleRecordFormSubmit(formEvent());
    expect(f.mock.calls.some(([u]) => String(u).includes('/cook-checkin'))).toBe(false);
    expect(f.mock.calls.some(([u]) => String(u).includes('/records'))).toBe(true);
  });
  it('title 编辑不依赖 items，保留 recipeId；title null 时回退旧 item', async () => {
    const mapped = (window as any).DafanDomainAdapter.mapRecord({
      id: 'rec3',
      recordDate: '2026-10-02',
      mealType: 'DINNER',
      sourceType: 'TAKEOUT',
      title: '新标题',
      recipeId: 'r1',
      version: 2,
      items: []
    });
    expect(mapped).toMatchObject({ title: '新标题', recipeId: 'r1' });
    expect(
      (window as any).DafanDomainAdapter.mapRecord({
        id: 'rec4',
        title: null,
        items: [{ itemType: 'RECIPE', recipeId: 'r1', recipe: { id: 'r1', name: '番茄鸡蛋' } }]
      })
    ).toMatchObject({ title: '番茄鸡蛋', recipeId: 'r1' });
  });
});
