import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveUploadsDirectory } from '../src/database/paths.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerRecipeRoutes } from '../src/modules/recipes/routes.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';
import type { MealType } from '@prisma/client';

const database = createTestPrismaClient();
const uploads = resolveUploadsDirectory();
let app: FastifyInstance;
let recipeId: string;
const photo = '/uploads/google2-cook-form-contract-test.jpg';

async function post(payload: Record<string, unknown>) {
  const response = await app.inject({ method: 'POST', url: `/api/v1/recipes/${recipeId}/cook-checkin`, payload });
  return { statusCode: response.statusCode, body: response.json() };
}

describe('Google2 cook-checkin 表单字段契约', () => {
  beforeAll(async () => {
    await database.$connect();
    await mkdir(uploads, { recursive: true });
    await writeFile(resolve(uploads, 'google2-cook-form-contract-test.jpg'), Buffer.from('test-photo'));
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerRecipeRoutes(app, database);
    await registerMealRecordRoutes(app, database);
    const asset = await database.uploadAsset.create({
      data: {
        filename: 'google2-cook-form-contract-test.jpg',
        storagePath: 'google2-cook-form-contract-test.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 10,
        sha256: 'google2-cook-form-contract-test'
      }
    });
    const recipe = await database.recipe.create({ data: { name: 'cook form contract recipe' } });
    recipeId = recipe.id;
    expect(asset.id).toBeTruthy();
  });

  afterAll(async () => {
    const records = await database.mealRecord.findMany({
      where: { items: { some: { recipeId } } },
      select: { id: true }
    });
    await database.mealRecordDiner.deleteMany({ where: { mealRecordId: { in: records.map(({ id }) => id) } } });
    await database.mealRecordItem.deleteMany({ where: { mealRecordId: { in: records.map(({ id }) => id) } } });
    await database.mealRecord.deleteMany({ where: { id: { in: records.map(({ id }) => id) } } });
    await database.recipe.delete({ where: { id: recipeId } });
    await database.uploadAsset.deleteMany({ where: { filename: 'google2-cook-form-contract-test.jpg' } });
    await rm(resolve(uploads, 'google2-cook-form-contract-test.jpg'), { force: true });
    await app.close();
    await database.$disconnect();
  });

  it('原子保存照片顺序/首图、null 与省略语义，重复同 payload 200，冲突 409', async () => {
    const payload = {
      recordDate: '2046-01-02',
      mealType: 'DINNER',
      recordTime: '19:20',
      title: null,
      photos: [photo],
      notes: '真实表单备注',
      calories: null,
      rating: null,
      satiety: null,
      cost: null,
      dinerIds: [],
      sourceType: 'TAKEOUT'
    };
    const first = await post(payload);
    expect(first.statusCode).toBe(201);
    expect(first.body.data.record.photos).toEqual([photo]);
    expect(first.body.data.record.imagePath).toBe(photo);
    expect(first.body.data.record.sourceType).toBe('TAKEOUT');
    expect((await database.mealRecord.findUniqueOrThrow({ where: { id: first.body.data.record.id } })).photosJson).toBe(
      JSON.stringify([photo])
    );

    const repeated = await post(payload);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.body.data.repeated).toBe(true);
    expect(repeated.body.data.record.id).toBe(first.body.data.record.id);

    const conflict = await post({ ...payload, notes: '不同用户输入' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.error.message).toContain('已有不同内容');
    expect(await database.mealRecord.count({ where: { recordDate: '2046-01-02', mealType: 'DINNER' } })).toBe(1);
    const changedSource = await post({ ...payload, sourceType: 'DINE_IN' });
    expect(changedSource.statusCode).toBe(409);
  });

  it('同 payload 并发只创建一条，sourceType 不同并发返回冲突', async () => {
    const payload: { recordDate: string; mealType: MealType; sourceType: string } = {
      recordDate: '2046-01-08',
      mealType: 'DINNER',
      sourceType: 'CUSTOM'
    };
    const [first, second] = await Promise.all([post(payload), post(payload)]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
    expect(
      await database.mealRecord.count({ where: { recordDate: payload.recordDate, mealType: payload.mealType } })
    ).toBe(1);

    const differentPayload: { recordDate: string; mealType: MealType; sourceType: string } = {
      recordDate: '2046-01-09',
      mealType: 'DINNER',
      sourceType: 'TAKEOUT'
    };
    const [created, conflict] = await Promise.all([
      post({ ...differentPayload, sourceType: 'HOMEMADE' }),
      post(differentPayload)
    ]);
    expect([created.statusCode, conflict.statusCode].sort()).toEqual([201, 409]);
    expect(
      await database.mealRecord.count({
        where: { recordDate: differentPayload.recordDate, mealType: differentPayload.mealType }
      })
    ).toBe(1);
  });

  it('省略 sourceType 兼容 HOMEMADE，非法 sourceType 400 且不写入', async () => {
    const legacy = await post({ recordDate: '2046-01-06', mealType: 'BREAKFAST' });
    expect(legacy.statusCode).toBe(201);
    expect(legacy.body.data.record.sourceType).toBe('HOMEMADE');
    const invalid = await post({ recordDate: '2046-01-07', mealType: 'BREAKFAST', sourceType: 'DELIVERY' });
    expect(invalid.statusCode).toBe(400);
    expect(await database.mealRecord.count({ where: { recordDate: '2046-01-07', mealType: 'BREAKFAST' } })).toBe(0);
  });

  it('title 可真实持久化并参与幂等，data URL 与未知字段仍 fail-closed', async () => {
    const titled = await post({ recordDate: '2046-01-03', mealType: 'LUNCH', title: ' 用户标题 ' });
    expect(titled.statusCode).toBe(201);
    expect(titled.body.data.record.title).toBe('用户标题');
    const repeated = await post({ recordDate: '2046-01-03', mealType: 'LUNCH', title: '用户标题' });
    expect(repeated.statusCode).toBe(200);
    const conflict = await post({ recordDate: '2046-01-03', mealType: 'LUNCH', title: '另一个标题' });
    expect(conflict.statusCode).toBe(409);
    for (const body of [
      { recordDate: '2046-01-04', mealType: 'LUNCH', photos: ['data:image/jpeg;base64,abc'] },
      { recordDate: '2046-01-05', mealType: 'LUNCH', imagePath: photo }
    ]) {
      const response = await post(body);
      expect(response.statusCode).toBe(400);
    }
  });
});
