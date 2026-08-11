import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createTestPrismaClient } from '../src/database/test-database.js';

const database = createTestPrismaClient();
let app: Awaited<ReturnType<typeof buildApp>>;
describe('饮食记录收藏', () => {
  beforeAll(async () => {
    await database.$connect();
    app = await buildApp({ database, logger: false });
  });
  afterAll(async () => {
    await app.close();
  });
  it('使用 version 条件更新并拒绝陈旧请求', async () => {
    const record = await database.mealRecord.create({
      data: { recordDate: '2048-01-01', mealType: 'DINNER', sourceType: 'CUSTOM' }
    });
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/records/${record.id}/favorite`,
      payload: { version: record.version, favorite: true }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.favorite).toBe(true);
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/records/${record.id}/favorite`,
      payload: { version: record.version, favorite: false }
    });
    expect(stale.statusCode).toBe(409);
    expect((await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } })).favorite).toBe(true);
  });
});
