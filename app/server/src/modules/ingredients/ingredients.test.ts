import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../../database/test-database.js';
import { registerErrorHandlers } from '../../plugins/error-handler.js';
import { registerIngredientRoutes } from './routes.js';

const database = createTestPrismaClient();
const app = Fastify({ logger: false });

describe('食材与批次库存 API', () => {
  beforeAll(async () => { await database.$connect(); registerErrorHandlers(app); await registerIngredientRoutes(app, database); });
  afterAll(async () => { await app.close(); await database.$disconnect(); });

  it('创建批次、换算调整并原子写日志', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/ingredients', payload: {
      name: '批次测试面粉', unit: 'GRAM', minStock: 200, maxStock: 3000,
      batches: [{ quantity: 1, unit: 'KILOGRAM', expiryDate: '2026-12-01', consumePriority: true }]
    } });
    expect(created.statusCode).toBe(201);
    const ingredient = created.json().data;
    expect(ingredient.quantity).toBe(1000);
    expect(await database.inventoryLog.count({ where: { ingredientId: ingredient.id } })).toBe(1);

    const batch = ingredient.inventoryBatches[0];
    const adjusted = await app.inject({ method: 'POST', url: `/api/v1/ingredients/${ingredient.id}/adjust`, payload: {
      batchId: batch.id, batchVersion: batch.version, quantity: -250, unit: 'GRAM', changeType: 'MANUAL_DEDUCT'
    } });
    expect(adjusted.statusCode).toBe(200);
    expect(adjusted.json().data.batch.quantity).toBe(0.75);
    expect(adjusted.json().data.quantity).toBe(750);
    const logs = await database.inventoryLog.findMany({ where: { ingredientId: ingredient.id }, orderBy: { createdAt: 'asc' } });
    expect(logs).toHaveLength(2);
    expect(logs[1]?.changeQuantity).toBe(-0.25);

    const conflict = await app.inject({ method: 'POST', url: `/api/v1/ingredients/${ingredient.id}/adjust`, payload: {
      batchId: batch.id, batchVersion: 1, quantity: -1, unit: 'GRAM', changeType: 'MANUAL_DEDUCT'
    } });
    expect(conflict.statusCode).toBe(409);
  });
});
