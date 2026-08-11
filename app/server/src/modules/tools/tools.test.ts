import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../../database/test-database.js';
import { registerErrorHandlers } from '../../plugins/error-handler.js';
import { registerToolRoutes } from './routes.js';

const database = createTestPrismaClient();
const app = Fastify({ logger: false });

describe('厨房工具 API', () => {
  beforeAll(async () => {
    await database.$connect();
    registerErrorHandlers(app);
    await registerToolRoutes(app, database);
  });
  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it('支持 CRUD、软删除和版本冲突', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tools',
      payload: { name: '测试电饭锅', quantity: 1, status: 'AVAILABLE' }
    });
    expect(created.statusCode).toBe(201);
    const tool = created.json().data;
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/tools/${tool.id}`,
      payload: { version: tool.version, name: '测试电饭锅', quantity: 2, status: 'AVAILABLE' }
    });
    expect(updated.json().data.version).toBe(2);
    const conflict = await app.inject({
      method: 'PUT',
      url: `/api/v1/tools/${tool.id}`,
      payload: { version: 1, name: '冲突', quantity: 1 }
    });
    expect(conflict.statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/tools/${tool.id}?version=2` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/tools/${tool.id}` })).statusCode).toBe(404);
  });
});
