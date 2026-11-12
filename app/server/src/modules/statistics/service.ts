import type { PrismaClient } from '@prisma/client';

import type {
  StatisticsCalorieTrendPoint,
  StatisticsCostSummary,
  StatisticsDto,
  StatisticsSatietySummary
} from '../../../../shared/types/statistics.js';

function businessDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function defaultRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return { start: businessDate(start), end: businessDate(now) };
}

function parseBusinessDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  // 显式 UTC 构造：new Date(year, ...) 对 0..99 年会加 1900 偏移，setUTCFullYear 没有该漂移。
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  // setUTCFullYear 会把不存在日期 rollover（2026-02-31 → 03-03、非闰年 2 月 29 日 → 3 月 1 日），回读逐字段比对拒绝。
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function formatBusinessDate(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate()
  ).padStart(2, '0')}`;
}

/** 单次查询最多枚举的日历天数（约 10 年）：逐日枚举不能被当作请求放大器。 */
const maxRangeDays = 3660;

/** 逐日枚举请求周期（含无记录日）：空态必须是 null，不能让前端把缺日当成 0。 */
function enumerateDates(start: Date, end: Date): string[] {
  const dates: string[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(formatBusinessDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** 饱和档位分类只采用正式 UI 语义：3/5 偏少、7/8 舒适、10 过饱；未知档位不入任何分类。 */
function satietyCategory(satiety: number): 'LOW' | 'COMFORTABLE' | 'OVER' | null {
  if (satiety === 3 || satiety === 5) return 'LOW';
  if (satiety === 7 || satiety === 8) return 'COMFORTABLE';
  if (satiety === 10) return 'OVER';
  return null;
}

const satietyLevels = [3, 5, 7, 8, 10] as const;

function percent(part: number, total: number): number | null {
  return total > 0 ? Number(((part / total) * 100).toFixed(1)) : null;
}

/** 求和只吃 nonnull；真 0 计入（不丢），全为 null 时返回 null（不伪造成 0）。 */
function sumOrNull(values: Array<number | null>): { total: number | null; count: number } {
  const filled = values.filter((value): value is number => value !== null);
  return {
    total: filled.length > 0 ? filled.reduce((sum, value) => sum + value, 0) : null,
    count: filled.length
  };
}

function buildCostSummary(records: Array<{ sourceType: string; cost: number | null }>): StatisticsCostSummary {
  const bySource = (sourceType: string) => records.filter((record) => record.sourceType === sourceType);
  const total = sumOrNull(records.map((record) => record.cost));
  const takeout = sumOrNull(bySource('TAKEOUT').map((record) => record.cost));
  const dineIn = sumOrNull(bySource('DINE_IN').map((record) => record.cost));
  const homemade = sumOrNull(bySource('HOMEMADE').map((record) => record.cost));

  return {
    totalCost: total.total,
    takeoutCost: takeout.total,
    dineInCost: dineIn.total,
    homemadeCost: homemade.total,
    pricedRecordCount: total.count,
    recordCount: records.length,
    takeoutRecordCount: bySource('TAKEOUT').length,
    dineInRecordCount: bySource('DINE_IN').length,
    homemadeRecordCount: bySource('HOMEMADE').length,
    customRecordCount: bySource('CUSTOM').length
  };
}

function buildSatietySummary(records: Array<{ satiety: number | null }>): StatisticsSatietySummary {
  const filled = records.filter((record) => record.satiety !== null) as Array<{ satiety: number }>;
  const distribution = satietyLevels.map((satiety) => ({
    satiety,
    count: filled.filter((record) => record.satiety === satiety).length,
    category: satietyCategory(satiety) as 'LOW' | 'COMFORTABLE' | 'OVER'
  }));
  const lowCount = filled.filter((record) => satietyCategory(record.satiety) === 'LOW').length;
  const comfortableCount = filled.filter((record) => satietyCategory(record.satiety) === 'COMFORTABLE').length;
  const overCount = filled.filter((record) => satietyCategory(record.satiety) === 'OVER').length;
  const recordedCount = filled.length;

  return {
    recordedCount,
    distribution,
    lowCount,
    comfortableCount,
    overCount,
    lowPercent: percent(lowCount, recordedCount),
    comfortablePercent: percent(comfortableCount, recordedCount),
    overPercent: percent(overCount, recordedCount)
  };
}

export async function getStatistics(
  database: PrismaClient,
  query: { start?: string; end?: string; dinerId?: string }
): Promise<StatisticsDto> {
  const fallback = defaultRange();
  const start = query.start ?? fallback.start;
  const end = query.end ?? fallback.end;
  // 严格日历校验：形状错误、真实不存在的日期（如 2026-02-31 / 平年 02-29）、start > end 都是 400，
  // 不允许 rollover 到相邻月份，也不允许把「未知」静默折成默认周期范围。
  const startDate = parseBusinessDate(start);
  const endDate = parseBusinessDate(end);
  if (!startDate || !endDate) {
    throw httpError(400, '统计起止日期无效：必须是 0001-01-01 至 9999-12-31 之间的真实日历日期（YYYY-MM-DD）');
  }
  if (startDate.getTime() > endDate.getTime()) {
    throw httpError(400, '统计起止日期无效：开始日期不能晚于结束日期');
  }
  const rangeDays = Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  if (rangeDays > maxRangeDays) {
    throw httpError(400, `统计区间过长：单次最多查询 ${maxRangeDays} 天（当前 ${rangeDays} 天）`);
  }
  const [records, consumptionLogs, shoppingItems] = await Promise.all([
    database.mealRecord.findMany({
      where: {
        deletedAt: null,
        status: 'CONFIRMED',
        recordDate: { gte: start, lte: end },
        ...(query.dinerId ? { diners: { some: { dinerId: query.dinerId } } } : {})
      },
      include: { items: { include: { recipe: true, store: true } }, diners: true }
    }),
    database.inventoryLog.findMany({
      where: {
        changeType: 'COOK_DEDUCT',
        createdAt: { gte: new Date(`${start}T00:00:00`), lte: new Date(`${end}T23:59:59.999`) }
      }
    }),
    database.shoppingListItem.findMany({
      where: {
        shoppingList: { deletedAt: null },
        createdAt: { gte: new Date(`${start}T00:00:00`), lte: new Date(`${end}T23:59:59.999`) }
      },
      select: { completed: true }
    })
  ]);

  const calorieTotals = new Map<string, { calories: number; recordedCaloriesCount: number }>();
  for (const record of records) {
    if (record.calories === null) continue;
    const value = calorieTotals.get(record.recordDate) ?? { calories: 0, recordedCaloriesCount: 0 };
    value.calories += record.calories;
    value.recordedCaloriesCount += 1;
    calorieTotals.set(record.recordDate, value);
  }
  const calorieTrend: StatisticsCalorieTrendPoint[] = enumerateDates(startDate, endDate).map((date) => {
    const value = calorieTotals.get(date);
    return {
      date,
      calories: value ? value.calories : null,
      recordedCaloriesCount: value ? value.recordedCaloriesCount : 0
    };
  });

  const sourceBreakdown: Record<string, number> = {};
  const mealTypeDistribution: Record<string, number> = {};
  const trend: Record<string, number> = {};
  const recipes = new Map<string, { id: string; name: string; count: number }>();
  const stores = new Map<string, { id: string; name: string; count: number }>();
  for (const record of records) {
    sourceBreakdown[record.sourceType] = (sourceBreakdown[record.sourceType] ?? 0) + 1;
    mealTypeDistribution[record.mealType] = (mealTypeDistribution[record.mealType] ?? 0) + 1;
    trend[record.recordDate] = (trend[record.recordDate] ?? 0) + 1;
    for (const item of record.items) {
      if (item.recipe) {
        const value = recipes.get(item.recipe.id) ?? { id: item.recipe.id, name: item.recipe.name, count: 0 };
        value.count += 1;
        recipes.set(value.id, value);
      }
      if (item.store) {
        const value = stores.get(item.store.id) ?? { id: item.store.id, name: item.store.name, count: 0 };
        value.count += 1;
        stores.set(value.id, value);
      }
    }
  }
  const rated = records.filter((record) => record.rating !== null);
  const rank = (values: Map<string, { id: string; name: string; count: number }>) =>
    [...values.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 10);
  const consumedByIngredient: Record<
    string,
    { ingredientId: string | null; name: string; quantity: number; unit: string }
  > = {};
  for (const log of consumptionLogs) {
    const key = `${log.ingredientId ?? log.ingredientNameSnapshot}:${log.unit}`;
    const value = consumedByIngredient[key] ?? {
      ingredientId: log.ingredientId,
      name: log.ingredientNameSnapshot,
      quantity: 0,
      unit: log.unit
    };
    value.quantity += Math.abs(log.changeQuantity);
    consumedByIngredient[key] = value;
  }
  return {
    period: { start, end },
    totalRecords: records.length,
    recordedDays: new Set(records.map((record) => record.recordDate)).size,
    totalMeals: records.length,
    sourceBreakdown,
    mealTypeDistribution,
    newTryCount: records.filter((record) => record.isNewTry).length,
    favoriteCount: records.filter((record) => record.favorite).length,
    averageRating: rated.length
      ? Number((rated.reduce((sum, record) => sum + (record.rating ?? 0), 0) / rated.length).toFixed(2))
      : null,
    topRecipes: rank(recipes),
    topStores: rank(stores),
    trend: Object.entries(trend)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count })),
    ingredientConsumption: Object.values(consumedByIngredient),
    shoppingCompletionRate: shoppingItems.length
      ? shoppingItems.filter((item) => item.completed).length / shoppingItems.length
      : null,
    calorieTrend,
    costSummary: buildCostSummary(records),
    satietySummary: buildSatietySummary(records)
  };
}
