import type { PrismaClient } from '@prisma/client';

function businessDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function defaultRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return { start: businessDate(start), end: businessDate(now) };
}

export async function getStatistics(database: PrismaClient, query: { start?: string; end?: string; dinerId?: string }) {
  const fallback = defaultRange();
  const start = query.start ?? fallback.start;
  const end = query.end ?? fallback.end;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    throw Object.assign(new Error('统计起止日期无效'), { statusCode: 400 });
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
    database.inventoryLog.findMany({ where: { changeType: 'COOK_DEDUCT', createdAt: { gte: new Date(`${start}T00:00:00`), lte: new Date(`${end}T23:59:59.999`) } } }),
    database.shoppingListItem.findMany({ where: { shoppingList: { deletedAt: null }, createdAt: { gte: new Date(`${start}T00:00:00`), lte: new Date(`${end}T23:59:59.999`) } }, select: { completed: true } })
  ]);

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
  const rank = (values: Map<string, { id: string; name: string; count: number }>) => [...values.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 10);
  const consumedByIngredient: Record<string, { ingredientId: string | null; name: string; quantity: number; unit: string }> = {};
  for (const log of consumptionLogs) {
    const key = `${log.ingredientId ?? log.ingredientNameSnapshot}:${log.unit}`;
    const value = consumedByIngredient[key] ?? { ingredientId: log.ingredientId, name: log.ingredientNameSnapshot, quantity: 0, unit: log.unit };
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
    averageRating: rated.length ? Number((rated.reduce((sum, record) => sum + (record.rating ?? 0), 0) / rated.length).toFixed(2)) : null,
    topRecipes: rank(recipes),
    topStores: rank(stores),
    trend: Object.entries(trend).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
    ingredientConsumption: Object.values(consumedByIngredient),
    shoppingCompletionRate: shoppingItems.length ? shoppingItems.filter((item) => item.completed).length / shoppingItems.length : null
  };
}
