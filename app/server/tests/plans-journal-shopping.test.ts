import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { getCalendar } from '../src/modules/calendar/service.js';
import { completePlan, createPlan, updatePlan } from '../src/modules/meal-plans/service.js';
import { registerMealPlanRoutes } from '../src/modules/meal-plans/routes.js';
import { confirmRecord, createRecord, listRecords } from '../src/modules/meal-records/service.js';
import {
  addShoppingItem,
  createShoppingList,
  generateShoppingList,
  updateShoppingItem
} from '../src/modules/shopping/service.js';
import { getStatistics } from '../src/modules/statistics/service.js';

const database = createTestPrismaClient();

describe('节点 5 计划、日记、清单、日历和统计', () => {
  beforeAll(async () => {
    await database.$connect();
    const records = await database.mealRecord.findMany({
      where: { recordDate: { gte: '2040-01-01', lte: '2040-01-31' } },
      select: { id: true }
    });
    const recordIds = records.map(({ id }) => id);
    await database.mealRecordDiner.deleteMany({ where: { mealRecordId: { in: recordIds } } });
    await database.mealRecordItem.deleteMany({ where: { mealRecordId: { in: recordIds } } });
    await database.mealRecord.deleteMany({ where: { id: { in: recordIds } } });
    const plans = await database.mealPlan.findMany({
      where: { planDate: { gte: '2040-01-01', lte: '2040-01-31' } },
      select: { id: true }
    });
    const planIds = plans.map(({ id }) => id);
    await database.mealPlanDiner.deleteMany({ where: { mealPlanId: { in: planIds } } });
    await database.mealPlanItem.deleteMany({ where: { mealPlanId: { in: planIds } } });
    await database.mealPlan.deleteMany({ where: { id: { in: planIds } } });
    const lists = await database.shoppingList.findMany({
      where: { name: { startsWith: '节点5测试' } },
      select: { id: true }
    });
    const listIds = lists.map(({ id }) => id);
    await database.shoppingListItem.deleteMany({ where: { shoppingListId: { in: listIds } } });
    await database.shoppingList.deleteMany({ where: { id: { in: listIds } } });
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it('多项目计划完成后只生成一个 DRAFT 记录且重复完成幂等', async () => {
    const recipe = await database.recipe.create({ data: { name: '节点5计划菜谱' } });
    const plan = await createPlan(database, {
      planDate: '2040-01-02',
      mealType: 'DINNER',
      dinerCount: 2,
      items: [
        { itemType: 'RECIPE', recipeId: recipe.id, mealRole: 'MAIN' },
        { itemType: 'CUSTOM', customName: '米饭', mealRole: 'STAPLE' }
      ]
    });

    const first = await completePlan(database, plan.id, plan.version);
    const second = await completePlan(database, plan.id, first.plan.version);

    expect(first.record.status).toBe('DRAFT');
    expect(first.record.items).toHaveLength(2);
    expect(second.idempotent).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(await database.mealRecord.count({ where: { sourceMealPlanId: plan.id } })).toBe(1);
  });

  it('计划过期版本经 API 映射为 409', async () => {
    const plan = await createPlan(database, { planDate: '2040-01-03', mealType: 'LUNCH', dinerCount: 1 });
    await updatePlan(database, plan.id, plan.version, { notes: '新版本' });
    const app = Fastify({ logger: false });
    registerErrorHandlers(app);
    await registerMealPlanRoutes(app, database);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/plans/${plan.id}`,
      payload: { version: plan.version, notes: '旧设备覆盖' }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('VERSION_CONFLICT');
    await app.close();
  });

  it('记录支持草稿确认和组合筛选', async () => {
    const draft = await createRecord(database, {
      recordDate: '2040-01-04',
      mealType: 'BREAKFAST',
      sourceType: 'HOMEMADE',
      status: 'DRAFT',
      rating: 4.5,
      notes: '燕麦早餐',
      items: [{ itemType: 'CUSTOM', customName: '燕麦粥' }]
    });
    const confirmed = await confirmRecord(database, draft.id, draft.version);
    const records = await listRecords(database, {
      from: '2040-01-04',
      to: '2040-01-04',
      status: 'CONFIRMED',
      q: '燕麦'
    });

    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(records.items.map((record) => record.id)).toContain(draft.id);
  });

  it('同食材可换算单位合并，不可换算单位保持独立，父版本控制冲突', async () => {
    let list = await createShoppingList(database, {
      name: '节点5测试合并',
      items: [{ ingredientName: '大米', quantity: 1, unit: 'KILOGRAM' }]
    });
    list = await addShoppingItem(database, list.id, list.version, {
      ingredientName: '大米',
      quantity: 500,
      unit: 'GRAM'
    });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.quantity).toBe(1.5);
    list = await addShoppingItem(database, list.id, list.version, { ingredientName: '大米', quantity: 1, unit: 'BAG' });
    expect(list.items).toHaveLength(2);
    await expect(updateShoppingItem(database, list.items[0]!.id, 1, { completed: true })).rejects.toMatchObject({
      name: 'VersionConflictError'
    });
  });

  it('低库存生成清单并合并重复来源', async () => {
    const ingredient = await database.ingredient.create({
      data: { name: '节点5低库存鸡蛋', quantity: 1, minStock: 6, unit: 'PIECE' }
    });
    const list = await generateShoppingList(database, { name: '节点5测试低库存', mode: 'LOW_STOCK' });
    const generated = list.items.find((item) => item.ingredientId === ingredient.id);
    expect(generated?.quantity).toBe(5);
    expect(generated?.sourceType).toBe('LOW_STOCK');
  });

  it('日历同日保留计划和确认记录双标记，草稿单独标记', async () => {
    await createPlan(database, { planDate: '2040-01-05', mealType: 'DINNER', dinerCount: 1 });
    await createRecord(database, {
      recordDate: '2040-01-05',
      mealType: 'LUNCH',
      sourceType: 'DINE_IN',
      items: [{ itemType: 'CUSTOM', customName: '午饭' }]
    });
    await createRecord(database, {
      recordDate: '2040-01-05',
      mealType: 'BREAKFAST',
      sourceType: 'HOMEMADE',
      status: 'DRAFT',
      items: [{ itemType: 'CUSTOM', customName: '早餐' }]
    });
    const calendar = await getCalendar(database, { start: '2040-01-05', end: '2040-01-05' });

    expect(calendar.days[0]).toMatchObject({ hasPlans: true, hasRecords: true, hasDrafts: true });
  });

  it('统计只计算 CONFIRMED 记录', async () => {
    await createRecord(database, {
      recordDate: '2040-01-06',
      mealType: 'LUNCH',
      sourceType: 'TAKEOUT',
      status: 'CONFIRMED',
      rating: 5,
      isNewTry: true,
      items: [{ itemType: 'CUSTOM', customName: '确认餐' }]
    });
    await createRecord(database, {
      recordDate: '2040-01-06',
      mealType: 'DINNER',
      sourceType: 'TAKEOUT',
      status: 'DRAFT',
      rating: 1,
      items: [{ itemType: 'CUSTOM', customName: '草稿餐' }]
    });
    const stats = await getStatistics(database, { start: '2040-01-06', end: '2040-01-06' });

    expect(stats.totalRecords).toBe(1);
    expect(stats.averageRating).toBe(5);
    expect(stats.newTryCount).toBe(1);
  });
});
