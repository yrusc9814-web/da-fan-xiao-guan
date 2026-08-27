import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPrismaClient } from '../src/database/test-database.js';
import { confirmConsumption, getConsumptionPreview } from '../src/modules/consumption/service.js';
import { deleteIngredient } from '../src/modules/ingredients/service.js';
import { completePlan, createPlan } from '../src/modules/meal-plans/service.js';
import { getRecipe } from '../src/modules/recipes/service.js';

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

  it('关联库存食材的菜谱行完整走扣减链路并生成扣减日志', async () => {
    const ingredient = await database.ingredient.create({
      data: {
        name: '闭环测试番茄甲',
        unit: 'GRAM',
        quantity: 500,
        inventoryBatches: { create: { quantity: 500, unit: 'GRAM', expiryDate: '2099-12-31' } }
      },
      include: { inventoryBatches: true }
    });
    const batchId = ingredient.inventoryBatches[0]!.id;
    const recipe = await database.recipe.create({
      data: {
        name: '闭环番茄甲菜',
        servings: 1,
        ingredients: {
          create: [
            {
              ingredientId: ingredient.id,
              ingredientNameSnapshot: ingredient.name,
              quantity: 300,
              unit: 'GRAM',
              sortOrder: 0
            }
          ]
        }
      }
    });
    const plan = await createPlan(database, {
      planDate: '2041-03-21',
      mealType: 'LUNCH',
      dinerCount: 1,
      items: [{ itemType: 'RECIPE', recipeId: recipe.id, mealRole: 'MAIN' }]
    });
    const completed = await completePlan(database, plan.id, plan.version);
    const preview = await getConsumptionPreview(database, completed.record.id, completed.record.version);
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0].shortageQuantity).toBe(0);

    const result = await confirmConsumption(database, {
      recordId: completed.record.id,
      recordVersion: completed.record.version,
      previewToken: preview.previewToken,
      operationId: 'p1-1-consumption-linked-tomato'
    });
    expect(result.repeated).toBe(false);

    const batch = await database.inventoryBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.quantity).toBe(200);
    const log = await database.inventoryLog.findFirst({
      where: { relatedRecordId: completed.record.id, changeType: 'COOK_DEDUCT' }
    });
    expect(log).not.toBeNull();
    expect(log!.ingredientId).toBe(ingredient.id);
    expect(log!.beforeQuantity).toBe(500);
    expect(log!.changeQuantity).toBe(-300);
    expect(log!.afterQuantity).toBe(200);
    const refreshed = await database.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } });
    expect(refreshed.quantity).toBe(200);
    expect(
      await database.shoppingListItem.count({
        where: { sourceType: 'INSUFFICIENT_STOCK', sourceId: preview.items[0].recipeIngredientId }
      })
    ).toBe(0);
  });

  it('同名称但未关联库存食材的菜谱行不会按名称偷偷扣减库存', async () => {
    const stock = await database.ingredient.create({
      data: {
        name: '闭环测试鸡蛋',
        unit: 'GRAM',
        quantity: 400,
        inventoryBatches: { create: { quantity: 400, unit: 'GRAM', expiryDate: '2099-12-31' } }
      },
      include: { inventoryBatches: true }
    });
    const stockBatchId = stock.inventoryBatches[0]!.id;
    const recipe = await database.recipe.create({
      data: {
        name: '闭环鸡蛋菜未关联',
        servings: 1,
        ingredients: {
          create: [{ ingredientNameSnapshot: '闭环测试鸡蛋', quantity: 2, unit: 'PIECE', sortOrder: 0 }]
        }
      }
    });
    const plan = await createPlan(database, {
      planDate: '2041-03-22',
      mealType: 'DINNER',
      dinerCount: 1,
      items: [{ itemType: 'RECIPE', recipeId: recipe.id, mealRole: 'MAIN' }]
    });
    const completed = await completePlan(database, plan.id, plan.version);
    const preview = await getConsumptionPreview(database, completed.record.id, completed.record.version);
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0].ingredientId).toBeNull();
    expect(preview.items[0].shortageQuantity).toBe(2);

    await confirmConsumption(database, {
      recordId: completed.record.id,
      recordVersion: completed.record.version,
      previewToken: preview.previewToken,
      operationId: 'p1-1-consumption-unlinked-egg'
    });

    const batch = await database.inventoryBatch.findUniqueOrThrow({ where: { id: stockBatchId } });
    expect(batch.quantity).toBe(400);
    const refreshed = await database.ingredient.findUniqueOrThrow({ where: { id: stock.id } });
    expect(refreshed.quantity).toBe(400);
    expect(
      await database.inventoryLog.count({ where: { relatedRecordId: completed.record.id, changeType: 'COOK_DEDUCT' } })
    ).toBe(0);
  });

  it('关联食材软删后快照完好且预览按缺料处理不抛错', async () => {
    const doomed = await database.ingredient.create({
      data: { name: '闭环测试将删番茄', unit: 'GRAM', quantity: 100 }
    });
    const recipe = await database.recipe.create({
      data: {
        name: '闭环软删番茄菜',
        servings: 1,
        ingredients: {
          create: [
            {
              ingredientId: doomed.id,
              ingredientNameSnapshot: doomed.name,
              quantity: 250,
              unit: 'GRAM',
              sortOrder: 0
            }
          ]
        }
      }
    });
    await deleteIngredient(database, doomed.id, doomed.version);

    const recipeAfter = await getRecipe(database, recipe.id);
    expect(recipeAfter.ingredients[0].ingredientId).toBe(doomed.id);
    expect(recipeAfter.ingredients[0].ingredientNameSnapshot).toBe('闭环测试将删番茄');

    const plan = await createPlan(database, {
      planDate: '2041-03-23',
      mealType: 'LUNCH',
      dinerCount: 1,
      items: [{ itemType: 'RECIPE', recipeId: recipe.id, mealRole: 'MAIN' }]
    });
    const completed = await completePlan(database, plan.id, plan.version);
    const preview = await getConsumptionPreview(database, completed.record.id, completed.record.version);
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0].ingredientId).toBe(doomed.id);
    expect(preview.items[0].shortageQuantity).toBe(250);
    expect(preview.items[0].allocations).toEqual([]);
  });
});
