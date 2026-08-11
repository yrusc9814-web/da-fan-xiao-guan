import type { PrismaClient } from '@prisma/client';

import type { DashboardCalendarDay, DashboardDto, DashboardMealSlot } from '../../../../shared/types/dashboard.js';

const mealSlots: Array<{ mealType: DashboardMealSlot['mealType']; label: string }> = [
  { mealType: 'BREAKFAST', label: '早餐' },
  { mealType: 'LUNCH', label: '午餐' },
  { mealType: 'DINNER', label: '晚餐' }
];

const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六'];

function toBusinessDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfWeek(date: Date): Date {
  const start = new Date(date);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

function getGreetingPeriod(hour: number): DashboardDto['greetingPeriod'] {
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

function getGreetingText(period: DashboardDto['greetingPeriod']): string {
  switch (period) {
    case 'morning':
      return '今天也要好好吃饭呀～';
    case 'afternoon':
      return '忙碌之中，也别忘了好好吃饭～';
    default:
      return '辛苦啦，给今天准备一顿温柔的晚餐吧～';
  }
}

function toCalendarDays(
  currentDate: Date,
  recordedDates: Set<string>,
  plannedDates: Set<string>
): DashboardCalendarDay[] {
  const weekStart = startOfWeek(currentDate);

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + index);
    const businessDate = toBusinessDate(date);
    const status = recordedDates.has(businessDate) ? 'recorded' : plannedDates.has(businessDate) ? 'planned' : 'empty';

    return {
      date: businessDate,
      weekday: weekdayLabels[date.getDay()] ?? '',
      dayOfMonth: date.getDate(),
      isToday: businessDate === toBusinessDate(currentDate),
      status
    };
  });
}

export async function getDashboard(database: PrismaClient): Promise<DashboardDto> {
  const now = new Date();
  const currentDate = toBusinessDate(now);
  const period = getGreetingPeriod(now.getHours());
  const weekStart = startOfWeek(now);
  const weekStartDate = toBusinessDate(weekStart);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);
  const weekEndDate = toBusinessDate(weekEnd);

  const [settings, recipes, todayRecords, weekRecords, plannedDays, ingredients, consumedLogs] = await Promise.all([
    database.settings.findUnique({ where: { id: 1 } }),
    database.recipe.findMany({
      where: { deletedAt: null, enabledForRecommendation: true },
      orderBy: { createdAt: 'asc' },
      take: 6,
      include: {
        tags: { include: { tag: true } },
        recordItems: {
          where: { mealRecord: { status: 'CONFIRMED', deletedAt: null } },
          include: {
            mealRecord: { select: { rating: true, deletedAt: true } }
          }
        }
      }
    }),
    database.mealRecord.findMany({
      where: { recordDate: currentDate, status: 'CONFIRMED', deletedAt: null },
      orderBy: { mealType: 'asc' },
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
          take: 1,
          include: { recipe: true, store: true }
        }
      }
    }),
    database.mealRecord.findMany({
      where: { recordDate: { gte: weekStartDate, lte: weekEndDate }, status: 'CONFIRMED', deletedAt: null },
      select: { recordDate: true, rating: true }
    }),
    database.mealPlan.findMany({
      where: {
        planDate: { gte: weekStartDate, lte: weekEndDate },
        status: { in: ['PLANNED', 'COMPLETED'] },
        deletedAt: null
      },
      select: { planDate: true }
    }),
    database.ingredient.findMany({ where: { deletedAt: null }, orderBy: { expiryDate: 'asc' } }),
    database.inventoryLog.count({
      where: { createdAt: { gte: weekStart, lte: weekEnd }, changeType: 'COOK_DEDUCT' }
    })
  ]);

  const expiringLimit = new Date(now);
  expiringLimit.setDate(expiringLimit.getDate() + 3);
  const expiringLimitDate = toBusinessDate(expiringLimit);
  const expiringIngredients = ingredients
    .filter((ingredient) =>
      Boolean(
        ingredient.expiryDate && ingredient.expiryDate >= currentDate && ingredient.expiryDate <= expiringLimitDate
      )
    )
    .slice(0, 5)
    .map((ingredient) => ({
      id: ingredient.id,
      name: ingredient.name,
      expiryDate: ingredient.expiryDate,
      quantity: ingredient.quantity,
      unit: ingredient.unit
    }));
  const insufficient = ingredients.filter(
    (ingredient) => ingredient.minStock !== null && ingredient.quantity < ingredient.minStock
  ).length;

  const todayRecordMap = new Map(todayRecords.map((record) => [record.mealType, record]));
  const dashboardRecords = mealSlots.map(({ mealType, label }) => {
    const record = todayRecordMap.get(mealType);
    const item = record?.items[0];
    const title = item?.customName ?? item?.recipe?.name ?? item?.store?.name ?? null;

    return {
      mealType,
      label,
      time: record?.recordTime ?? null,
      recorded: Boolean(record),
      title,
      summary: record ? (record.sourceType === 'HOMEMADE' ? '在家制作' : '外出用餐') : null,
      rating: record?.rating ?? null
    } satisfies DashboardMealSlot;
  });

  const ratedRecords = weekRecords.filter((record) => record.rating !== null);
  const recordedDates = new Set(weekRecords.map((record) => record.recordDate));
  const plannedDateSet = new Set(plannedDays.map((plan) => plan.planDate));
  const averageRating =
    ratedRecords.length > 0
      ? Number((ratedRecords.reduce((sum, record) => sum + (record.rating ?? 0), 0) / ratedRecords.length).toFixed(1))
      : null;

  return {
    generatedAt: new Date().toISOString(),
    branding: {
      appName: settings?.appName ?? '搭饭小馆',
      subtitle: settings?.subtitle ?? '让每一餐都更美好'
    },
    userNickname: settings?.userNickname ?? null,
    currentDate,
    greetingPeriod: period,
    greetingText: getGreetingText(period),
    recommendedRecipes: recipes.map((recipe) => {
      const ratings = recipe.recordItems
        .filter((item) => item.mealRecord.deletedAt === null)
        .map((item) => item.mealRecord.rating)
        .filter((rating): rating is number => rating !== null);
      const rating =
        ratings.length > 0
          ? Number((ratings.reduce((sum, value) => sum + value, 0) / ratings.length).toFixed(1))
          : null;

      return {
        id: recipe.id,
        name: recipe.name,
        imagePath: recipe.imagePath,
        cookingTimeMinutes: recipe.cookingTimeMinutes,
        tags: recipe.tags.map(({ tag }) => tag.name),
        rating
      };
    }),
    todayRecords: dashboardRecords,
    inventory: {
      totalIngredients: ingredients.length,
      expiringSoon: expiringIngredients.length,
      insufficient,
      expiringIngredients
    },
    weeklyStats: {
      recordedDays: recordedDates.size,
      totalMeals: weekRecords.length,
      averageRating,
      consumedIngredientCount: consumedLogs
    },
    calendarDays: toCalendarDays(now, recordedDates, plannedDateSet),
    tip:
      expiringIngredients.length > 0
        ? '优先消耗即将到期的食材，让每一份新鲜都不被浪费。'
        : '记得记录今天吃过的每一餐，慢慢找到适合自己的节奏。'
  };
}
