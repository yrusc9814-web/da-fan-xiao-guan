import type { PrismaClient } from '@prisma/client';

import { isValidBusinessDate } from './business-date.js';

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

export async function getCalendar(database: PrismaClient, query: { start: string; end: string }) {
  // 形状 + 真实日历日期：2026-02-31 / 平年 02-29 / 2026-13-01 一律 400，
  // 不允许 rollover，也不允许用空结果掩盖调用方错误。
  if (!isValidBusinessDate(query.start) || !isValidBusinessDate(query.end)) {
    throw httpError(400, '日历起止日期无效：必须是真实存在的 YYYY-MM-DD 日期');
  }
  if (query.start > query.end) {
    throw httpError(400, '日历起止日期无效：开始日期不能晚于结束日期');
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
  const dayMap = new Map<
    string,
    {
      date: string;
      hasPlans: boolean;
      hasRecords: boolean;
      hasDrafts: boolean;
      plans: typeof plans;
      records: typeof records;
    }
  >();
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
  return {
    start: query.start,
    end: query.end,
    days: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  };
}
