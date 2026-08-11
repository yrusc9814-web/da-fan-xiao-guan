import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPrismaClient } from '../src/database/test-database.js';
import { confirmConsumption, getConsumptionPreview } from '../src/modules/consumption/service.js';
import { completePlan, createPlan } from '../src/modules/meal-plans/service.js';

const database = createTestPrismaClient();

describe('库存扣减闭环', () => {
  beforeAll(async () => {
    await database.$connect();
  });
  afterAll(async () => {
    await database.$disconnect();
  });

  it('确认扣减原子更新批次、日志、缺料清单与记录，重复 operationId 不重复执行', async () => {
    const ingredient = await database.ingredient.create({
      data: {
        name: '闭环测试番茄',
        unit: 'GRAM',
        quantity: 300,
        inventoryBatches: { create: { quantity: 300, unit: 'GRAM', expiryDate: '2099-12-31' } }
      },
      include: { inventoryBatches: true }
    });
    const recipe = await database.recipe.create({
      data: {
        name: '闭环番茄菜',
        servings: 1,
        ingredients: {
          create: [
            {
              ingredientId: ingredient.id,
              ingredientNameSnapshot: ingredient.name,
              quantity: 500,
              unit: 'GRAM',
              sortOrder: 0
            },
            { ingredientNameSnapshot: '闭环测试鸡蛋', quantity: 2, unit: 'PIECE', sortOrder: 1 }
          ]
        }
      }
    });
    const plan = await createPlan(database, {
      planDate: '2041-03-11',
      mealType: 'DINNER',
      dinerCount: 1,
      items: [{ itemType: 'RECIPE', recipeId: recipe.id, mealRole: 'MAIN' }]
    });
    const completed = await completePlan(database, plan.id, plan.version);
    const preview = await getConsumptionPreview(database, completed.record.id, completed.record.version);
    expect(preview.items.map((item) => item.shortageQuantity)).toEqual([200, 2]);

    const first = await confirmConsumption(database, {
      recordId: completed.record.id,
      recordVersion: completed.record.version,
      previewToken: preview.previewToken,
      operationId: 'consumption-test-operation'
    });
    const second = await confirmConsumption(database, {
      recordId: completed.record.id,
      recordVersion: completed.record.version,
      previewToken: preview.previewToken,
      operationId: 'consumption-test-operation'
    });

    const batch = await database.inventoryBatch.findUniqueOrThrow({
      where: { id: ingredient.inventoryBatches[0]!.id }
    });
    expect(batch.quantity).toBe(0);
    expect(
      await database.inventoryLog.count({ where: { relatedRecordId: completed.record.id, changeType: 'COOK_DEDUCT' } })
    ).toBe(1);
    expect((await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } })).status).toBe(
      'CONFIRMED'
    );
    expect(first.repeated).toBe(false);
    expect(second.repeated).toBe(true);
    await expect(
      confirmConsumption(database, {
        recordId: completed.record.id,
        recordVersion: completed.record.version,
        previewToken: 'different-preview',
        operationId: 'consumption-test-operation'
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    const shortageItems = await database.shoppingListItem.findMany({
      where: {
        sourceType: 'INSUFFICIENT_STOCK',
        sourceId: { in: preview.items.map((item) => item.recipeIngredientId) }
      }
    });
    expect(shortageItems).toHaveLength(2);
  });
});
