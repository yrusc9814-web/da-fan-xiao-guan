import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapter = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n;\n');
const markup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
const ok = (data: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, data }) });
function boot(fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>) {
  document.body.innerHTML = markup;
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
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
  window.eval(inline);
  window.eval(adapter);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
describe('Google2 Luna current binding repair', () => {
  it('真实 inline + adapter boot 清理nullable dashboard，保留nutrition/rating的0真值', async () => {
    boot(async (u) =>
      String(u).includes('/dashboard')
        ? ok({
            weeklyStats: { streakDays: null },
            todayRecords: [],
            recommendedRecipes: [],
            inventory: { expiringIngredients: [] },
            calendarDays: []
          })
        : ok([])
    );
    (window as any).DafanDashboardAdapter.mapDashboard({
      weeklyStats: { streakDays: null },
      todayRecords: [],
      recommendedRecipes: [],
      inventory: { expiringIngredients: [] },
      calendarDays: []
    });
    expect(document.querySelector('[data-binding="streakDays"]')?.textContent).toBe('');
    expect(
      (window as any).DafanDomainAdapter.mapRecord({
        recordDate: '2026-10-02',
        calories: 0,
        satiety: 0,
        rating: 0,
        notes: null,
        items: []
      })
    ).toMatchObject({ calories: 0, satiety: 0, rating: 0, notes: null });
  });
  it('真实renderRecords/setupDailyDiary 对null和0不产生undefined或假星级，expiryDate派生文案可见', () => {
    boot(async () =>
      ok({
        items: [
          {
            id: 'r1',
            recordDate: '2026-10-02',
            mealType: 'LUNCH',
            sourceType: 'HOMEMADE',
            status: 'CONFIRMED',
            calories: null,
            satiety: null,
            rating: 0,
            notes: null,
            version: 1,
            items: [{ itemType: 'CUSTOM', customName: '零值餐', sortOrder: 0 }]
          }
        ],
        page: 1,
        pageSize: 100,
        total: 1,
        totalPages: 1
      })
    );
    const rec = (window as any).DafanDomainAdapter.mapRecord({
      id: 'r1',
      recordDate: '2026-10-02',
      mealType: 'LUNCH',
      sourceType: 'HOMEMADE',
      status: 'CONFIRMED',
      calories: null,
      satiety: null,
      rating: 0,
      notes: null,
      version: 1,
      items: [{ itemType: 'CUSTOM', customName: '零值餐', sortOrder: 0 }]
    });
    (window as any).BentoService.records.data = [rec];
    (window as any).renderRecords();
    const text = document.getElementById('recordsListContainer')?.textContent || '';
    expect(text).not.toMatch(/null|undefined/);
    expect(text).not.toContain('★');
    (window as any).DafanDashboardAdapter.mapDashboard({
      weeklyStats: { streakDays: null },
      todayRecords: [],
      recommendedRecipes: [],
      inventory: { expiringIngredients: [{ id: 'i1', name: '牛奶', expiryDate: '2026-10-03', expireDaysLeft: null }] },
      calendarDays: []
    });
    expect(document.querySelector('[data-binding^="expiringIngredient-"]')?.textContent).not.toMatch(/null|undefined/);
    (window as any).BentoModal.setupDailyDiary({ year: 2026, month: 10, day: 2 });
    expect(document.getElementById('dailyDiaryMealsList')?.textContent || '').not.toMatch(/null|undefined/);
  });
  it('真实BentoModal.open recipeForm使用真实markup/remote结果，modal可见且form scoped', async () => {
    const requests: string[] = [];
    boot(async (u) => {
      requests.push(String(u));
      return String(u).includes('/recipes/r1')
        ? ok({
            id: 'r1',
            name: '真实菜谱',
            version: 4,
            cookingTimeMinutes: 20,
            calories: null,
            ingredients: [],
            steps: []
          })
        : String(u).includes('/recipes?')
          ? ok({
              items: [{ id: 'r1', name: '旧', version: 3, cookingTimeMinutes: 20, ingredients: [], steps: [] }],
              page: 1,
              pageSize: 100,
              total: 1,
              totalPages: 1
            })
          : ok([]);
    });
    const service = (window as any).BentoService.recipes;
    service.data = [
      (window as any).DafanDomainAdapter.mapRecipe({
        id: 'r1',
        name: '旧',
        version: 3,
        cookingTimeMinutes: 20,
        ingredients: [],
        steps: []
      })
    ];
    await (window as any).BentoModal.open('recipeForm', { id: 'r1', name: '编辑入口对象' });
    const modal = document.getElementById('modalRecipeForm')!;
    expect(requests.some((u) => u.includes('/recipes/r1'))).toBe(true);
    expect(modal.classList.contains('hidden')).toBe(false);
    expect(modal.querySelector('form')).toBeTruthy();
    expect((document.getElementById('formRecipeId') as HTMLInputElement).value).toBe('r1');
    expect((document.getElementById('formRecipeName') as HTMLInputElement).value).toBe('真实菜谱');
  });
});
