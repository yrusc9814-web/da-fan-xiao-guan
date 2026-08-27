import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../../database/test-database.js';
import { registerErrorHandlers } from '../../plugins/error-handler.js';
import { deleteIngredient } from '../ingredients/service.js';
import { registerRecipeRoutes } from './routes.js';

const database = createTestPrismaClient();
const app = Fastify({ logger: false });

describe('菜谱 API', () => {
  beforeAll(async () => {
    await database.$connect();
    registerErrorHandlers(app);
    await registerRecipeRoutes(app, database);
  });
  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it('事务创建、查询和更新结构化菜谱', async () => {
    const ingredient = await database.ingredient.create({ data: { name: '菜谱测试番茄', unit: 'GRAM' } });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/recipes',
      payload: {
        name: '菜谱测试番茄蛋',
        cookingTimeMinutes: 15,
        spicyLevel: 1,
        tags: ['快手菜'],
        mealTypes: ['LUNCH'],
        ingredients: [
          { ingredientId: ingredient.id, name: ingredient.name, quantity: 200, unit: 'GRAM', isPrimary: true }
        ],
        steps: [{ content: '切番茄' }, { content: '炒熟' }]
      }
    });
    expect(created.statusCode).toBe(201);
    const recipe = created.json().data;
    expect(recipe.ingredients).toHaveLength(1);
    expect(recipe.steps.map((step: { stepNo: number }) => step.stepNo)).toEqual([1, 2]);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/recipes/${recipe.id}`,
      payload: {
        version: recipe.version,
        name: '菜谱测试番茄炒蛋',
        mealTypes: ['DINNER'],
        ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: 250, unit: 'GRAM' }],
        steps: [{ content: '一次完成' }],
        tags: ['家常菜']
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.steps).toHaveLength(1);
    expect(updated.json().data.version).toBe(2);

    const conflict = await app.inject({
      method: 'PUT',
      url: `/api/v1/recipes/${recipe.id}`,
      payload: { version: 1, name: '冲突修改' }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('VERSION_CONFLICT');

    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/recipes/${recipe.id}?version=2` });
    expect(removed.statusCode).toBe(200);
    expect((await database.recipe.findUniqueOrThrow({ where: { id: recipe.id } })).deletedAt).not.toBeNull();
  });

  it('创建与更新校验并保留关联库存食材的 ingredientId 与名称快照', async () => {
    const ingredient = await database.ingredient.create({
      data: { name: '菜谱测试库存西红柿', unit: 'GRAM', quantity: 1000 }
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/recipes',
      payload: {
        name: '菜谱测试库存联动',
        mealTypes: ['LUNCH'],
        ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: 300, unit: 'GRAM', isPrimary: true }],
        steps: [{ content: '一次完成' }]
      }
    });
    expect(created.statusCode).toBe(201);
    const recipeId = created.json().data.id;
    expect(created.json().data.ingredients[0].ingredientId).toBe(ingredient.id);
    expect(created.json().data.ingredients[0].ingredientNameSnapshot).toBe(ingredient.name);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/recipes/${recipeId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.ingredients[0].ingredientId).toBe(ingredient.id);
    expect(detail.json().data.ingredients[0].ingredientNameSnapshot).toBe(ingredient.name);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/recipes/${recipeId}`,
      payload: {
        version: detail.json().data.version,
        name: '菜谱测试库存联动-更新',
        mealTypes: ['DINNER'],
        ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: 350, unit: 'GRAM' }],
        steps: [{ content: '再次完成' }]
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.ingredients[0].ingredientId).toBe(ingredient.id);
    expect(updated.json().data.ingredients[0].ingredientNameSnapshot).toBe(ingredient.name);
    await app.inject({ method: 'DELETE', url: `/api/v1/recipes/${recipeId}?version=${updated.json().data.version}` });
  });

  it('拒绝关联不存在或已删除的库存食材', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/recipes',
      payload: {
        name: '菜谱测试非法食材',
        mealTypes: ['LUNCH'],
        ingredients: [{ ingredientId: 'not-a-real-ingredient-000', name: '不存在的食材', quantity: 100, unit: 'GRAM' }]
      }
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toContain('不存在');

    const doomed = await database.ingredient.create({ data: { name: '菜谱测试将删除食材', unit: 'GRAM' } });
    await deleteIngredient(database, doomed.id, doomed.version);

    const recipe = await database.recipe.create({
      data: {
        name: '菜谱测试软删前菜',
        ingredients: {
          create: [{ ingredientNameSnapshot: '菜谱测试将删除食材', quantity: 1, unit: 'GRAM', sortOrder: 0 }]
        }
      }
    });
    const badUpdate = await app.inject({
      method: 'PUT',
      url: `/api/v1/recipes/${recipe.id}`,
      payload: {
        version: recipe.version,
        name: '菜谱测试软删后更新',
        mealTypes: ['LUNCH'],
        ingredients: [{ ingredientId: doomed.id, name: '菜谱测试将删除食材', quantity: 50, unit: 'GRAM' }]
      }
    });
    expect(badUpdate.statusCode).toBe(400);
    expect(badUpdate.json().error.message).toContain('不存在或已删除');
    await app.inject({ method: 'DELETE', url: `/api/v1/recipes/${recipe.id}?version=${recipe.version}` });
  });
});
