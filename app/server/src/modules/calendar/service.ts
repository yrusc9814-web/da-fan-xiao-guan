import type { PrismaClient } from '@prisma/client';

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

export async function getCalendar(database: PrismaClient, query: { start: string; end: string }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.start) || !/^\d{4}-\d{2}-\d{2}$/.test(query.end) || query.start > query.end) {
    throw httpError(400, '日历起止日期无效');
  }
  const [plans, records] = await Promise.all([
    database.mealPlan.findMany({
      where: { deletedAt: null, planDate: { gte: query.start, lte: query.end } },
      select: { id: true, planDate: true, mealType: true, status: true, dinerCount: true, version: true },
      orderBy: [{ planDate: 'asc' }, { mealType: 'asc' }]
    }),
    database.mealRecord.findMany({
      where: { deletedAt: null, recordDate: { gte: query.start, lte: query.end } },
      select: { id: true, recordDate: true, mealType: true, status: true, rating: true, version: true },
      orderBy: [{ recordDate: 'asc' }, { mealType: 'asc' }]
    })
  ]);
  const dayMap = new Map<string, { date: string; hasPlans: boolean; hasRecords: boolean; hasDrafts: boolean; plans: typeof plans; records: typeof records }>();
  const day = (date: string) => {
    let value = dayMap.get(date);
    if (!value) {
      value = { date, hasPlans: false, hasRecords: false, hasDrafts: false, plans: [], records: [] };
      dayMap.set(date, value);
    }
    return value;
  };
  for (const plan of plans) {
    const value = day(plan.planDate);
    value.hasPlans = true;
    value.plans.push(plan);
  }
  for (const record of records) {
    const value = day(record.recordDate);
    value.hasRecords ||= record.status === 'CONFIRMED';
    value.hasDrafts ||= record.status === 'DRAFT';
    value.records.push(record);
  }
  return { start: query.start, end: query.end, days: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}
