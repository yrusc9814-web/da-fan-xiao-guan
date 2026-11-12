/**
 * Google 2.0 统计页真实数据契约（VAN-34）。
 *
 * 原则：所有数值来自数据库真实聚合，nonnull 才参与求和/比例；
 * 无可用数据时返回 null（空态），不用 0 或推定价冒充真实值。
 */

export interface StatisticsCalorieTrendPoint {
  /** 业务日期 YYYY-MM-DD（本地口径，与 MealRecord.recordDate 一致）。 */
  date: string;
  /** 当日已填热量的记录求和；当日没有任何已填值时为 null（不是 0）。 */
  calories: number | null;
  /** 当日 calories 非 null 的记录数，用于区分「无数据」和「真 0」。 */
  recordedCaloriesCount: number;
}

export interface StatisticsCostSummary {
  /** 请求周期内所有 cost 非 null 记录的真实求和；无任何已填值时为 null。 */
  totalCost: number | null;
  takeoutCost: number | null;
  dineInCost: number | null;
  homemadeCost: number | null;
  /** 有效记录中成本非 null 的记录数（真 0 也计入）。 */
  pricedRecordCount: number;
  recordCount: number;
  takeoutRecordCount: number;
  dineInRecordCount: number;
  homemadeRecordCount: number;
  customRecordCount: number;
}

export type StatisticsSatietyCategory = 'LOW' | 'COMFORTABLE' | 'OVER';

export interface StatisticsSatietyBucket {
  /** 正式档位：3 / 5 / 7 / 8 / 10。 */
  satiety: number;
  count: number;
  category: StatisticsSatietyCategory;
}

export interface StatisticsSatietySummary {
  /** 分母：satiety 非 null 的有效记录数；为 0 时全部百分比为 null。 */
  recordedCount: number;
  /** 全部五个正式档位（未出现的档位 count 为真实 0，不伪造）。 */
  distribution: StatisticsSatietyBucket[];
  lowCount: number;
  comfortableCount: number;
  overCount: number;
  /** 百分比保留 1 位小数；recordedCount 为 0 时为 null。 */
  lowPercent: number | null;
  comfortablePercent: number | null;
  overPercent: number | null;
}

export interface StatisticsDto {
  period: { start: string; end: string };
  totalRecords: number;
  recordedDays: number;
  totalMeals: number;
  sourceBreakdown: Record<string, number>;
  mealTypeDistribution: Record<string, number>;
  newTryCount: number;
  favoriteCount: number;
  averageRating: number | null;
  topRecipes: Array<{ id: string; name: string; count: number }>;
  topStores: Array<{ id: string; name: string; count: number }>;
  trend: Array<{ date: string; count: number }>;
  ingredientConsumption: Array<{ ingredientId: string | null; name: string; quantity: number; unit: string }>;
  shoppingCompletionRate: number | null;
  /** 请求周期内逐日热量趋势（含无数据日 null）。 */
  calorieTrend: StatisticsCalorieTrendPoint[];
  costSummary: StatisticsCostSummary;
  /** 饱腹感达标分类：3/5 偏少、7/8 舒适、10 过饱。 */
  satietySummary: StatisticsSatietySummary;
}
