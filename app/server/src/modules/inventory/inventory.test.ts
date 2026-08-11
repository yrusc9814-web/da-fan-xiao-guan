import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../../database/test-database.js';
import { registerErrorHandlers } from '../../plugins/error-handler.js';
import { registerInventoryRoutes } from './routes.js';

const database = createTestPrismaClient();
const app = Fastify({ logger: false });

describe('基础库存推荐 API', () => {
  beforeAll(async () => { await database.$connect(); registerErrorHandlers(app); await registerInventoryRoutes(app, database); });
  afterAll(async () => { await app.close(); await database.$disconnect(); });

  it('按批次库存换算、工具硬过滤和剩菜优先排序', async () => {
    const ingredient = await database.ingredient.create({ data: {
      name: '推荐测试土豆', unit: 'GRAM', quantity: 1000,
      inventoryBatches: { create: { quantity: 1, unit: 'KILOGRAM', consumePriority: true } }
    } });
    const tool = await database.kitchenTool.create({ data: { name: '推荐测试锅', quantity: 1, status: 'AVAILABLE' } });
    const recipe = await database.recipe.create({ data: {
      name: '推荐测试土豆泥', cookingTimeMinutes: 20,
      ingredients: { create: { ingredientId: ingredient.id, ingredientNameSnapshot: ingredient.name, quantity: 300, unit: 'GRAM' } },
      tools: { create: { toolId: tool.id, toolNameSnapshot: tool.name, required: true } }
    } });
    const response = await app.inject({ method: 'POST', url: '/api/v1/kitchen/recommend', payload: { mode: 'ONLY_INVENTORY' } });
    expect(response.statusCode).toBe(200);
    const result = response.json().data.items.find((item: { recipe: { id: string } }) => item.recipe.id === recipe.id);
    expect(result.completion).toBe(100);
    expect(result.wasteScore).toBeGreaterThan(0);

    await database.kitchenTool.update({ where: { id: tool.id }, data: { quantity: 0 } });
    const blocked = await app.inject({ method: 'POST', url: '/api/v1/kitchen/recommend', payload: { mode: 'ONLY_INVENTORY' } });
    expect(blocked.json().data.items.some((item: { recipe: { id: string } }) => item.recipe.id === recipe.id)).toBe(false);
  });
});
