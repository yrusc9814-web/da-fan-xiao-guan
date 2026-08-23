import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../../database/test-database.js';
import { registerErrorHandlers } from '../../plugins/error-handler.js';
import { registerIngredientRoutes } from './routes.js';

const database = createTestPrismaClient();
const app = Fastify({ logger: false });

describe('批次到期日编辑闭环', () => {
  beforeAll(async () => {
    await database.$connect();
    registerErrorHandlers(app);
    await registerIngredientRoutes(app, database);
  });
  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  async function adjust(ingredientId: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: `/api/v1/ingredients/${ingredientId}/adjust`, payload });
  }

  it('创建食材时批次与汇总均写入到期日', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/ingredients',
      payload: {
        name: '到期日闭环鲜奶',
        unit: 'MILLILITER',
        batches: [{ quantity: 500, unit: 'MILLILITER', expiryDate: '2027-01-15' }]
      }
    });
    expect(created.statusCode).toBe(201);
    const ingredient = created.json().data;
    expect(ingredient.expiryDate).toBe('2027-01-15');
    expect(ingredient.inventoryBatches[0].expiryDate).toBe('2027-01-15');

    const reloaded = await app.inject({ method: 'GET', url: `/api/v1/ingredients/${ingredient.id}` });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json().data.inventoryBatches[0].expiryDate).toBe('2027-01-15');
  });

  it('adjust 仅修改到期日（quantity 0）并重算食材级到期日', async () => {
    const ingredient = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/ingredients',
        payload: {
          name: '到期日闭环酸奶',
          unit: 'GRAM',
          batches: [{ quantity: 200, unit: 'GRAM', expiryDate: '2026-12-31' }]
        }
      })
    ).json().data;
    const batch = ingredient.inventoryBatches[0];

    const adjusted = await adjust(ingredient.id, {
      batchId: batch.id,
      batchVersion: batch.version,
      quantity: 0,
      unit: 'GRAM',
      changeType: 'ADJUST',
      expiryDate: '2028-06-30'
    });
    expect(adjusted.statusCode).toBe(200);
    expect(adjusted.json().data.batch.expiryDate).toBe('2028-06-30');
    expect(adjusted.json().data.batch.quantity).toBe(200);
    expect(adjusted.json().data.quantity).toBe(200);
    expect(adjusted.json().data.batch.version).toBe(batch.version + 1);

    const reloaded = await app.inject({ method: 'GET', url: `/api/v1/ingredients/${ingredient.id}` });
    expect(reloaded.json().data.expiryDate).toBe('2028-06-30');
  });

  it('adjust 不传 expiryDate 时保持原值（向后兼容）', async () => {
    const ingredient = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/ingredients',
        payload: {
          name: '到期日兼容面粉',
          unit: 'GRAM',
          batches: [{ quantity: 100, unit: 'GRAM', expiryDate: '2029-09-09' }]
        }
      })
    ).json().data;
    const batch = ingredient.inventoryBatches[0];

    const adjusted = await adjust(ingredient.id, {
      batchId: batch.id,
      batchVersion: batch.version,
      quantity: -40,
      unit: 'GRAM',
      changeType: 'MANUAL_DEDUCT'
    });
    expect(adjusted.statusCode).toBe(200);
    expect(adjusted.json().data.batch.expiryDate).toBe('2029-09-09');
    expect(adjusted.json().data.batch.quantity).toBe(60);
  });

  it('adjust 传 null 清除到期日，重新查询后保持为空且版本冲突语义不变', async () => {
    const ingredient = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/ingredients',
        payload: {
          name: '到期日清除大米',
          unit: 'GRAM',
          batches: [{ quantity: 300, unit: 'GRAM', expiryDate: '2027-03-03' }]
        }
      })
    ).json().data;
    let batch = ingredient.inventoryBatches[0];

    const modified = await adjust(ingredient.id, {
      batchId: batch.id,
      batchVersion: batch.version,
      quantity: 0,
      unit: 'GRAM',
      changeType: 'ADJUST',
      expiryDate: '2027-05-05'
    });
    expect(modified.statusCode).toBe(200);
    batch = modified.json().data.batch;

    const cleared = await adjust(ingredient.id, {
      batchId: batch.id,
      batchVersion: batch.version,
      quantity: 0,
      unit: 'GRAM',
      changeType: 'ADJUST',
      expiryDate: null
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.batch.expiryDate).toBeNull();

    const reloaded = await app.inject({ method: 'GET', url: `/api/v1/ingredients/${ingredient.id}` });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json().data.expiryDate).toBeNull();
    expect(reloaded.json().data.inventoryBatches[0].expiryDate).toBeNull();
    expect(reloaded.json().data.inventoryBatches[0].quantity).toBe(300);

    const stale = await adjust(ingredient.id, {
      batchId: batch.id,
      batchVersion: 1,
      quantity: -10,
      unit: 'GRAM',
      changeType: 'MANUAL_DEDUCT'
    });
    expect(stale.statusCode).toBe(409);
  });

  it('新批次分支仍拒绝数量 0', async () => {
    const ingredient = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/ingredients',
        payload: { name: '到期日守卫白糖', unit: 'GRAM' }
      })
    ).json().data;
    const rejected = await adjust(ingredient.id, {
      quantity: 0,
      unit: 'GRAM',
      changeType: 'MANUAL_ADD',
      expiryDate: '2027-07-07'
    });
    expect(rejected.statusCode).toBe(400);
  });
});
