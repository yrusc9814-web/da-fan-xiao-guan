import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../../database/test-database.js';
import { registerErrorHandlers } from '../../plugins/error-handler.js';
import { registerRecipeRoutes } from './routes.js';

const database = createTestPrismaClient();
const app = Fastify({ logger: false });

describe('菜谱 API', () => {
  beforeAll(async () => {
    await database.$connect();
    registerErrorHandlers(app);
    await registerRecipeRoutes(app, database);
  });
  afterAll(async () => { await app.close(); await database.$disconnect(); });

  it('事务创建、查询和更新结构化菜谱', async () => {
    const ingredient = await database.ingredient.create({ data: { name: '菜谱测试番茄', unit: 'GRAM' } });
    const created = await app.inject({ method: 'POST', url: '/api/v1/recipes', payload: {
      name: '菜谱测试番茄蛋', cookingTimeMinutes: 15, spicyLevel: 1, tags: ['快手菜'], mealTypes: ['LUNCH'],
      ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: 200, unit: 'GRAM', isPrimary: true }],
      steps: [{ content: '切番茄' }, { content: '炒熟' }]
    } });
    expect(created.statusCode).toBe(201);
    const recipe = created.json().data;
    expect(recipe.ingredients).toHaveLength(1);
    expect(recipe.steps.map((step: { stepNo: number }) => step.stepNo)).toEqual([1, 2]);

    const updated = await app.inject({ method: 'PUT', url: `/api/v1/recipes/${recipe.id}`, payload: {
      version: recipe.version, name: '菜谱测试番茄炒蛋', mealTypes: ['DINNER'],
      ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: 250, unit: 'GRAM' }],
      steps: [{ content: '一次完成' }], tags: ['家常菜']
    } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.steps).toHaveLength(1);
    expect(updated.json().data.version).toBe(2);

    const conflict = await app.inject({ method: 'PUT', url: `/api/v1/recipes/${recipe.id}`, payload: { version: 1, name: '冲突修改' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('VERSION_CONFLICT');

    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/recipes/${recipe.id}?version=2` });
    expect(removed.statusCode).toBe(200);
    expect((await database.recipe.findUniqueOrThrow({ where: { id: recipe.id } })).deletedAt).not.toBeNull();
  });
});
