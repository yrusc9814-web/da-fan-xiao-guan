import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerDinerRoutes } from '../src/modules/diners/routes.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';

const database = createTestPrismaClient();
let app: FastifyInstance;

describe('食用者 API', () => {
  beforeAll(async () => {
    await database.$connect();
    app = Fastify({ logger: false });
    registerErrorHandlers(app);
    await registerDinerRoutes(app, database);
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it('创建、读取、搜索和更新食用者', async () => {
    const createdResponse = await app.inject({
      method: 'POST', url: '/api/v1/diners',
      payload: { name: '节点B食用者甲', likesText: '清淡', tabooText: '香菜', portionNote: '小份' }
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json().data;

    const list = await app.inject({ method: 'GET', url: '/api/v1/diners?search=%E8%8A%82%E7%82%B9B%E9%A3%9F%E7%94%A8%E8%80%85%E7%94%B2&active=true' });
    expect(list.json().data.items.map((diner: { id: string }) => diner.id)).toContain(created.id);

    const update = await app.inject({
      method: 'PUT', url: `/api/v1/diners/${created.id}`, payload: { allergyText: '花生', version: 1 }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data).toMatchObject({ allergyText: '花生', version: 2 });

    const detail = await app.inject({ method: 'GET', url: `/api/v1/diners/${created.id}` });
    expect(detail.json().data).toMatchObject({ id: created.id, planCount: 0, recordCount: 0 });
  });

  it('过期版本更新返回 409', async () => {
    const diner = await database.diner.create({ data: { name: '节点B并发食用者' } });
    await app.inject({ method: 'PUT', url: `/api/v1/diners/${diner.id}`, payload: { notes: '第一次', version: 1 } });
    const conflict = await app.inject({ method: 'PUT', url: `/api/v1/diners/${diner.id}`, payload: { notes: '过期', version: 1 } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('VERSION_CONFLICT');
  });

  it('删除操作仅停用食用者并保留数据', async () => {
    const diner = await database.diner.create({ data: { name: '节点B停用食用者' } });
    const response = await app.inject({ method: 'DELETE', url: `/api/v1/diners/${diner.id}`, payload: { version: 1 } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ active: false, version: 2 });
    expect(await database.diner.findUnique({ where: { id: diner.id } })).not.toBeNull();
  });

  it('拒绝空姓名', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/diners', payload: { name: '   ' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});
