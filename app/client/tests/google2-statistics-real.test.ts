// @vitest-environment jsdom
// VAN-38 P1-1 / P1-2 / P1-3 / P2：统计页真实数据、周期边界、自烹预估节约与 2000 kcal 参考线
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');
const body = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

const response = (data: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ success: true, data })
});

const emptyPage = { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 };

async function bootAt(systemTime: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(systemTime);
  // 每个用例独立周期，避免上一用例的 range 残留
  delete (window as any).__dafanStatisticsRange;
  document.body.innerHTML = body;
  (window as any).currentCalendarYear = systemTime.getFullYear();
  (window as any).currentCalendarMonth = systemTime.getMonth() + 1;
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
      if (url.includes('/statistics')) return response(statisticsFixture());
      if (url.includes('/settings')) return response({});
      return response(emptyPage);
    })
  );
  window.eval(inline);
  window.eval(readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8'));
  await Promise.resolve();
  await Promise.resolve();
}

function statisticsFixture(overrides: Record<string, unknown> = {}) {
  return {
    period: { start: '2026-10-23', end: '2026-10-29' },
    costSummary: {
      totalCost: 680,
      takeoutCost: 294,
      dineInCost: 386,
      homemadeCost: 15,
      pricedRecordCount: 12,
      recordCount: 18,
      takeoutRecordCount: 8,
      dineInRecordCount: 4,
      homemadeRecordCount: 3,
      customRecordCount: 3
    },
    sourceBreakdown: { HOMEMADE: 3, TAKEOUT: 8, DINE_IN: 4, CUSTOM: 3 },
    calorieTrend: [
      { date: '2026-10-23', calories: 1780, recordedCaloriesCount: 2 },
      { date: '2026-10-24', calories: null, recordedCaloriesCount: 0 },
      { date: '2026-10-25', calories: 2400, recordedCaloriesCount: 3 },
      { date: '2026-10-26', calories: 2000, recordedCaloriesCount: 2 },
      { date: '2026-10-27', calories: null, recordedCaloriesCount: 0 },
      { date: '2026-10-28', calories: 900, recordedCaloriesCount: 1 },
      { date: '2026-10-29', calories: 2000, recordedCaloriesCount: 2 }
    ],
    satietySummary: {
      recordedCount: 10,
      distribution: [
        { satiety: 3, count: 1, category: 'LOW' },
        { satiety: 5, count: 1, category: 'LOW' },
        { satiety: 7, count: 3, category: 'COMFORTABLE' },
        { satiety: 8, count: 3, category: 'COMFORTABLE' },
        { satiety: 10, count: 2, category: 'OVER' }
      ],
      lowCount: 2,
      comfortableCount: 6,
      overCount: 2,
      lowPercent: 20,
      comfortablePercent: 60,
      overPercent: 20
    },
    ...overrides
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('P1-1 统计真实绑定与饱腹统一口径', () => {
  beforeEach(async () => {
    await bootAt(new Date(2026, 9, 29, 12, 0, 0));
  });

  it('自烹次数绑定真实 homemadeRecordCount，节约按 24 元/顿估算而非自烹成本', async () => {
    await (window as any).renderStatistics();
    const cook = document.getElementById('statCookCount');
    const saved = document.getElementById('statSavedExpense');
    expect(cook?.textContent).toBe('自烹 3 顿 (对标外卖预估)');
    // homemadeCost=15 只属于成本；节约必须 = 3 顿 × 24 = 72
    expect(saved?.textContent).toBe('¥ 72');
    expect(saved?.textContent).not.toBe('¥ 15');
    expect(saved?.textContent).not.toContain('26');
  });

  it('饱腹条颜色/图例/百分比全部来自 satietySummary，分母统一为 recordedCount', async () => {
    await (window as any).renderStatistics();
    const bar = document.getElementById('satietyBarContainer') as HTMLElement;
    const legend = bar?.nextElementSibling as HTMLElement;
    const segments = Array.from(bar.querySelectorAll('[data-satiety-category]'));
    expect(segments.map((node) => (node as HTMLElement).dataset.satietyCategory)).toEqual([
      'COMFORTABLE',
      'LOW',
      'OVER'
    ]);
    const widths = segments.map((node) => (node as HTMLElement).getAttribute('style') || '');
    expect(widths[0]).toContain('width:60%');
    expect(widths[1]).toContain('width:20%');
    expect(widths[2]).toContain('width:20%');
    // 颜色与图例来自同一口径：舒适绿 / 偏少黄 / 过饱红
    expect(widths[0]).toContain('background:#6ABF69');
    expect(widths[1]).toContain('background:#FFC53D');
    expect(widths[2]).toContain('background:#FF6B57');
    const legendText = legend.textContent || '';
    expect(legendText).toContain('(60%)');
    expect(legendText).toContain('(20%)');
    expect(document.getElementById('statSatietyScore')?.textContent || '').toContain('舒适达标 60%');
  });

  it('无饱腹记录时诚实空态：不画任何比例段、图例清空、达标率清空', async () => {
    (window as any).DafanApiClient.get = vi.fn(async (url: string) => {
      if (url.includes('/statistics'))
        return statisticsFixture({
          satietySummary: {
            recordedCount: 0,
            distribution: [],
            lowCount: 0,
            comfortableCount: 0,
            overCount: 0,
            lowPercent: null,
            comfortablePercent: null,
            overPercent: null
          }
        });
      return emptyPage;
    });
    await (window as any).renderStatistics();
    const bar = document.getElementById('satietyBarContainer') as HTMLElement;
    expect(bar.textContent).toContain('暂无饱腹数据');
    expect(bar.querySelectorAll('[data-satiety-category]').length).toBe(0);
    expect((bar.nextElementSibling as HTMLElement).textContent).toBe('');
    expect(document.getElementById('statSatietyScore')?.textContent).toBe('');
  });

  it('成本与次数全为 null 时统计卡清空，不伪造 0 或演示值', async () => {
    (window as any).DafanApiClient.get = vi.fn(async (url: string) => {
      if (url.includes('/statistics'))
        return statisticsFixture({
          costSummary: {
            totalCost: null,
            takeoutCost: null,
            dineInCost: null,
            homemadeCost: null,
            pricedRecordCount: 0,
            recordCount: 0,
            takeoutRecordCount: 0,
            dineInRecordCount: 0,
            homemadeRecordCount: 0,
            customRecordCount: 0
          },
          sourceBreakdown: {},
          calorieTrend: [{ date: '2026-10-29', calories: null, recordedCaloriesCount: 0 }]
        });
      return emptyPage;
    });
    await (window as any).renderStatistics();
    // 成本类字段 null → 诚实清空；自烹 0 顿 → 真实 0 顿（¥ 0 节约是 0 次的真实结果，不是伪造）
    expect(document.getElementById('statTotalExpense')?.textContent).toBe('');
    expect(document.getElementById('statTakeoutExpense')?.textContent).toBe('');
    expect(document.getElementById('statDineInExpense')?.textContent).toBe('');
    expect(document.getElementById('statSavedExpense')?.textContent).toBe('¥ 0');
    expect(document.getElementById('statCookCount')?.textContent).toBe('自烹 0 顿 (对标外卖预估)');
    expect(document.getElementById('statTakeoutCount')?.textContent).toBe('共 0 顿外卖');
    expect(document.getElementById('page-statistics')?.getAttribute('aria-busy')).toBeNull();
  });
});

describe('P1-2 近 7 天与本月周期边界', () => {
  it('近 7 天 = 今天及前 6 天的连续本地业务日期（跨月也连续）', async () => {
    await bootAt(new Date(2026, 10, 2, 9, 0, 0)); // 2026-11-02
    const get = vi.fn(async (url: string) => (url.includes('/statistics') ? statisticsFixture() : emptyPage));
    (window as any).DafanApiClient.get = get;
    (window as any).switchStatsRange('week');
    await Promise.resolve();
    await Promise.resolve();
    const call = get.mock.calls.map(([url]) => String(url)).find((url) => url.includes('/statistics'));
    expect(call).toContain('start=2026-10-27');
    expect(call).toContain('end=2026-11-02');
  });

  it('本月 = 自然月首日至最后一日，卡片与图表共用同一次请求', async () => {
    await bootAt(new Date(2026, 1, 15, 9, 0, 0)); // 2026-02-15 平年
    const get = vi.fn(async (url: string) => (url.includes('/statistics') ? statisticsFixture() : emptyPage));
    (window as any).DafanApiClient.get = get;
    await (window as any).renderStatistics();
    const urls = get.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/statistics'));
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain('start=2026-02-01');
    expect(urls[0]).toContain('end=2026-02-28');
  });

  it('本月闰年 2 月末日为 02-29', async () => {
    await bootAt(new Date(2028, 1, 10, 9, 0, 0));
    const get = vi.fn(async (url: string) => (url.includes('/statistics') ? statisticsFixture() : emptyPage));
    (window as any).DafanApiClient.get = get;
    await (window as any).renderStatistics();
    const url = get.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/statistics'));
    expect(url).toContain('start=2028-02-01');
    expect(url).toContain('end=2028-02-29');
  });
});

describe('P2 原版 2000 kcal 参考线', () => {
  beforeEach(async () => {
    await bootAt(new Date(2026, 9, 29, 12, 0, 0));
  });

  it('恢复固定 2000 kcal 参考线且与柱形同一比例尺', async () => {
    await (window as any).renderStatistics();
    const svg = document.querySelector('#chartCalorieTrendWrap svg');
    const line = svg?.querySelector('[data-reference-kcal]') as unknown as SVGElement;
    expect(line?.getAttribute('data-reference-kcal')).toBe('2000');
    // 数值恰为 2000 的柱形顶部与参考线在同一 y：证明共用同一 maxCal
    const bar = svg?.querySelector('[data-calories="2000"]') as unknown as SVGElement;
    expect(bar).toBeTruthy();
    expect(bar.getAttribute('y')).toBe(line.getAttribute('y1'));
    // 参考线常驻说明文案明确其为参考基准而非个人目标
    expect(document.getElementById('chartCalorieTrendWrap')?.previousElementSibling?.textContent).toContain(
      '非个人目标'
    );
  });

  it('参考线抬高比例尺下限：全部低热量时参考线仍在图内', async () => {
    (window as any).DafanApiClient.get = vi.fn(async (url: string) =>
      url.includes('/statistics')
        ? statisticsFixture({
            calorieTrend: [{ date: '2026-10-29', calories: 400, recordedCaloriesCount: 1 }]
          })
        : emptyPage
    );
    await (window as any).renderStatistics();
    const line = document.querySelector('#chartCalorieTrendWrap [data-reference-kcal]') as unknown as SVGElement;
    const y = Number(line.getAttribute('y1'));
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(150);
  });

  it('高于参考基准的柱形改用对比色，未超过保持绿色', async () => {
    await (window as any).renderStatistics();
    const over = document.querySelector('#chartCalorieTrendWrap [data-calories="2400"]') as unknown as SVGElement;
    const within = document.querySelector('#chartCalorieTrendWrap [data-calories="1780"]') as unknown as SVGElement;
    expect(over.getAttribute('fill')).toBe('#FF8575');
    expect(within.getAttribute('fill')).toBe('#6ABF69');
  });

  it('不恢复演示热量：无记录日不绘制柱形', async () => {
    await (window as any).renderStatistics();
    const bars = document.querySelectorAll('#chartCalorieTrendWrap rect[data-date]');
    expect(bars.length).toBe(5);
    const dates = Array.from(bars).map((node) => node.getAttribute('data-date'));
    expect(dates).not.toContain('2026-10-24');
    expect(dates).not.toContain('2026-10-27');
  });
});
