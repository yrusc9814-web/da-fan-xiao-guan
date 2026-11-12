import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DashboardDto } from '../../shared/types/dashboard.js';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerDashboardRoutes } from '../src/modules/dashboard/routes.js';
import { registerStatisticsRoutes } from '../src/modules/statistics/routes.js';

/**
 * VAN-34 后端真实统计契约（首页 streak / greetingTitle、统计页 calorieTrend / costSummary / satietySummary）。
 *
 * 隔离数据库：必须通过 TEST_DATABASE_URL 指到专属库（如 file:../../../data/google2-summary-test.db），
 * 绝不连接 data/app.db。
 *
 * 断言目标：
 * - 连续记录天数来自真实有效记录（CONFIRMED 且未软删）的日期去重后可跨周回溯，
 *   今天未记录时从昨天起算，DRAFT / 已删除不参与，本周 recordedDays 不冒充 streak。
 * - calorieTrend 覆盖请求周期每一天，无数据日为 null（不是 0），真 0 保留。
 * - costSummary 只对 nonnull 求和；全为 null 时为 null（不推对照价）。
 * - satietySummary 只统计 nonnull 档位，与「饱腹感达标」既有 UI 区间一致（3/5 偏少、7/8 舒适、10 过饱），
 *   分母为 nonnull 记录数，无数据时百分比为 null。
 */

const database = createTestPrismaClient();
let app: FastifyInstance;

const STREAK_ID_PREFIX = 'van34-streak-';
const STATS_ID_PREFIX = 'van34-stats-';

function businessDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function offsetDate(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return businessDate(date);
}

const STATS_RANGE = { start: '2062-03-01', end: '2062-03-07' };
const STATS_OUT_OF_RANGE_DATE = '2062-02-20';
const EMPTY_RANGE = { start: '2063-01-01', end: '2063-01-02' };
async function deleteRecords(where: Record<string, unknown>): Promise<void> {
  const records = await database.mealRecord.findMany({ where, select: { id: true } });
  const ids = records.map((record) => record.id);
  if (ids.length === 0) return;
  await database.mealRecordDiner.deleteMany({ where: { mealRecordId: { in: ids } } });
  await database.mealRecordItem.deleteMany({ where: { mealRecordId: { in: ids } } });
  await database.mealRecord.deleteMany({ where: { id: { in: ids } } });
}

async function cleanupStreakFixtures(): Promise<void> {
  await deleteRecords({ id: { startsWith: STREAK_ID_PREFIX } });
}

/**
 * 测试库为多文件共享，其他测试可能留下真实记录。连续天数按定义依赖「今天/昨天」锚点，
 * 因此这里先快照基线有效记录日期（本文件 fixture 已清理），再用独立实现算期望值，
 * 让断言对共享库噪声不敏感，同时保持对 spec 的严格校验。
 */
async function effectiveRecordDates(): Promise<Set<string>> {
  const rows = await database.mealRecord.findMany({
    where: { status: 'CONFIRMED', deletedAt: null },
    select: { recordDate: true },
    distinct: ['recordDate']
  });
  return new Set(rows.map((row) => row.recordDate));
}

function expectedStreak(dates: Set<string>): number {
  const today = businessDate(new Date());
  const yesterday = offsetDate(-1);
  const anchor = dates.has(today) ? today : yesterday;
  if (!dates.has(anchor)) return 0;
  let streak = 0;
  let offset = anchor === today ? 0 : -1;
  while (dates.has(offsetDate(offset))) {
    streak += 1;
    offset -= 1;
  }
  return streak;
}

let baselineDates = new Set<string>();

function expectedWith(ourDates: string[]): number {
  return expectedStreak(new Set([...baselineDates, ...ourDates]));
}

async function cleanupStatsFixtures(): Promise<void> {
  await deleteRecords({ id: { startsWith: STATS_ID_PREFIX } });
}

/** 建真实有效记录：默认 CONFIRMED 且未软删。 */
async function createRecord(input: {
  id: string;
  recordDate: string;
  mealType?: 'BREAKFAST' | 'LUNCH' | 'DINNER';
  sourceType?: 'HOMEMADE' | 'DINE_IN' | 'TAKEOUT' | 'CUSTOM';
  status?: 'DRAFT' | 'CONFIRMED';
  calories?: number | null;
  cost?: number | null;
  satiety?: number | null;
  rating?: number | null;
  deleted?: boolean;
}) {
  return database.mealRecord.create({
    data: {
      id: input.id,
      recordDate: input.recordDate,
      mealType: input.mealType ?? 'LUNCH',
      sourceType: input.sourceType ?? 'HOMEMADE',
      status: input.status ?? 'CONFIRMED',
      calories: input.calories ?? null,
      cost: input.cost ?? null,
      satiety: input.satiety ?? null,
      rating: input.rating ?? null,
      deletedAt: input.deleted ? new Date() : null
    }
  });
}

async function dashboard(): Promise<DashboardDto> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
  expect(response.statusCode).toBe(200);
  return response.json().data as DashboardDto;
}

describe('Google2 后端真实首页/统计契约', () => {
  beforeAll(async () => {
    await database.$connect();
    await cleanupStreakFixtures();
    await cleanupStatsFixtures();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerDashboardRoutes(app, database);
    await registerStatisticsRoutes(app, database);
  });

  beforeEach(async () => {
    await cleanupStreakFixtures();
    await database.settings.deleteMany({ where: { id: 1 } });
    baselineDates = await effectiveRecordDates();
  });

  afterAll(async () => {
    await cleanupStreakFixtures();
    await cleanupStatsFixtures();
    await database.settings.deleteMany({ where: { id: 1 } });
    await app.close();
    await database.$disconnect();
  });

  describe('dashboard.weeklyStats.streakDays', () => {
    it('今天未记录时从昨天回溯，跨周累计（不按本周 7 天截断）', async () => {
      const ours: string[] = [];
      for (let offset = -1; offset >= -9; offset -= 1) {
        const date = offsetDate(offset);
        ours.push(date);
        await createRecord({ id: `${STREAK_ID_PREFIX}${offset}`, recordDate: date });
      }

      const data = await dashboard();
      const expected = expectedWith(ours);
      expect(expected).toBeGreaterThanOrEqual(9);
      expect(data.weeklyStats.streakDays).toBe(expected);
      // 本周 recordedDays 只覆盖周一起的 7 天窗口，不能冒充跨周连续天数
      expect(data.weeklyStats.recordedDays).toBeLessThanOrEqual(7);
    });

    it('今天有记录时从今天回溯', async () => {
      const ours: string[] = [];
      for (const offset of [0, -1, -2, -3]) {
        const date = offsetDate(offset);
        ours.push(date);
        await createRecord({ id: `${STREAK_ID_PREFIX}t${offset}`, recordDate: date });
      }

      const data = await dashboard();
      expect(data.weeklyStats.streakDays).toBe(expectedWith(ours));
    });

    it('今天与昨天都没有有效记录时不接上更早的记录', async () => {
      // 测试库被同一次 run 的其他文件共享（如 dashboard seed 会写入今天记录），
      // 该场景必须显式屏蔽今天/昨天锚点噪声，否则无法构造；屏蔽在 finally 中精确还原。
      const anchorDates = [offsetDate(0), offsetDate(-1)];
      const suppressed = await database.mealRecord.findMany({
        where: { deletedAt: null, status: 'CONFIRMED', recordDate: { in: anchorDates } },
        select: { id: true }
      });
      const suppressedIds = suppressed.map((row) => row.id);
      if (suppressedIds.length > 0) {
        await database.mealRecord.updateMany({ where: { id: { in: suppressedIds } }, data: { deletedAt: new Date() } });
      }
      try {
        for (const offset of [-2, -3, -4]) {
          await createRecord({ id: `${STREAK_ID_PREFIX}b${offset}`, recordDate: offsetDate(offset) });
        }

        const data = await dashboard();
        expect(data.weeklyStats.streakDays).toBe(0);
        // 更早的记录真实存在于库中，只是不该被接上：按日期独立核验锚点确实为空
        const dates = await effectiveRecordDates();
        expect(dates.has(offsetDate(0))).toBe(false);
        expect(dates.has(offsetDate(-1))).toBe(false);
      } finally {
        if (suppressedIds.length > 0) {
          await database.mealRecord.updateMany({ where: { id: { in: suppressedIds } }, data: { deletedAt: null } });
        }
      }
    });

    it('中间断档即停止，只统计连续段', async () => {
      const ours = [offsetDate(0), offsetDate(-1), offsetDate(-3), offsetDate(-4), offsetDate(-5)];
      for (const [index, date] of ours.entries()) {
        await createRecord({ id: `${STREAK_ID_PREFIX}g${index}`, recordDate: date });
      }

      const data = await dashboard();
      // 今天与昨天连续、-2 断档：连续段长度固定为 2，不受更早记录影响
      expect(data.weeklyStats.streakDays).toBe(2);
      expect(expectedWith(ours)).toBeGreaterThanOrEqual(2);
    });

    it('同一业务日多条有效记录只算 1 天', async () => {
      await createRecord({ id: `${STREAK_ID_PREFIX}d1`, recordDate: offsetDate(0), mealType: 'BREAKFAST' });
      await createRecord({ id: `${STREAK_ID_PREFIX}d2`, recordDate: offsetDate(0), mealType: 'DINNER' });
      await createRecord({ id: `${STREAK_ID_PREFIX}d3`, recordDate: offsetDate(-1) });

      const data = await dashboard();
      expect(data.weeklyStats.streakDays).toBe(expectedWith([offsetDate(0), offsetDate(-1)]));
    });

    it('DRAFT 与已软删记录不参与连续天数（不凭前端 activeness）', async () => {
      await createRecord({ id: `${STREAK_ID_PREFIX}draft`, recordDate: offsetDate(0), status: 'DRAFT' });
      await createRecord({ id: `${STREAK_ID_PREFIX}deleted`, recordDate: offsetDate(-1), deleted: true });
      await createRecord({ id: `${STREAK_ID_PREFIX}deleted2`, recordDate: offsetDate(-2), deleted: true });

      const data = await dashboard();
      expect(data.weeklyStats.streakDays).toBe(expectedWith([]));
    });
  });

  describe('dashboard.greetingTitle', () => {
    it('无昵称时只输出真实时段称谓，与 greetingPeriod 一致，不编造业务数字', async () => {
      const data = await dashboard();
      const expected: Record<string, string> = { morning: '早上好', afternoon: '下午好', evening: '晚上好' };
      expect(data.greetingTitle).toBe(expected[data.greetingPeriod]);
      expect(data.greetingTitle).not.toMatch(/\d/);
      expect(typeof data.greetingText).toBe('string');
      expect(data.greetingText.length).toBeGreaterThan(0);
    });

    it('有真实昵称时使用真实昵称', async () => {
      await database.settings.create({ data: { id: 1, userNickname: '验收小羊' } });

      const data = await dashboard();
      const expected: Record<string, string> = { morning: '早上好', afternoon: '下午好', evening: '晚上好' };
      expect(data.greetingTitle).toBe(`${expected[data.greetingPeriod]}，验收小羊`);
      expect(data.userNickname).toBe('验收小羊');
    });
  });

  describe('statistics.calorieTrend / costSummary / satietySummary', () => {
    beforeEach(async () => {
      await cleanupStatsFixtures();
      // 周期内：03-01 两条（热量 500 自烹 / 300 外卖）、03-02 一条（热量未填、cost 真 0）
      await createRecord({
        id: `${STATS_ID_PREFIX}1`,
        recordDate: '2062-03-01',
        sourceType: 'HOMEMADE',
        calories: 500,
        cost: 30,
        satiety: 8,
        rating: 5
      });
      await createRecord({
        id: `${STATS_ID_PREFIX}2`,
        recordDate: '2062-03-01',
        sourceType: 'TAKEOUT',
        calories: 300,
        cost: null,
        satiety: 3,
        rating: 4
      });
      await createRecord({
        id: `${STATS_ID_PREFIX}3`,
        recordDate: '2062-03-02',
        sourceType: 'DINE_IN',
        calories: null,
        cost: 0,
        satiety: null
      });
      // 噪声：DRAFT、已软删、超出请求周期，三者都必须被排除
      await createRecord({
        id: `${STATS_ID_PREFIX}draft`,
        recordDate: '2062-03-03',
        status: 'DRAFT',
        calories: 999,
        cost: 999,
        satiety: 10
      });
      await createRecord({
        id: `${STATS_ID_PREFIX}deleted`,
        recordDate: '2062-03-04',
        calories: 888,
        cost: 888,
        satiety: 10,
        deleted: true
      });
      await createRecord({
        id: `${STATS_ID_PREFIX}out`,
        recordDate: STATS_OUT_OF_RANGE_DATE,
        calories: 777,
        cost: 77,
        satiety: 10
      });
    });

    it('calorieTrend 覆盖周期每一天，无数据日为 null 且真 0 保留', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/statistics?start=${STATS_RANGE.start}&end=${STATS_RANGE.end}`
      });
      expect(response.statusCode).toBe(200);
      const data = response.json().data;

      expect(data.calorieTrend).toHaveLength(7);
      expect(data.calorieTrend.map((point: { date: string }) => point.date)).toEqual([
        '2062-03-01',
        '2062-03-02',
        '2062-03-03',
        '2062-03-04',
        '2062-03-05',
        '2062-03-06',
        '2062-03-07'
      ]);
      expect(data.calorieTrend[0]).toEqual({ date: '2062-03-01', calories: 800, recordedCaloriesCount: 2 });
      // 有记录但一个热量都没填：必须是 null，不能伪造成 0
      expect(data.calorieTrend[1]).toEqual({ date: '2062-03-02', calories: null, recordedCaloriesCount: 0 });
      for (const index of [2, 3, 4, 5, 6]) {
        expect(data.calorieTrend[index].calories).toBeNull();
        expect(data.calorieTrend[index].recordedCaloriesCount).toBe(0);
      }
      // DRAFT / 软删 / 周期外不进入趋势
      expect(data.calorieTrend.every((point: { calories: number | null }) => point.calories !== 999)).toBe(true);
      expect(data.calorieTrend.every((point: { calories: number | null }) => point.calories !== 888)).toBe(true);
      expect(data.calorieTrend.some((point: { date: string }) => point.date === STATS_OUT_OF_RANGE_DATE)).toBe(false);
    });

    it('costSummary 只对 nonnull 求和，真 0 计入，全为 null 时是 null 不推对照价', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/statistics?start=${STATS_RANGE.start}&end=${STATS_RANGE.end}`
      });
      const { costSummary } = response.json().data;

      expect(costSummary.totalCost).toBe(30);
      expect(costSummary.homemadeCost).toBe(30);
      // 堂食唯一记录 cost = 0（真实填写），必须计入而不是被当成未填
      expect(costSummary.dineInCost).toBe(0);
      // 外卖记录 cost 为 null：没有可比数据，不给外卖成本编数
      expect(costSummary.takeoutCost).toBeNull();
      expect(costSummary.pricedRecordCount).toBe(2);
      expect(costSummary.recordCount).toBe(3);
      expect(costSummary.homemadeRecordCount).toBe(1);
      expect(costSummary.takeoutRecordCount).toBe(1);
      expect(costSummary.dineInRecordCount).toBe(1);
      expect(costSummary.customRecordCount).toBe(0);
    });

    it('satietySummary 只统计 nonnull 档位，按既有 UI 语义分类且分母为 nonnull', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/statistics?start=${STATS_RANGE.start}&end=${STATS_RANGE.end}`
      });
      const { satietySummary } = response.json().data;

      expect(satietySummary.recordedCount).toBe(2);
      expect(satietySummary.distribution).toEqual([
        { satiety: 3, count: 1, category: 'LOW' },
        { satiety: 5, count: 0, category: 'LOW' },
        { satiety: 7, count: 0, category: 'COMFORTABLE' },
        { satiety: 8, count: 1, category: 'COMFORTABLE' },
        { satiety: 10, count: 0, category: 'OVER' }
      ]);
      expect(satietySummary.lowCount).toBe(1);
      expect(satietySummary.comfortableCount).toBe(1);
      expect(satietySummary.overCount).toBe(0);
      expect(satietySummary.lowPercent).toBe(50);
      expect(satietySummary.comfortablePercent).toBe(50);
      expect(satietySummary.overPercent).toBe(0);
    });

    it('无任何有效记录的周期返回诚实空态（null / 全 0 计数），并保留既有结构', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/statistics?start=${EMPTY_RANGE.start}&end=${EMPTY_RANGE.end}`
      });
      expect(response.statusCode).toBe(200);
      const data = response.json().data;

      expect(data.calorieTrend).toEqual([
        { date: EMPTY_RANGE.start, calories: null, recordedCaloriesCount: 0 },
        { date: EMPTY_RANGE.end, calories: null, recordedCaloriesCount: 0 }
      ]);
      expect(data.costSummary.totalCost).toBeNull();
      expect(data.costSummary.takeoutCost).toBeNull();
      expect(data.costSummary.dineInCost).toBeNull();
      expect(data.costSummary.homemadeCost).toBeNull();
      expect(data.costSummary.pricedRecordCount).toBe(0);
      expect(data.costSummary.recordCount).toBe(0);
      expect(data.satietySummary.recordedCount).toBe(0);
      expect(data.satietySummary.lowPercent).toBeNull();
      expect(data.satietySummary.comfortablePercent).toBeNull();
      expect(data.satietySummary.overPercent).toBeNull();
      expect(data.satietySummary.distribution.every((bucket: { count: number }) => bucket.count === 0)).toBe(true);

      // 既有契约字段保留，且为空态真实值
      expect(data.period).toEqual(EMPTY_RANGE);
      expect(data.totalRecords).toBe(0);
      expect(data.recordedDays).toBe(0);
      expect(data.totalMeals).toBe(0);
      expect(data.averageRating).toBeNull();
      expect(data.sourceBreakdown).toEqual({});
      expect(data.trend).toEqual([]);
      expect(data.ingredientConsumption).toEqual([]);
      expect(data.shoppingCompletionRate).toBeNull();
      expect(data.topRecipes).toEqual([]);
      expect(data.topStores).toEqual([]);
    });

    it('周期内既有统计口径不变（sourceBreakdown / 评分 / 记录数）且未填营养字段不影响', async () => {
      const data = (
        await app.inject({ method: 'GET', url: `/api/v1/statistics?start=${STATS_RANGE.start}&end=${STATS_RANGE.end}` })
      ).json().data;

      expect(data.totalRecords).toBe(3);
      expect(data.totalMeals).toBe(3);
      expect(data.recordedDays).toBe(2);
      expect(data.sourceBreakdown).toEqual({ HOMEMADE: 1, TAKEOUT: 1, DINE_IN: 1 });
      expect(data.averageRating).toBe(4.5);
      expect(data.newTryCount).toBe(0);
      expect(data.favoriteCount).toBe(0);
    });

    it('单日周期只返回该日一天的趋势（含无数据日 null）', async () => {
      const data = (
        await app.inject({ method: 'GET', url: '/api/v1/statistics?start=2062-03-05&end=2062-03-05' })
      ).json().data;
      expect(data.calorieTrend).toEqual([{ date: '2062-03-05', calories: null, recordedCaloriesCount: 0 }]);
      expect(data.costSummary.totalCost).toBeNull();
      expect(data.satietySummary.recordedCount).toBe(0);
    });
  });

  describe('statistics 日期校验（真实日历 / 顺序 / 区间上限）', () => {
    async function statsQuery(start: string, end: string) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/statistics?start=${start}&end=${end}` });
      return { statusCode: response.statusCode, payload: response.json() };
    }

    it('不存在的日历日期一律 400，不允许 rollover（2026-02-31 / 平年 02-29 / 13 月 / 00 日）', async () => {
      for (const [start, end] of [
        ['2026-02-31', '2026-03-05'],
        ['2026-02-29', '2026-03-05'],
        ['2062-02-30', '2062-03-05'],
        ['2062-13-01', '2062-13-05'],
        ['2062-03-00', '2062-03-05'],
        ['2062-03-05', '2062-04-31'],
        ['2062-04-31', '2062-05-01']
      ]) {
        const { statusCode, payload } = await statsQuery(start, end);
        expect(statusCode, `${start}..${end}`).toBe(400);
        expect(payload.success).toBe(false);
        expect(payload.error.code).toBe('VALIDATION_ERROR');
        expect(payload.error.message).toContain('统计起止日期无效');
      }
    });

    it('形状非法（缺位 / 越界位数 / 非数字）在 schema 层即 400', async () => {
      for (const [start, end] of [
        ['2062-3-1', '2062-03-07'],
        ['2062-03-01T00:00:00', '2062-03-07'],
        ['0000-01-01', '0000-01-02'],
        ['2062-03-07', '2062-03-01']
      ]) {
        const { statusCode } = await statsQuery(start, end);
        expect(statusCode, `${start}..${end}`).toBe(400);
      }
    });

    it('start > end 返回 400，且不回退到默认周期', async () => {
      const { statusCode, payload } = await statsQuery('2062-03-07', '2062-03-01');
      expect(statusCode).toBe(400);
      expect(payload.success).toBe(false);
      expect(payload.data).toBeNull();
    });

    it('合法边界：0001-01-01、9999-12-31、闰年 02-29 被接受且日期不被 UTC 平移', async () => {
      const leap = await statsQuery('2028-02-29', '2028-02-29');
      expect(leap.statusCode).toBe(200);
      expect(leap.payload.data.period).toEqual({ start: '2028-02-29', end: '2028-02-29' });
      expect(leap.payload.data.calorieTrend).toEqual([
        { date: '2028-02-29', calories: null, recordedCaloriesCount: 0 }
      ]);

      const min = await statsQuery('0001-01-01', '0001-01-01');
      expect(min.statusCode).toBe(200);
      expect(min.payload.data.calorieTrend).toEqual([{ date: '0001-01-01', calories: null, recordedCaloriesCount: 0 }]);

      const max = await statsQuery('9999-12-31', '9999-12-31');
      expect(max.statusCode).toBe(200);
      expect(max.payload.data.calorieTrend).toEqual([{ date: '9999-12-31', calories: null, recordedCaloriesCount: 0 }]);
    });

    it('两位年份 0099 不漂移到 1999（year 0..99 不加 1900）', async () => {
      const { statusCode, payload } = await statsQuery('0099-01-02', '0099-01-03');
      expect(statusCode).toBe(200);
      expect(payload.data.period).toEqual({ start: '0099-01-02', end: '0099-01-03' });
      expect(payload.data.calorieTrend.map((point: { date: string }) => point.date)).toEqual([
        '0099-01-02',
        '0099-01-03'
      ]);
    });

    it('区间上限 3660 天：恰好在边界内通过，超一天即 400', async () => {
      const atLimit = await statsQuery('2060-01-01', '2070-01-07');
      expect(atLimit.statusCode).toBe(200);
      expect(atLimit.payload.data.calorieTrend).toHaveLength(3660);
      expect(atLimit.payload.data.calorieTrend.at(0).date).toBe('2060-01-01');
      expect(atLimit.payload.data.calorieTrend.at(-1).date).toBe('2070-01-07');

      const overLimit = await statsQuery('2060-01-01', '2070-01-08');
      expect(overLimit.statusCode).toBe(400);
      expect(overLimit.payload.success).toBe(false);
      expect(overLimit.payload.error.message).toContain('3660');

      const reversedLimit = await statsQuery('2070-01-08', '2060-01-01');
      expect(reversedLimit.statusCode).toBe(400);
    });
  });
});
