import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { registerMealPlanRoutes } from '../src/modules/meal-plans/routes.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';

// VAN-40：Direct Completion / 即时用餐完成计划后，立即返回的 record.items 必须带真实
// recipe/store 关系（与 GET /records 刷新后的标题来源一致），CUSTOM 保留 customName；
// 幂等重复完成响应关系仍齐；relatedPlanId / sourceMealPlanId 不丢；
// 原 plan 日期与状态语义保留；完成动作不自动扣减库存（保持现 DirectCompletion 语义）。
const database = createTestPrismaClient();

const fixtureDate = '2042-05-10';
const recordDateRange = { from: fixtureDate, to: '2042-05-31' };

async function cleanupRange(): Promise<void> {
  const records = await database.mealRecord.findMany({
    where: { recordDate: { gte: recordDateRange.from, lte: recordDateRange.to } },
    select: { id: true }
  });
  const recordIds = records.map(({ id }) => id);
  await database.mealRecordDiner.deleteMany({ where: { mealRecordId: { in: recordIds } } });
  await database.mealRecordItem.deleteMany({ where: { mealRecordId: { in: recordIds } } });
  await database.mealRecord.deleteMany({ where: { id: { in: recordIds } } });
  const plans = await database.mealPlan.findMany({
    where: { planDate: { gte: fixtureDate, lte: '2042-05-31' } },
    select: { id: true }
  });
  const planIds = plans.map(({ id }) => id);
  await database.mealPlanDiner.deleteMany({ where: { mealPlanId: { in: planIds } } });
  await database.mealPlanItem.deleteMany({ where: { mealPlanId: { in: planIds } } });
  await database.mealPlan.deleteMany({ where: { id: { in: planIds } } });
}

function buildApp() {
  const app = Fastify({ logger: false });
  registerErrorHandlers(app);
  void registerMealPlanRoutes(app, database);
  void registerMealRecordRoutes(app, database);
  return app;
}

type CompleteResponse = {
  success: boolean;
  data: {
    plan: { id: string; status: string; planDate: string; version: number };
    record: {
      id: string;
      status: string;
      recordDate: string;
      relatedPlanId: string | null;
      items: Array<{
        itemType: string;
        sortOrder: number | null;
        customName: string | null;
        recipe: { id: string; name: string } | null;
        store: { id: string; name: string } | null;
      }>;
    };
    idempotent: boolean;
  };
};

type RecordsResponse = {
  success: boolean;
  data: {
    items: Array<{
      id: string;
      recordDate: string;
      status: string;
      relatedPlanId: string | null;
      items: Array<{
        itemType: string;
        customName: string | null;
        recipe: { name: string } | null;
        store: { name: string } | null;
      }>;
    }>;
    total: number;
  };
};

describe('VAN40 计划完成立即响应标题来源', () => {
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    await database.$connect();
    await cleanupRange();
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await cleanupRange();
    await database.$disconnect();
  });

  it('完成混合计划立即响应 items 带真实关系且按 sortOrder 排序，刷新 GET /records 标题来源一致', async () => {
    const recipe = await database.recipe.create({
      data: { name: 'VAN40测试红烧肉', servings: 2 }
    });
    const store = await database.store.create({ data: { name: 'VAN40测试老王面馆' } });
    const batchIngredient = await database.ingredient.create({
      data: { name: 'VAN40测试库存面粉', unit: 'GRAM', quantity: 100 }
    });
    const batchBefore = await database.inventoryBatch.create({
      data: {
        ingredientId: batchIngredient.id,
        quantity: 100,
        unit: 'GRAM',
        expiryDate: '2099-12-31'
      }
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      payload: {
        planDate: fixtureDate,
        mealType: 'DINNER',
        dinerCount: 2,
        items: [
          { itemType: 'RECIPE', recipeId: recipe.id, mealRole: 'MAIN', sortOrder: 2 },
          { itemType: 'CUSTOM', customName: 'VAN40米饭', mealRole: 'STAPLE', sortOrder: 0 },
          { itemType: 'STORE', storeId: store.id, mealRole: null, sortOrder: 1 }
        ]
      }
    });
    expect(createResponse.statusCode).toBe(201);
    const planId = (createResponse.json().data as { id: string }).id;
    const planVersion = (createResponse.json().data as { version: number }).version;

    const inventoryLogsBefore = await database.inventoryLog.count();

    const completeResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${planId}/complete`,
      payload: { version: planVersion }
    });
    expect(completeResponse.statusCode).toBe(200);
    const completed = completeResponse.json<CompleteResponse>();
    expect(completed.success).toBe(true);
    expect(completed.data.idempotent).toBe(false);

    // 计划语义保留：日期不变、状态进入 COMPLETED、record 日期跟随计划
    expect(completed.data.plan.id).toBe(planId);
    expect(completed.data.plan.planDate).toBe(fixtureDate);
    expect(completed.data.plan.status).toBe('COMPLETED');
    expect(completed.data.record.recordDate).toBe(fixtureDate);
    expect(completed.data.record.status).toBe('DRAFT');

    // 关系立即返回：RECIPE/STORE/CUSTOM 三类标题来源全部非空
    const completedItems = completed.data.record.items;
    expect(completedItems).toHaveLength(3);
    expect(completedItems.map((item) => item.sortOrder)).toEqual([0, 1, 2]);
    const recipeItem = completedItems.find((item) => item.itemType === 'RECIPE');
    const storeItem = completedItems.find((item) => item.itemType === 'STORE');
    const customItem = completedItems.find((item) => item.itemType === 'CUSTOM');
    expect(recipeItem?.recipe?.name).toBe('VAN40测试红烧肉');
    expect(storeItem?.store?.name).toBe('VAN40测试老王面馆');
    expect(customItem?.customName).toBe('VAN40米饭');

    // adapter 标题来源链 customName || recipe.name || store.name 在响应上立即可用
    const recordTitle = completedItems
      .map((item) => item.customName || item.recipe?.name || item.store?.name || '')
      .join(',');
    expect(recordTitle).toBe('VAN40米饭,VAN40测试老王面馆,VAN40测试红烧肉');

    // relatedPlanId 不丢
    expect(completed.data.record.relatedPlanId).toBe(planId);

    // Direct Completion 现语义：不自动扣减库存
    expect(await database.inventoryLog.count()).toBe(inventoryLogsBefore);
    const batchAfter = await database.inventoryBatch.findUniqueOrThrow({ where: { id: batchBefore.id } });
    expect(batchAfter.quantity).toBe(100);

    // 幂等重复完成：响应关系仍齐
    const planAfterComplete = await database.mealPlan.findUniqueOrThrow({ where: { id: planId } });
    const repeatResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${planId}/complete`,
      payload: { version: planAfterComplete.version }
    });
    expect(repeatResponse.statusCode).toBe(200);
    const repeated = repeatResponse.json<CompleteResponse>();
    expect(repeated.data.idempotent).toBe(true);
    expect(repeated.data.record.id).toBe(completed.data.record.id);
    const repeatedItems = repeated.data.record.items;
    expect(repeatedItems).toHaveLength(3);
    expect(repeatedItems.map((item) => item.sortOrder)).toEqual([0, 1, 2]);
    expect(repeatedItems.find((item) => item.itemType === 'RECIPE')?.recipe?.name).toBe('VAN40测试红烧肉');
    expect(repeatedItems.find((item) => item.itemType === 'STORE')?.store?.name).toBe('VAN40测试老王面馆');
    expect(repeatedItems.find((item) => item.itemType === 'CUSTOM')?.customName).toBe('VAN40米饭');

    // 刷新 GET /records：标题来源与完成响应一致
    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/records?from=${recordDateRange.from}&to=${recordDateRange.to}`
    });
    expect(listResponse.statusCode).toBe(200);
    const list = listResponse.json<RecordsResponse>();
    const refreshed = list.data.items.find((item) => item.id === completed.data.record.id);
    expect(refreshed).toBeDefined();
    expect(refreshed?.relatedPlanId).toBe(planId);
    expect(refreshed?.items).toHaveLength(3);
    expect(refreshed?.items.find((item) => item.itemType === 'RECIPE')?.recipe?.name).toBe('VAN40测试红烧肉');
    expect(refreshed?.items.find((item) => item.itemType === 'STORE')?.store?.name).toBe('VAN40测试老王面馆');
    expect(refreshed?.items.find((item) => item.itemType === 'CUSTOM')?.customName).toBe('VAN40米饭');

    // sourceMealPlanId 落库不丢
    const persistedRecord = await database.mealRecord.findUniqueOrThrow({
      where: { id: completed.data.record.id }
    });
    expect(persistedRecord.sourceMealPlanId).toBe(planId);
    expect(persistedRecord.relatedPlanId).toBe(planId);

    await database.inventoryBatch.delete({ where: { id: batchBefore.id } });
    await database.ingredient.delete({ where: { id: batchIngredient.id } });
  });

  it('即时用餐 CUSTOM-only 计划完成立即响应 customName 保留且幂等响应一致', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      payload: {
        planDate: '2042-05-11',
        mealType: 'LUNCH',
        dinerCount: 1,
        items: [{ itemType: 'CUSTOM', customName: 'VAN40楼下凉皮', sortOrder: 0 }]
      }
    });
    expect(createResponse.statusCode).toBe(201);
    const planId = (createResponse.json().data as { id: string }).id;
    const planVersion = (createResponse.json().data as { version: number }).version;

    const completeResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${planId}/complete`,
      payload: { version: planVersion }
    });
    expect(completeResponse.statusCode).toBe(200);
    const completed = completeResponse.json<CompleteResponse>();
    expect(completed.data.record.recordDate).toBe('2042-05-11');
    expect(completed.data.record.items).toHaveLength(1);
    expect(completed.data.record.items[0]?.customName).toBe('VAN40楼下凉皮');
    expect(completed.data.record.relatedPlanId).toBe(planId);

    const planAfterComplete = await database.mealPlan.findUniqueOrThrow({ where: { id: planId } });
    const repeatResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${planId}/complete`,
      payload: { version: planAfterComplete.version }
    });
    expect(repeatResponse.statusCode).toBe(200);
    const repeated = repeatResponse.json<CompleteResponse>();
    expect(repeated.data.idempotent).toBe(true);
    expect(repeated.data.record.items[0]?.customName).toBe('VAN40楼下凉皮');
  });
});
