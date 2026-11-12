import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerMealPlanRoutes } from '../src/modules/meal-plans/routes.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';

// 完成计划撤销能力（POST /api/v1/plans/:id/uncomplete）：
// - 成功：COMPLETED → PLANNED、completedAt 清理、乐观锁 version 递增；
// - 自动生成的 DRAFT 关联记录按 repo soft-delete（deletedAt + DeletedItem 回收站）清理；
// - 再次 complete 可复活并刷新关联记录，sourceMealPlanId 唯一约束不冲突；
// - 已 CONFIRMED / 有库存消费历史的记录绝不被撤销，返回 409；
// - 重复 uncomplete 幂等安全（不写入、idempotent=true）；
// - 全程不触碰库存（InventoryLog 不新增、批次数量不变）；
// - 撤销不影响已完成计划的标题/关系（VAN40：recipe/store 关系不丢）。
const database = createTestPrismaClient();

const planDate = '2043-07-20';
const planDateRange = { from: '2043-07-20', to: '2043-07-31' };

async function cleanupRange(): Promise<void> {
  const records = await database.mealRecord.findMany({
    where: { recordDate: { gte: planDateRange.from, lte: planDateRange.to } },
    select: { id: true }
  });
  const recordIds = records.map(({ id }) => id);
  await database.mealRecordDiner.deleteMany({ where: { mealRecordId: { in: recordIds } } });
  await database.mealRecordItem.deleteMany({ where: { mealRecordId: { in: recordIds } } });
  await database.mealRecord.deleteMany({ where: { id: { in: recordIds } } });
  const plans = await database.mealPlan.findMany({
    where: { planDate: { gte: planDateRange.from, lte: planDateRange.to } },
    select: { id: true }
  });
  const planIds = plans.map(({ id }) => id);
  await database.mealPlanDiner.deleteMany({ where: { mealPlanId: { in: planIds } } });
  await database.mealPlanItem.deleteMany({ where: { mealPlanId: { in: planIds } } });
  // 只清理本测试范围内的回收站登记，绝不整体清空 DeletedItem
  if (recordIds.length)
    await database.deletedItem.deleteMany({ where: { entityType: 'MealRecord', entityId: { in: recordIds } } });
  await database.mealPlan.deleteMany({ where: { id: { in: planIds } } });
}

function createApp(): FastifyInstance {
  const app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
  registerErrorHandlers(app);
  void registerMealPlanRoutes(app, database);
  void registerMealRecordRoutes(app, database);
  return app;
}

type UncompleteResponse = {
  success: boolean;
  data: {
    plan: { id: string; status: string; version: number; completedAt: string | null };
    removedRecord: { id: string } | null;
    idempotent: boolean;
  };
};

describe('完成计划撤销能力（POST /plans/:id/uncomplete）', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await database.$connect();
    await cleanupRange();
    app = createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await cleanupRange();
    await database.$disconnect();
  });

  async function createCompletePlan(date: string, mealType: 'BREAKFAST' | 'LUNCH' | 'DINNER', customName: string) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      payload: { planDate: date, mealType, dinerCount: 1, items: [{ itemType: 'CUSTOM', customName }] }
    });
    expect(created.statusCode).toBe(201);
    const plan = created.json().data as { id: string; version: number };
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/complete`,
      payload: { version: plan.version }
    });
    expect(completed.statusCode).toBe(200);
    return completed.json().data as {
      plan: { id: string; version: number };
      record: { id: string; status: string; items: Array<{ customName: string | null }> };
    };
  }

  it('成功撤销：COMPLETED → PLANNED、completedAt 清理、DRAFT 记录进回收站、version 递增', async () => {
    const completed = await createCompletePlan(planDate, 'DINNER', '撤销测试晚餐');
    const record = await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } });
    expect(record.status).toBe('DRAFT');
    expect(record.deletedAt).toBeNull();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: completed.plan.version }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<UncompleteResponse>();
    expect(body.success).toBe(true);
    expect(body.data.plan.status).toBe('PLANNED');
    expect(body.data.plan.completedAt).toBeNull();
    expect(body.data.plan.version).toBe(completed.plan.version + 1);
    expect(body.data.idempotent).toBe(false);
    expect(body.data.removedRecord?.id).toBe(completed.record.id);

    // 自动记录 soft delete：DeletionItem 回收站登记 + deletedAt 落库，数据不物理销毁
    const recordAfter = await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } });
    expect(recordAfter.deletedAt).not.toBeNull();
    const recycle = await database.deletedItem.findFirst({
      where: { entityType: 'MealRecord', entityId: completed.record.id }
    });
    expect(recycle).not.toBeNull();
    expect(recycle?.expiresAt?.getTime()).toBeGreaterThan(Date.now());

    // 已完成计划已回到未完成：GET 单一计划可见新状态
    const fetched = await app.inject({ method: 'GET', url: `/api/v1/plans/${completed.plan.id}` });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json().data as { status: string }).status).toBe('PLANNED');
  });

  it('乐观锁：过期 version 返回 409 VERSION_CONFLICT，且不产生任何写入', async () => {
    const completed = await createCompletePlan('2043-07-21', 'LUNCH', '乐观锁测试午餐');
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: completed.plan.version - 1 }
    });
    expect(stale.statusCode).toBe(409);
    const error = stale.json().error as { code: string; details?: { expectedVersion?: number } };
    expect(error.code).toBe('VERSION_CONFLICT');
    expect(error.details?.expectedVersion).toBe(completed.plan.version - 1);

    const planAfter = await database.mealPlan.findUniqueOrThrow({ where: { id: completed.plan.id } });
    expect(planAfter.status).toBe('COMPLETED');
    expect(planAfter.version).toBe(completed.plan.version);
    const recordAfter = await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } });
    expect(recordAfter.deletedAt).toBeNull();
  });

  it('确认记录保护：关联记录已 CONFIRMED 时返回 409，不删记录、不撤销计划、不回滚库存', async () => {
    const completed = await createCompletePlan('2043-07-22', 'DINNER', '保护测试晚餐');
    // 模拟用户把草稿确认为正式记录（consumption 链路只改状态，不动 sourceMealPlanId）
    await database.mealRecord.update({
      where: { id: completed.record.id },
      data: { status: 'CONFIRMED', confirmedAt: new Date(), version: { increment: 1 } }
    });
    const inventoryLogsBefore = await database.inventoryLog.count();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: completed.plan.version }
    });
    expect(response.statusCode).toBe(409);
    expect((response.json().error as { code: string }).code).toBe('CONFLICT');

    const planAfter = await database.mealPlan.findUniqueOrThrow({ where: { id: completed.plan.id } });
    expect(planAfter.status).toBe('COMPLETED');
    const recordAfter = await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } });
    expect(recordAfter.status).toBe('CONFIRMED');
    expect(recordAfter.deletedAt).toBeNull();
    expect(await database.inventoryLog.count()).toBe(inventoryLogsBefore);
  });

  it('消费历史保护：记录存在 InventoryLog 关联时返回 409，绝不擅自回滚库存', async () => {
    const completed = await createCompletePlan('2043-07-23', 'LUNCH', '消费历史测试');
    const ingredient = await database.ingredient.create({
      data: { name: '撤销测试洋葱', unit: 'GRAM', quantity: 200 }
    });

    // 直接构造消费历史（本测试只验证保护判定，不铺开 consumption 全链路）
    const log = await database.inventoryLog.create({
      data: {
        ingredientId: ingredient.id,
        ingredientNameSnapshot: ingredient.name,
        beforeQuantity: 200,
        changeQuantity: -50,
        afterQuantity: 150,
        unit: 'GRAM',
        changeType: 'COOK_DEDUCT',
        relatedRecordId: completed.record.id
      }
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: completed.plan.version }
    });
    expect(response.statusCode).toBe(409);
    expect((response.json().error as { code: string }).code).toBe('CONFLICT');

    const planAfter = await database.mealPlan.findUniqueOrThrow({ where: { id: completed.plan.id } });
    expect(planAfter.status).toBe('COMPLETED');
    const recordAfter = await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } });
    expect(recordAfter.deletedAt).toBeNull();
    // 库存日志与批次数量均未变化
    expect(await database.inventoryLog.count({ where: { id: log.id } })).toBe(1);
    const ingredientAfter = await database.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } });
    expect(ingredientAfter.quantity).toBe(200);

    await database.inventoryLog.delete({ where: { id: log.id } });
    await database.ingredient.delete({ where: { id: ingredient.id } });
  });

  it('重复请求：对已撤销（PLANNED）计划再次 uncomplete 幂等返回，不递增 version、不二次写回收站', async () => {
    const completed = await createCompletePlan('2043-07-24', 'BREAKFAST', '幂等测试早餐');
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: completed.plan.version }
    });
    expect(first.statusCode).toBe(200);
    const afterFirst = first.json<UncompleteResponse>();

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: afterFirst.data.plan.version }
    });
    expect(second.statusCode).toBe(200);
    const afterSecond = second.json<UncompleteResponse>();
    expect(afterSecond.data.idempotent).toBe(true);
    expect(afterSecond.data.plan.status).toBe('PLANNED');
    expect(afterSecond.data.plan.version).toBe(afterFirst.data.plan.version);
    expect(afterSecond.data.removedRecord).toBeNull();
    expect(
      await database.deletedItem.count({ where: { entityType: 'MealRecord', entityId: completed.record.id } })
    ).toBe(1);
  });

  it('闭环：完成 → 撤销 → 再次完成，复活关联记录且 sourceMealPlanId 唯一不冲突、关系刷新正确', async () => {
    const recipe = await database.recipe.create({ data: { name: '撤销闭环测试番茄炒蛋', servings: 1 } });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      payload: {
        planDate: '2043-07-25',
        mealType: 'DINNER',
        dinerCount: 1,
        items: [{ itemType: 'RECIPE', recipeId: recipe.id, mealRole: 'MAIN', sortOrder: 0 }]
      }
    });
    expect(created.statusCode).toBe(201);
    const planId = (created.json().data as { id: string }).id;
    let planVersion = (created.json().data as { version: number }).version;

    const firstComplete = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${planId}/complete`,
      payload: { version: planVersion }
    });
    expect(firstComplete.statusCode).toBe(200);
    const firstRecordId = (firstComplete.json().data as { record: { id: string } }).record.id;
    const planAfterComplete = await database.mealPlan.findUniqueOrThrow({ where: { id: planId } });
    planVersion = planAfterComplete.version;

    const undo = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${planId}/uncomplete`,
      payload: { version: planVersion }
    });
    expect(undo.statusCode).toBe(200);
    planVersion = (undo.json().data as { plan: { version: number } }).plan.version;

    // 计划项目内容变化后再完成，复活记录必须按“当前”关联正确生成
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/plans/${planId}`,
      payload: {
        version: planVersion,
        items: [
          { itemType: 'RECIPE', recipeId: recipe.id, mealRole: 'MAIN', sortOrder: 0 },
          { itemType: 'CUSTOM', customName: '闭环测试米饭', mealRole: 'STAPLE', sortOrder: 1 }
        ]
      }
    });
    expect(updated.statusCode).toBe(200);
    planVersion = (updated.json().data as { version: number }).version;

    const reComplete = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${planId}/complete`,
      payload: { version: planVersion }
    });
    expect(reComplete.statusCode).toBe(200);
    const secondData = reComplete.json().data as {
      plan: { status: string };
      record: {
        id: string;
        status: string;
        deletedAt?: null;
        sourceMealPlanId?: string;
        items: Array<{
          itemType: string;
          customName: string | null;
          recipe: { name: string } | null;
        }>;
      };
      idempotent: boolean;
    };
    expect(secondData.idempotent).toBe(false);
    expect(secondData.plan.status).toBe('COMPLETED');
    // sourceMealPlanId 唯一约束下复用同一条记录，而非抛 unique 冲突
    expect(secondData.record.id).toBe(firstRecordId);
    expect(secondData.record.status).toBe('DRAFT');
    expect(secondData.record.items).toHaveLength(2);
    expect(secondData.record.items[0]?.recipe?.name).toBe('撤销闭环测试番茄炒蛋');
    expect(secondData.record.items[1]?.customName).toBe('闭环测试米饭');

    const persisted = await database.mealRecord.findUniqueOrThrow({ where: { id: firstRecordId } });
    expect(persisted.deletedAt).toBeNull();
    expect(persisted.sourceMealPlanId).toBe(planId);
    expect(persisted.version).toBeGreaterThan(1);
    expect(await database.deletedItem.count({ where: { entityType: 'MealRecord', entityId: firstRecordId } })).toBe(0);
    // 再次完成不做库存扣减（保持 Direct Completion 语义）
    expect(await database.inventoryLog.count({ where: { relatedRecordId: firstRecordId } })).toBe(0);

    await database.mealRecordDiner.deleteMany({ where: { mealRecordId: firstRecordId } });
    await database.mealRecordItem.deleteMany({ where: { mealRecordId: firstRecordId } });
    await database.mealRecord.delete({ where: { id: firstRecordId } });
    await database.mealPlanDiner.deleteMany({ where: { mealPlanId: planId } });
    await database.mealPlanItem.deleteMany({ where: { mealPlanId: planId } });
    await database.mealPlan.delete({ where: { id: planId } });
    await database.recipe.delete({ where: { id: recipe.id } });
  });

  it('输入校验：未知字段与非法 version 400 快速失败，幂等请求体必须 exactly version', async () => {
    const completed = await createCompletePlan('2043-07-26', 'BREAKFAST', '校验测试早餐');

    const unknownField = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: completed.plan.version, confirm: true }
    });
    expect(unknownField.statusCode).toBe(400);

    const stringVersion = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: '1' }
    });
    expect(stringVersion.statusCode).toBe(400);
    expect((stringVersion.json().error as { code: string }).code).toBe('VALIDATION_ERROR');

    const zeroVersion = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: { version: 0 }
    });
    expect(zeroVersion.statusCode).toBe(400);

    const missingVersion = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${completed.plan.id}/uncomplete`,
      payload: {}
    });
    expect(missingVersion.statusCode).toBe(400);

    // 全部非法请求不产生任何写入
    const planAfter = await database.mealPlan.findUniqueOrThrow({ where: { id: completed.plan.id } });
    expect(planAfter.status).toBe('COMPLETED');
    expect(planAfter.version).toBe(completed.plan.version);
  });

  it('撤销不改写已完成计划 relations/标题能力：record 关系在撤销前保持完整（VAN40 不丢）', async () => {
    const store = await database.store.create({ data: { name: '撤销测试好味面馆' } });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      payload: {
        planDate: '2043-07-27',
        mealType: 'LUNCH',
        dinerCount: 1,
        items: [
          { itemType: 'STORE', storeId: store.id, mealRole: null, sortOrder: 1 },
          { itemType: 'CUSTOM', customName: '撤销测试小菜', mealRole: 'SIDE', sortOrder: 0 }
        ]
      }
    });
    expect(created.statusCode).toBe(201);
    const planId = (created.json().data as { id: string }).id;
    const planVersion = (created.json().data as { version: number }).version;

    const complete = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${planId}/complete`,
      payload: { version: planVersion }
    });
    expect(complete.statusCode).toBe(200);
    const record = (complete.json().data as { record: { id: string } }).record;

    const planAfterComplete = await database.mealPlan.findUniqueOrThrow({ where: { id: planId } });
    const undo = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${planId}/uncomplete`,
      payload: { version: planAfterComplete.version }
    });
    expect(undo.statusCode).toBe(200);

    // 计划项目（含 store 关联）在撤销后原样保留，计划仍可再次完成生成同等标题
    const items = await database.mealPlanItem.findMany({
      where: { mealPlanId: planId },
      orderBy: { sortOrder: 'asc' },
      include: { store: true }
    });
    expect(items).toHaveLength(2);
    expect(items[0]?.customName).toBe('撤销测试小菜');
    expect(items[1]?.store?.name).toBe('撤销测试好味面馆');

    // 记录虽然进入回收站，但其 relationships 数据未物理销毁（soft delete 保留审计）
    const softDeleted = await database.mealRecord.findUniqueOrThrow({
      where: { id: record.id },
      include: { items: { include: { store: true } } }
    });
    expect(softDeleted.deletedAt).not.toBeNull();
    expect(softDeleted.items.some((item) => item.store?.name === '撤销测试好味面馆')).toBe(true);

    await database.mealRecordDiner.deleteMany({ where: { mealRecordId: record.id } });
    await database.mealRecordItem.deleteMany({ where: { mealRecordId: record.id } });
    await database.mealRecord.delete({ where: { id: record.id } });
    await database.mealPlanDiner.deleteMany({ where: { mealPlanId: planId } });
    await database.mealPlanItem.deleteMany({ where: { mealPlanId: planId } });
    await database.mealPlan.delete({ where: { id: planId } });
    await database.store.delete({ where: { id: store.id } });
  });
});
