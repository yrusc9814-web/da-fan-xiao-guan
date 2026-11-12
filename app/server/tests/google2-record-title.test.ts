import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveUploadsDirectory } from '../src/database/paths.js';

import Fastify, { type FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';
import { registerRecipeRoutes } from '../src/modules/recipes/routes.js';
import { registerUploadRoutes } from '../src/modules/uploads/routes.js';

const database = createTestPrismaClient();
const uploadsRoot = resolveUploadsDirectory();
let app: FastifyInstance;
const recordIds: string[] = [];
const recipeIds: string[] = [];
const dinerIds: string[] = [];
const assetIds: string[] = [];

function multipart(filename: string, data: Buffer) {
  const boundary = '----google2-title-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

async function upload(label: string) {
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#f5c2d8' } })
    .png()
    .toBuffer();
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/uploads/images',
    ...multipart(`${label}.png`, png)
  });
  expect(response.statusCode).toBe(201);
  const data = response.json().data as { id: string; url: string };
  assetIds.push(data.id);
  return data.url;
}

const base = (extra: Record<string, unknown> = {}) => ({
  recordDate: '2046-01-10',
  mealType: 'LUNCH',
  sourceType: 'HOMEMADE',
  ...extra
});

beforeAll(async () => {
  await mkdir(resolve(uploadsRoot, 'thumbnails'), { recursive: true });
  await database.$connect();
  app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
  registerErrorHandlers(app);
  await registerMealRecordRoutes(app, database);
  await registerRecipeRoutes(app, database);
  await registerUploadRoutes(app, database);
});

afterAll(async () => {
  if (recordIds.length) {
    await database.mealRecordDiner.deleteMany({ where: { mealRecordId: { in: recordIds } } });
    await database.mealRecordItem.deleteMany({ where: { mealRecordId: { in: recordIds } } });
    await database.mealRecord.deleteMany({ where: { id: { in: recordIds } } });
  }
  if (recipeIds.length) {
    await database.recipeIngredient.deleteMany({ where: { recipeId: { in: recipeIds } } });
    await database.recipe.deleteMany({ where: { id: { in: recipeIds } } });
  }
  if (dinerIds.length) await database.diner.deleteMany({ where: { id: { in: dinerIds } } });
  for (const asset of await database.uploadAsset.findMany({ where: { id: { in: assetIds } } })) {
    await rm(resolve(uploadsRoot, asset.storagePath), { force: true });
    if (asset.thumbnailPath) await rm(resolve(uploadsRoot, asset.thumbnailPath), { force: true });
  }
  await database.uploadAsset.deleteMany({ where: { id: { in: assetIds } } });
  await app.close();
  await database.$disconnect();
});

describe('Google2 MealRecord.title API 契约', () => {
  it('真实上传照片、recipe item、diner 后 create/list/detail 与 title 完整持久化', async () => {
    const recipe = await database.recipe.create({
      data: { name: 'title-contract-recipe', favorite: false, enabledForRecommendation: true }
    });
    recipeIds.push(recipe.id);
    const diner = await database.diner.create({ data: { name: 'title-contract-diner' } });
    dinerIds.push(diner.id);
    const photos = [await upload('title-a'), await upload('title-b')];
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: base({
        title: '  晚餐标题  ',
        photos,
        items: [{ itemType: 'RECIPE', recipeId: recipe.id, sortOrder: 0 }],
        dinerIds: [diner.id]
      })
    });
    expect(created.statusCode).toBe(201);
    const row = created.json().data;
    recordIds.push(row.id);
    expect(row.title).toBe('晚餐标题');
    expect(row.items[0].recipeId).toBe(recipe.id);
    expect(row.diners[0].dinerId).toBe(diner.id);
    expect(row.photos).toEqual(photos);
    expect((await app.inject({ method: 'GET', url: `/api/v1/records/${row.id}` })).json().data.title).toBe('晚餐标题');
    const listed = (
      await app.inject({ method: 'GET', url: '/api/v1/records?from=2046-01-10&to=2046-01-10&pageSize=100' })
    )
      .json()
      .data.items.find((x: any) => x.id === row.id);
    expect(listed).toMatchObject({ title: '晚餐标题', imagePath: photos[0] });
    expect(listed.items[0].recipeId).toBe(recipe.id);
  });

  it('PUT 只改 title 保留 items/photos/diners；省略保留，null/空白清除', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/records',
        payload: base({ recordDate: '2046-01-11', title: '初始' })
      })
    ).json().data;
    recordIds.push(created.id);
    let response = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${created.id}`,
      payload: { version: created.version, title: '  新标题  ' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.title).toBe('新标题');
    expect(response.json().data.items).toEqual([]);
    response = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${created.id}`,
      payload: { version: response.json().data.version, notes: '保留标题' }
    });
    expect(response.json().data.title).toBe('新标题');
    response = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${created.id}`,
      payload: { version: response.json().data.version, title: null }
    });
    expect(response.json().data.title).toBeNull();
    response = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${created.id}`,
      payload: { version: response.json().data.version, title: '再填' }
    });
    response = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${created.id}`,
      payload: { version: response.json().data.version, title: '   ' }
    });
    expect(response.json().data.title).toBeNull();
  });

  it('边界与 fail-closed：200 字符成功，201/非字符串/未知字段均 400 且不写入', async () => {
    const before = await database.mealRecord.count();
    for (const payload of [
      base({ recordDate: '2046-01-12', title: 'x'.repeat(201) }),
      base({ recordDate: '2046-01-13', title: 123 }),
      { ...base({ recordDate: '2046-01-14' }), unexpected: true }
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/records', payload });
      expect(response.statusCode).toBe(400);
    }
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: base({ recordDate: '2046-01-15', title: 'x'.repeat(200) })
    });
    expect(ok.statusCode).toBe(201);
    recordIds.push(ok.json().data.id);
    expect(await database.mealRecord.count()).toBe(before + 1);
  });
});
