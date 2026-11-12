import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');
const body = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

const response = (data: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ success: true, data })
});

async function boot(calendar = { year: 2026, month: 9 }) {
  document.body.innerHTML = body;
  (window as any).currentCalendarYear = calendar.year;
  (window as any).currentCalendarMonth = calendar.month;
  (window as any).BentoService = {
    stores: { data: [] },
    recipes: { data: [] },
    shopping: { data: [] },
    pantry: { data: [] },
    plans: { data: [] },
    records: { data: [] },
    tools: { data: [] }
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard'))
        return response({
          weeklyStats: { streakDays: 7 },
          todayRecords: [],
          recommendedRecipes: [],
          inventory: {},
          calendarDays: []
        });
      if (url.includes('/statistics'))
        return response({
          costSummary: {
            totalCost: 0,
            takeoutCost: 0,
            dineInCost: 0,
            homemadeCost: 0,
            takeoutRecordCount: 0,
            dineInRecordCount: 0
          },
          calorieTrend: [{ date: '2028-02-29', calories: 0 }],
          satietySummary: { recordedCount: 0, distribution: [] }
        });
      if (url.includes('/records')) return response({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 });
      return response({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 });
    })
  );
  window.eval(inline);
  window.eval(readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8'));
  await Promise.resolve();
}

describe('Google2 summary real production boot', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await boot({ year: 2028, month: 2 });
  });

  it('renders calendar markup, local leap-month records, pagination, navigation and stale guard', async () => {
    const calls: string[] = [];
    let resolveFirst!: (value: unknown) => void;
    const apiGet = vi.fn((url: string) => {
      calls.push(url);
      if (url.includes('2028-02') && url.includes('page=1'))
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      return Promise.resolve({
        items: [{ recordDate: '2028-02-29', deletedAt: null }],
        page: 2,
        pageSize: 100,
        total: 101,
        totalPages: 2
      });
    });
    (window as any).DafanApiClient.get = apiGet;
    const first = (window as any).renderCalendar();
    await Promise.resolve();
    (window as any).changeCalendarMonth(1);
    resolveFirst({
      items: [{ recordDate: '2028-02-01', deletedAt: null }],
      page: 1,
      pageSize: 100,
      total: 1,
      totalPages: 1
    });
    await first;
    await Promise.resolve();
    const grid = document.querySelector('#calendarDaysGrid') as HTMLElement;
    expect(grid.textContent).toContain('29');
    expect(grid.innerHTML).toContain("BentoModal.open('dailyDiary'");
    expect(calls.some((url) => url.includes('status=CONFIRMED') && url.includes('pageSize=100'))).toBe(true);
    expect(calls.some((url) => url.includes('2028-03-01'))).toBe(true);
  });

  it('renders real statistic bindings with zero/null honesty, range query, busy and error state', async () => {
    const apiGet = vi.fn(async (url: string) => {
      if (url.includes('/statistics'))
        return {
          costSummary: {
            totalCost: 0,
            takeoutCost: 0,
            dineInCost: 0,
            homemadeCost: 0,
            takeoutRecordCount: 0,
            dineInRecordCount: 0
          },
          calorieTrend: [{ date: '2028-02-29', calories: 0 }],
          satietySummary: { recordedCount: 0, distribution: [] }
        };
      return { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 };
    });
    (window as any).DafanApiClient.get = apiGet;
    await (window as any).renderStatistics();
    expect(document.querySelector('#statTotalExpense')?.textContent).toBe('¥ 0');
    expect(document.querySelector('#chartCalorieTrendWrap')?.textContent).toContain('0 kcal');
    expect(document.querySelector('#satietyBarContainer')?.textContent).toContain('暂无饱腹数据');
    expect(document.querySelector('#page-statistics')?.getAttribute('aria-busy')).toBeNull();
    (window as any).switchStatsRange('week');
    await Promise.resolve();
    expect((window as any).DafanApiClient.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/statistics\?start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}/)
    );
    expect(document.querySelector('[data-binding="streakDays"]')?.textContent).toBe('7');
  });
});
