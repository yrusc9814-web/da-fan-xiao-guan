import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerMealPlanRoutes } from '../src/modules/meal-plans/routes.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';
import { registerDeletedItemRoutes } from '../src/modules/deleted-items/routes.js';

const database = createTestPrismaClient();
const dates = { from: '2071-10-01', to: '2071-11-30' };

async function cleanup(): Promise<void> {
  const records = await database.mealRecord.findMany({
    where: { recordDate: { gte: dates.from, lte: dates.to } },
    select: { id: true }
  });
  const recordIds = records.map(({ id }) => id);
  await database.mealRecordDiner.deleteMany({ where: { mealRecordId: { in: recordIds } } });
  await database.mealRecordItem.deleteMany({ where: { mealRecordId: { in: recordIds } } });
  await database.consumptionOperation.deleteMany({ where: { mealRecordId: { in: recordIds } } });
  await database.deletedItem.deleteMany({ where: { entityType: 'MealRecord', entityId: { in: recordIds } } });
  await database.mealRecord.deleteMany({ where: { id: { in: recordIds } } });
  const plans = await database.mealPlan.findMany({
    where: { planDate: { gte: dates.from, lte: dates.to } },
    select: { id: true }
  });
  const planIds = plans.map(({ id }) => id);
  await database.mealPlanDiner.deleteMany({ where: { mealPlanId: { in: planIds } } });
  await database.mealPlanItem.deleteMany({ where: { mealPlanId: { in: planIds } } });
  await database.mealPlan.deleteMany({ where: { id: { in: planIds } } });
}

function appFor(): FastifyInstance {
  const app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
  registerErrorHandlers(app);
  void registerMealPlanRoutes(app, database);
  void registerMealRecordRoutes(app, database);
  void registerDeletedItemRoutes(app, database);
  return app;
}

async function createCompleted(app: FastifyInstance, date: string, customName: string) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/plans',
    payload: { planDate: date, mealType: 'DINNER', dinerCount: 1, items: [{ itemType: 'CUSTOM', customName }] }
  });
  expect(created.statusCode).toBe(201);
  const plan = created.json().data as { id: string; version: number };
  const completed = await app.inject({
    method: 'POST',
    url: `/api/v1/plans/${plan.id}/complete`,
    payload: { version: plan.version }
  });
  expect(completed.statusCode).toBe(200);
  return completed.json().data as { plan: { id: string; version: number }; record: { id: string; version: number } };
}

describe('Google2 草稿关联记录保护', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    await database.$connect();
    await cleanup();
    app = appFor();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await cleanup();
    await database.$disconnect();
  });

  it('用户编辑 DRAFT 后 uncomplete 返回 409，且计划、记录条目、回收站均不写入', async () => {
    const completed = await createCompleted(app, '2071-10-10', '自动草稿原名');
    const edited = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${completed.record.id}`,
      payload: { version: completed.record.version, recordDate: '2071-10-11', notes: '用户保留备注' }
    });
    expect(edited.statusCode).toBe(200);
    const beforePlan = await database.mealPlan.findUniqueOrThrow({ where: { id: completed.plan.id } });
    const beforeRecord = await database.mealRecord.findUniqueOrThrow({
      where: { id: completed.record.id },
      include: { items: true, diners: true }
    });
    const beforeDeleted = await database.deletedItem.count({
      where: { entityType: 'MealRecord', entityId: completed.record.id }
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: beforePlan.version }
    });
    expect(response.statusCode).toBe(409);
    const afterPlan = await database.mealPlan.findUniqueOrThrow({ where: { id: completed.plan.id } });
    const afterRecord = await database.mealRecord.findUniqueOrThrow({
      where: { id: completed.record.id },
      include: { items: true, diners: true }
    });
    expect(afterPlan).toEqual(beforePlan);
    expect(afterRecord).toEqual(beforeRecord);
    expect(
      await database.deletedItem.count({ where: { entityType: 'MealRecord', entityId: completed.record.id } })
    ).toBe(beforeDeleted);
  });

  it('自动草稿完成→撤销→再次完成可安全复活，软删除的用户编辑记录返回 409 且不覆盖', async () => {
    const safe = await createCompleted(app, '2071-10-20', '安全复活');
    const undone = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${safe.plan.id}/uncomplete`,
      payload: { version: safe.plan.version }
    });
    expect(undone.statusCode).toBe(200);
    const revived = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${safe.plan.id}/complete`,
      payload: { version: (undone.json().data as { plan: { version: number } }).plan.version }
    });
    expect(revived.statusCode).toBe(200);
    expect((revived.json().data as { record: { id: string } }).record.id).toBe(safe.record.id);
    expect((await database.mealRecord.findUniqueOrThrow({ where: { id: safe.record.id } })).deletedAt).toBeNull();

    const edited = await createCompleted(app, '2071-10-21', '软删除编辑');
    await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${edited.plan.id}/uncomplete`,
      payload: { version: edited.plan.version }
    });
    const record = await database.mealRecord.findUniqueOrThrow({ where: { id: edited.record.id } });
    await database.mealRecord.update({ where: { id: record.id }, data: { notes: '编辑后再软删' } });
    await database.mealRecord.update({ where: { id: record.id }, data: { deletedAt: new Date() } });
    const before = await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${edited.plan.id}/complete`,
      payload: { version: (await database.mealPlan.findUniqueOrThrow({ where: { id: edited.plan.id } })).version }
    });
    expect(response.statusCode).toBe(409);
    expect(await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } })).toEqual(before);
  });

  it.each([
    ['custom item only', { items: [{ itemType: 'CUSTOM', customName: '矩阵自定义菜' }] }],
    ['recordDate only', { recordDate: '2071-10-31' }],
    ['mealType only', { mealType: 'LUNCH' }],
    ['sourceType only', { sourceType: 'DINE_IN' }],
    ['diner links only', { dinerIds: [] }]
  ])('记录字段 %s 编辑后 uncomplete 返回 409 且不写入', async (_name, patch) => {
    const completed = await createCompleted(
      app,
      `2071-10-${String(25 + ['custom item only', 'recordDate only', 'mealType only', 'sourceType only', 'diner links only'].indexOf(_name)).padStart(2, '0')}`,
      `矩阵-${_name}`
    );
    const beforeRecord = await database.mealRecord.findUniqueOrThrow({
      where: { id: completed.record.id },
      include: { items: true, diners: true }
    });
    const recordPatch: Record<string, unknown> =
      _name === 'diner links only'
        ? {
            dinerIds: [
              (
                await database.diner.create({
                  data: { id: `matrix-diner-${completed.record.id}`, name: `矩阵食客-${completed.record.id}` }
                })
              ).id
            ]
          }
        : patch;
    const update = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${completed.record.id}`,
      payload: {
        ...recordPatch,
        version: beforeRecord.version,
        recordDate: recordPatch.recordDate ?? beforeRecord.recordDate,
        mealType: recordPatch.mealType ?? beforeRecord.mealType,
        sourceType: recordPatch.sourceType ?? beforeRecord.sourceType
      }
    });
    expect(update.statusCode).toBe(200);
    const beforePlan = await database.mealPlan.findUniqueOrThrow({ where: { id: completed.plan.id } });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: beforePlan.version }
    });
    expect(response.statusCode).toBe(409);
    expect((response.json().error as { code: string }).code).toBe('CONFLICT');
    expect(
      await database.deletedItem.count({ where: { entityType: 'MealRecord', entityId: completed.record.id } })
    ).toBe(0);
  });

  it('手工 DELETE 后 restore 再编辑再 DELETE：真实归档链路无证明时 re-complete 返回 409 且不写覆盖', async () => {
    const completed = await createCompleted(app, '2071-11-20', '手工软删');
    const undone = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: completed.plan.version }
    });
    expect(undone.statusCode).toBe(200);
    const record = await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } });
    const firstDeleted = await database.deletedItem.findUniqueOrThrow({
      where: { entityType_entityId: { entityType: 'MealRecord', entityId: record.id } }
    });
    const restored = await app.inject({ method: 'POST', url: `/api/v1/deleted-items/${firstDeleted.id}/restore` });
    expect(restored.statusCode).toBe(200);
    const restoredRecord = await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } });
    const edited = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${record.id}`,
      payload: { version: restoredRecord.version, notes: '恢复后人工编辑' }
    });
    expect(edited.statusCode).toBe(200);
    const editedRecord = await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/records/${record.id}?version=${editedRecord.version}`
    });
    expect(deleted.statusCode).toBe(200);
    const plan = await database.mealPlan.findUniqueOrThrow({ where: { id: completed.plan.id } });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/complete`,
      payload: { version: plan.version }
    });
    expect(response.statusCode).toBe(409);
    expect((response.json().error as { code: string }).code).toBe('CONFLICT');
    expect(await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({
      deletedAt: expect.any(Date),
      notes: '恢复后人工编辑'
    });
  });

  it('软删除记录的真实消费历史（InventoryLog 与 ConsumptionOperation）分别阻止 re-complete', async () => {
    for (const [date, kind] of [
      ['2071-11-21', 'inventory'],
      ['2071-11-22', 'operation']
    ] as const) {
      const completed = await createCompleted(app, date, `消费历史-${kind}`);
      const undone = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
        payload: { version: completed.plan.version }
      });
      expect(undone.statusCode).toBe(200);
      const record = await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } });
      if (kind === 'inventory') {
        const ingredient = await database.ingredient.create({
          data: { name: `矩阵食材-${date}`, unit: 'GRAM', quantity: 100 }
        });
        await database.inventoryLog.create({
          data: {
            ingredientId: ingredient.id,
            ingredientNameSnapshot: ingredient.name,
            beforeQuantity: 100,
            changeQuantity: -10,
            afterQuantity: 90,
            unit: 'GRAM',
            changeType: 'COOK_DEDUCT',
            relatedRecordId: record.id
          }
        });
      } else {
        await database.consumptionOperation.create({
          data: {
            id: `matrix-operation-${date}`,
            mealRecordId: record.id,
            previewHash: `matrix-${date}`,
            resultJson: '{}'
          }
        });
      }
      const plan = await database.mealPlan.findUniqueOrThrow({ where: { id: completed.plan.id } });
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${completed.plan.id}/complete`,
        payload: { version: plan.version }
      });
      expect(response.statusCode).toBe(409);
      expect((response.json().error as { code: string }).code).toBe('CONFLICT');
      expect(await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({
        deletedAt: record.deletedAt
      });
    }
  });

  it('CONFIRMED 软删除记录 re-complete 返回 409 且不写入', async () => {
    const completed = await createCompleted(app, '2071-11-23', '确认软删');
    const undone = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: completed.plan.version }
    });
    expect(undone.statusCode).toBe(200);
    await database.mealRecord.update({
      where: { id: completed.record.id },
      data: { status: 'CONFIRMED', confirmedAt: new Date(), version: { increment: 1 } }
    });
    const before = await database.mealRecord.findUniqueOrThrow({
      where: { id: completed.record.id },
      include: { items: true, diners: true }
    });
    const plan = await database.mealPlan.findUniqueOrThrow({ where: { id: completed.plan.id } });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/complete`,
      payload: { version: plan.version }
    });
    expect(response.statusCode).toBe(409);
    expect(
      await database.mealRecord.findUniqueOrThrow({
        where: { id: completed.record.id },
        include: { items: true, diners: true }
      })
    ).toEqual(before);
  });

  it.each(['STORE', 'RECIPE'] as const)(
    '正常 undo 后修改 %s 计划再 complete：合法来源切换复活同一记录',
    async (itemType) => {
      const recipe = await database.recipe.create({ data: { name: `矩阵复活菜谱-${itemType}`, servings: 1 } });
      const store = await database.store.create({ data: { name: `矩阵复活店铺-${itemType}` } });
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/plans',
        payload: {
          planDate: itemType === 'STORE' ? '2071-11-26' : '2071-11-27',
          mealType: 'DINNER',
          dinerCount: 1,
          items: [
            itemType === 'STORE'
              ? { itemType, storeId: store?.id, sortOrder: 0 }
              : { itemType, recipeId: recipe?.id, mealRole: 'MAIN', sortOrder: 0 }
          ]
        }
      });
      expect(created.statusCode).toBe(201);
      const initialPlan = created.json().data as { id: string; version: number };
      const first = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${initialPlan.id}/complete`,
        payload: { version: initialPlan.version }
      });
      expect(first.statusCode).toBe(200);
      const firstData = first.json().data as { plan: { version: number }; record: { id: string } };
      const undone = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${initialPlan.id}/uncomplete`,
        payload: { version: firstData.plan.version }
      });
      expect(undone.statusCode).toBe(200);
      const plan = await database.mealPlan.findUniqueOrThrow({ where: { id: initialPlan.id } });
      const second = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${initialPlan.id}/complete`,
        payload: { version: plan.version }
      });
      expect(second.statusCode).toBe(200);
      const secondData = second.json().data as { record: { id: string; sourceType: string; items: unknown[] } };
      expect(secondData.record.id).toBe(firstData.record.id);
      expect(secondData.record.sourceType).toBe(itemType === 'STORE' ? 'DINE_IN' : 'HOMEMADE');
      expect(secondData.record.items).toHaveLength(1);
    }
  );

  it('正常 undo 后修改 plan items/diners/date 再 complete：当前计划刷新自动草稿，闭环成功', async () => {
    const completed = await createCompleted(app, '2071-11-24', '刷新前');
    const undone = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: completed.plan.version }
    });
    expect(undone.statusCode).toBe(200);
    const diner = await database.diner.create({
      data: { id: `matrix-diner-20711124-${Date.now()}`, name: `矩阵食客-${Date.now()}` }
    });
    const plan = await database.mealPlan.findUniqueOrThrow({ where: { id: completed.plan.id } });
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/plans/${completed.plan.id}`,
      payload: {
        version: plan.version,
        planDate: '2071-11-25',
        dinerIds: [diner.id],
        items: [{ itemType: 'CUSTOM', customName: '刷新后' }]
      }
    });
    expect(updated.statusCode).toBe(200);
    const nextPlan = await database.mealPlan.findUniqueOrThrow({ where: { id: completed.plan.id } });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/complete`,
      payload: { version: nextPlan.version }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json().data as {
      record: {
        id: string;
        recordDate: string;
        items: Array<{ customName: string | null }>;
        diners: Array<{ dinerId: string }>;
      };
    };
    expect(body.record.id).toBe(completed.record.id);
    expect(body.record.recordDate).toBe('2071-11-25');
    expect(body.record.items[0]?.customName).toBe('刷新后');
    expect(body.record.diners[0]?.dinerId).toBe(diner.id);
  });
});
