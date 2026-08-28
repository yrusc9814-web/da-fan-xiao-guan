import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerConsumptionRoutes } from '../src/modules/consumption/routes.js';
import { registerIngredientRoutes } from '../src/modules/ingredients/routes.js';
import { registerMealPlanRoutes } from '../src/modules/meal-plans/routes.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';
import { registerRecipeRoutes } from '../src/modules/recipes/routes.js';
import { registerSettingsRoutes } from '../src/modules/settings/routes.js';
import { registerShoppingRoutes } from '../src/modules/shopping/routes.js';
import { registerStoreRoutes } from '../src/modules/stores/routes.js';

const database = createTestPrismaClient();
let app: FastifyInstance;

const createdRecipeIds: string[] = [];
const createdPlanIds: string[] = [];
const createdRecordIds: string[] = [];
const createdShoppingListIds: string[] = [];

async function injectJson(method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  });
}

describe('外部写接口运行时校验（坏输入 → 4xx，不落库、不 500）', () => {
  beforeAll(async () => {
    await database.$connect();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerRecipeRoutes(app, database);
    await registerMealPlanRoutes(app, database);
    await registerMealRecordRoutes(app, database);
    await registerConsumptionRoutes(app, database);
    await registerSettingsRoutes(app, database);
    await registerShoppingRoutes(app, database);
    await registerStoreRoutes(app, database);
    await registerIngredientRoutes(app, database);
  });

  afterAll(async () => {
    for (const recordId of createdRecordIds) {
      await database.mealRecordDiner.deleteMany({ where: { mealRecordId: recordId } });
      await database.mealRecordItem.deleteMany({ where: { mealRecordId: recordId } });
      await database.mealRecord.deleteMany({ where: { id: recordId } });
    }
    for (const planId of createdPlanIds) {
      await database.mealPlanDiner.deleteMany({ where: { mealPlanId: planId } });
      await database.mealPlanItem.deleteMany({ where: { mealPlanId: planId } });
      await database.mealPlan.deleteMany({ where: { id: planId } });
    }
    for (const recipeId of createdRecipeIds) {
      await database.recipeIngredient.deleteMany({ where: { recipeId } });
      await database.recipeStep.deleteMany({ where: { recipeId } });
      await database.recipeTag.deleteMany({ where: { recipeId } });
      await database.recipeMealType.deleteMany({ where: { recipeId } });
      await database.recipeMealRole.deleteMany({ where: { recipeId } });
      await database.recipeTool.deleteMany({ where: { recipeId } });
      await database.recipe.deleteMany({ where: { id: recipeId } });
    }
    for (const listId of createdShoppingListIds) {
      await database.shoppingListItem.deleteMany({ where: { shoppingListId: listId } });
      await database.shoppingList.deleteMany({ where: { id: listId } });
    }
    await app.close();
    await database.$disconnect();
  });

  it('A：非法 enum（mealType="HELLO"）返回 400 而不是 500', async () => {
    const response = await injectJson('POST', '/api/v1/records', {
      recordDate: '2040-02-01',
      mealType: 'HELLO',
      sourceType: 'HOMEMADE'
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('B：version 传字符串返回 400 且不产生任何写入', async () => {
    const created = await injectJson('POST', '/api/v1/plans', {
      planDate: '2040-02-02',
      mealType: 'DINNER',
      dinerCount: 2
    });
    expect(created.statusCode).toBe(201);
    const plan = created.json().data;
    createdPlanIds.push(plan.id);

    const response = await injectJson('PUT', `/api/v1/plans/${plan.id}`, { version: '1', notes: '字符串版本' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');

    const after = await database.mealPlan.findUnique({ where: { id: plan.id } });
    expect(after?.version).toBe(1);
    expect(after?.notes).toBeNull();
  });

  it('C/D：负数与小数 version 返回 400', async () => {
    const plan = createdPlanIds[0]!;
    const negative = await injectJson('PUT', `/api/v1/plans/${plan}`, { version: -3, notes: '负数版本' });
    expect(negative.statusCode).toBe(400);
    const float = await injectJson('PUT', `/api/v1/plans/${plan}`, { version: 1.5, notes: '小数版本' });
    expect(float.statusCode).toBe(400);
    const after = await database.mealPlan.findUnique({ where: { id: plan } });
    expect(after?.version).toBe(1);
  });

  it('E：缺少必填字段返回 400', async () => {
    const missingName = await injectJson('POST', '/api/v1/recipes', { notes: '没有名称' });
    expect(missingName.statusCode).toBe(400);
    expect(missingName.json().error.code).toBe('VALIDATION_ERROR');

    const missingMealType = await injectJson('POST', '/api/v1/records', {
      recordDate: '2040-02-01',
      sourceType: 'HOMEMADE'
    });
    expect(missingMealType.statusCode).toBe(400);
  });

  it('F：嵌套数组元素非法返回 400', async () => {
    const badItem = await injectJson('POST', '/api/v1/records', {
      recordDate: '2040-02-01',
      mealType: 'LUNCH',
      sourceType: 'HOMEMADE',
      items: [{ itemType: 'HELLO', customName: '非法项目' }]
    });
    expect(badItem.statusCode).toBe(400);

    const badSelections = await injectJson('POST', '/api/v1/records/whatever/consumption-preview', {
      recordVersion: 1,
      selections: { 'recipe-ingredient-1': '不是数组' }
    });
    expect(badSelections.statusCode).toBe(400);
  });

  it('G：合法 payload 行为保持不变', async () => {
    const recipe = await injectJson('POST', '/api/v1/recipes', {
      name: '运行时校验菜谱',
      mealTypes: ['BREAKFAST'],
      ingredients: [{ name: '鸡蛋', quantity: 2, unit: 'PIECE' }],
      steps: [{ content: '煎蛋' }]
    });
    expect(recipe.statusCode).toBe(201);
    createdRecipeIds.push(recipe.json().data.id);

    const record = await injectJson('POST', '/api/v1/records', {
      recordDate: '2040-02-03',
      mealType: 'LUNCH',
      sourceType: 'HOMEMADE',
      rating: 4.5,
      items: [{ itemType: 'CUSTOM', customName: '运行时校验餐' }]
    });
    expect(record.statusCode).toBe(201);
    const recordData = record.json().data;
    createdRecordIds.push(recordData.id);
    expect(recordData).toMatchObject({ mealType: 'LUNCH', status: 'CONFIRMED', rating: 4.5 });
    expect(recordData.items).toHaveLength(1);

    const shoppingList = await injectJson('POST', '/api/v1/shopping-lists', {
      name: '运行时校验清单',
      items: [{ ingredientName: '大米', quantity: 1, unit: 'KILOGRAM' }]
    });
    expect(shoppingList.statusCode).toBe(201);
    createdShoppingListIds.push(shoppingList.json().data.id);
  });

  it('H：真实业务版本冲突仍是 409，不被 schema 吞成 400', async () => {
    const created = await injectJson('POST', '/api/v1/plans', {
      planDate: '2040-02-04',
      mealType: 'LUNCH',
      dinerCount: 1
    });
    expect(created.statusCode).toBe(201);
    const plan = created.json().data;
    createdPlanIds.push(plan.id);

    const firstUpdate = await injectJson('PUT', `/api/v1/plans/${plan.id}`, { version: 1, notes: '第一次更新' });
    expect(firstUpdate.statusCode).toBe(200);
    expect(firstUpdate.json().data.version).toBe(2);

    const staleUpdate = await injectJson('PUT', `/api/v1/plans/${plan.id}`, { version: 1, notes: '过期更新' });
    expect(staleUpdate.statusCode).toBe(409);
    expect(staleUpdate.json().error.code).toBe('VERSION_CONFLICT');
  });

  it('I：资源不存在返回 404', async () => {
    const missingPlan = await injectJson('PUT', '/api/v1/plans/does-not-exist', { version: 1, notes: 'x' });
    expect(missingPlan.statusCode).toBe(404);

    const missingRecord = await app.inject({ method: 'GET', url: '/api/v1/records/does-not-exist' });
    expect(missingRecord.statusCode).toBe(404);
  });

  it('J：非法输入与 malformed JSON 不产生数据库副作用', async () => {
    const recordsBefore = await database.mealRecord.count();
    const plansBefore = await database.mealPlan.count();
    const recipesBefore = await database.recipe.count();

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: '{recordDate: 不是JSON',
      headers: { 'content-type': 'application/json' }
    });
    expect(malformed.statusCode).toBe(400);

    await injectJson('POST', '/api/v1/records', { recordDate: 123, mealType: 456, sourceType: null });
    await injectJson('POST', '/api/v1/records', { recordDate: '2040-02-01', mealType: 'LUNCH', sourceType: 42 });
    await injectJson('POST', '/api/v1/recipes', { name: { nested: '对象名称' }, mealTypes: 'BREAKFAST' });
    await injectJson('POST', '/api/v1/stores', { name: 'x', supportsDineIn: 'yes', favorite: 1 });
    await injectJson('POST', '/api/v1/ingredients', { name: 'x', unit: '不存在的单位' });
    await injectJson('DELETE', '/api/v1/plans/does-not-exist?version=abc');
    await injectJson('PUT', '/api/v1/settings', { version: 'abc', appName: 1 });
    await injectJson('PUT', '/api/v1/settings/pin', { version: 1, enabled: 'yes' });

    expect(await database.mealRecord.count()).toBe(recordsBefore);
    expect(await database.mealPlan.count()).toBe(plansBefore);
    expect(await database.recipe.count()).toBe(recipesBefore);
  });

  it('K：DELETE 查询串版本非法返回 400，合法版本可正常删除', async () => {
    const created = await injectJson('POST', '/api/v1/plans', {
      planDate: '2040-02-05',
      mealType: 'DINNER',
      dinerCount: 1
    });
    expect(created.statusCode).toBe(201);
    const plan = created.json().data;

    const badQuery = await app.inject({ method: 'DELETE', url: `/api/v1/plans/${plan.id}?version=abc` });
    expect(badQuery.statusCode).toBe(400);
    expect(await database.mealPlan.findUnique({ where: { id: plan.id } })).not.toBeNull();

    const goodQuery = await app.inject({ method: 'DELETE', url: `/api/v1/plans/${plan.id}?version=1` });
    expect(goodQuery.statusCode).toBe(200);
    expect(await database.mealPlan.findUnique({ where: { id: plan.id } })).toMatchObject({
      deletedAt: expect.any(Date)
    });
  });
});
