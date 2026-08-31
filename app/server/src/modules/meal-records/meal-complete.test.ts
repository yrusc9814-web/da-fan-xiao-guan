import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../../database/test-database.js';
import { registerErrorHandlers } from '../../plugins/error-handler.js';
import { registerMealRecordRoutes } from '../meal-records/routes.js';
import { registerConsumptionRoutes } from '../consumption/routes.js';
import { registerShoppingRoutes } from '../shopping/routes.js';
import { registerRecipeRoutes } from '../recipes/routes.js';

const database = createTestPrismaClient();
const app = Fastify({ logger: false });

describe('完成这一餐链路（即时记录 → 库存预览 → 确认扣减）', () => {
  beforeAll(async () => {
    await database.$connect();
    registerErrorHandlers(app);
    await registerRecipeRoutes(app, database);
    await registerMealRecordRoutes(app, database);
    await registerConsumptionRoutes(app, database);
    await registerShoppingRoutes(app, database);
  });
  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it('结构化食材菜谱：即时记录(草稿) → 预览缺料 → 确认扣减后成为正式记录', async () => {
    // 准备库存食材（带库存批次，preview 只读 inventoryBatch）与菜谱
    const potato = await database.ingredient.create({
      data: {
        name: '完成链测试土豆',
        unit: 'GRAM',
        quantity: 500,
        inventoryBatches: { create: { quantity: 500, unit: 'GRAM' } }
      }
    });
    const carrot = await database.ingredient.create({
      data: {
        name: '完成链测试胡萝卜',
        unit: 'GRAM',
        quantity: 100,
        inventoryBatches: { create: { quantity: 100, unit: 'GRAM' } }
      }
    });
    const recipe = await app.inject({
      method: 'POST',
      url: '/api/v1/recipes',
      payload: {
        name: '完成链测试炖菜',
        servings: 2,
        ingredients: [
          { ingredientId: potato.id, name: potato.name, quantity: 400, unit: 'GRAM', isPrimary: true },
          { ingredientId: carrot.id, name: carrot.name, quantity: 300, unit: 'GRAM' }
        ]
      }
    });
    expect(recipe.statusCode).toBe(201);
    const recipeId = recipe.json().data.id;

    // 就吃这个：创建即时 DRAFT 记录（对应 CompleteMealPage Path A 的第一步）
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: {
        recordDate: '2046-08-20',
        recordTime: '12:30',
        mealType: 'LUNCH',
        sourceType: 'HOMEMADE',
        status: 'DRAFT',
        items: [{ itemType: 'RECIPE', recipeId, mealRole: 'MAIN', sortOrder: 0 }]
      }
    });
    expect(created.statusCode).toBe(201);
    const record = created.json().data;
    expect(record.status).toBe('DRAFT');

    // 库存预览：土豆够、胡萝卜缺
    const preview = await app.inject({
      method: 'POST',
      url: `/api/v1/records/${record.id}/consumption-preview`,
      payload: { recordVersion: record.version }
    });
    expect(preview.statusCode).toBe(200);
    const previewData = preview.json().data;
    const byName = Object.fromEntries(
      previewData.items.map((item: { ingredientName: string; [key: string]: unknown }) => [
        item.ingredientName,
        item
      ])
    );
    expect(byName['完成链测试土豆'].shortageQuantity).toBe(0);
    expect(byName['完成链测试胡萝卜'].shortageQuantity).toBeGreaterThan(0);

    // 确认扣减
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/records/${record.id}/confirm-consumption`,
      payload: {
        recordVersion: previewData.recordVersion,
        previewToken: previewData.previewToken,
        operationId: crypto.randomUUID()
      }
    });
    expect(confirmed.statusCode).toBe(200);
    const confirmData = confirmed.json().data;
    expect(confirmData.recordId).toBe(record.id);
    expect(confirmData.inventoryLogIds.length).toBeGreaterThan(0);

    // 库存被扣减：土豆 500→300（需 200，servings 2 按 0.5 比例），胡萝卜全部扣光
    const potatoAfter = await database.ingredient.findUniqueOrThrow({ where: { id: potato.id } });
    expect(potatoAfter.quantity).toBe(300);
    const carrotAfter = await database.ingredient.findUniqueOrThrow({ where: { id: carrot.id } });
    expect(carrotAfter.quantity).toBe(0);

    // 缺料自动写入购物清单（INSUFFICIENT_STOCK）
    const shopping = await database.shoppingList.findFirst({
      where: { deletedAt: null, status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
      include: { items: true }
    });
    expect(shopping).not.toBeNull();
    const missing = shopping!.items.find((item) => item.ingredientId === carrot.id);
    expect(missing).toBeDefined();
    expect(missing!.sourceType).toBe('INSUFFICIENT_STOCK');

    // 记录成为正式状态（下游首页/日历/统计可见）
    const recordAfter = await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(recordAfter.status).toBe('CONFIRMED');
    expect(recordAfter.confirmedAt).not.toBeNull();
    expect(recordAfter.version).toBe(record.version + 1);
  });

  it('无结构化食材的纯记录：直接成为正式记录，无需库存预览', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: {
        recordDate: '2046-08-20',
        mealType: 'DINNER',
        sourceType: 'TAKEOUT',
        status: 'CONFIRMED',
        items: [{ itemType: 'CUSTOM', customName: '楼下餐厅', sortOrder: 0 }]
      }
    });
    expect(created.statusCode).toBe(201);
    const record = created.json().data;
    expect(record.status).toBe('CONFIRMED');
    expect(record.confirmedAt).not.toBeNull();
  });
});
