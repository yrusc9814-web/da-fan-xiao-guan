import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveUploadsDirectory } from '../src/database/paths.js';

import Fastify, { type FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerMealPlanRoutes } from '../src/modules/meal-plans/routes.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';
import { registerUploadRoutes } from '../src/modules/uploads/routes.js';

// Google2 第二轮多图（MealRecord.photosJson / DTO photos）：
// - 最多 3 张有序真实 /uploads 路径；落库 JSON.stringify 规范串，首张同步 imagePath；
// - null 或 [] 明确清空 photosJson=null、imagePath=null；省略保留；旧 imagePath 保真映射 photos；
// - 非法类型/超过 3/data URL/路径逃逸/非本服务上传 → 400 快速失败、不落库；
// - GET/list/update 与计划完成生成记录统一返回 photos；
// - uploads 删除引用检查覆盖全部 photos（第 2/3 张不再被误删），并兼容旧字段。
const database = createTestPrismaClient();
const uploadsRoot = resolveUploadsDirectory();

const RECORD_FROM = '2045-05-01';
const RECORD_TO = '2045-05-31';

let app: FastifyInstance;
const createdAssetIds: string[] = [];

async function cleanup(): Promise<void> {
  const records = await database.mealRecord.findMany({
    where: { recordDate: { gte: RECORD_FROM, lte: RECORD_TO } },
    select: { id: true }
  });
  const recordIds = records.map(({ id }) => id);
  await database.mealRecordDiner.deleteMany({ where: { mealRecordId: { in: recordIds } } });
  await database.mealRecordItem.deleteMany({ where: { mealRecordId: { in: recordIds } } });
  await database.mealRecord.deleteMany({ where: { id: { in: recordIds } } });
  const plans = await database.mealPlan.findMany({
    where: { planDate: { gte: RECORD_FROM, lte: RECORD_TO } },
    select: { id: true }
  });
  const planIds = plans.map(({ id }) => id);
  await database.mealPlanDiner.deleteMany({ where: { mealPlanId: { in: planIds } } });
  await database.mealPlanItem.deleteMany({ where: { mealPlanId: { in: planIds } } });
  await database.deletedItem.deleteMany({
    where: { entityType: 'MealRecord', entityId: { in: recordIds } }
  });
  await database.mealPlan.deleteMany({ where: { id: { in: planIds } } });

  const assets = await database.uploadAsset.findMany({ where: { id: { in: createdAssetIds } } });
  for (const asset of assets) {
    await rm(resolve(uploadsRoot, asset.storagePath), { force: true });
    if (asset.thumbnailPath) await rm(resolve(uploadsRoot, asset.thumbnailPath), { force: true });
  }
  await database.uploadAsset.deleteMany({ where: { id: { in: createdAssetIds } } });
  createdAssetIds.length = 0;
}

function multipart(filename: string, mime: string, data: Buffer) {
  const boundary = '----dafan-google2-photos-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

async function uploadPhoto(label: string): Promise<{ id: string; url: string }> {
  const png = await sharp({
    create: { width: 12, height: 12, channels: 4, background: { r: 250, g: 200, b: 215, alpha: 1 } }
  })
    .png()
    .toBuffer();
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/uploads/images',
    ...multipart(`${label}.png`, 'image/png', png)
  });
  expect(response.statusCode).toBe(201);
  const asset = response.json().data as { id: string; url: string };
  createdAssetIds.push(asset.id);
  return asset;
}

const recordPayload = (overrides: Record<string, unknown> = {}) => ({
  recordDate: '2045-05-10',
  mealType: 'LUNCH',
  sourceType: 'HOMEMADE',
  ...overrides
});

describe('Google2 记录多图 photos（photosJson 读写、清空、引用检查）', () => {
  beforeAll(async () => {
    await mkdir(resolve(uploadsRoot, 'thumbnails'), { recursive: true });
    await database.$connect();
    await cleanup();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerMealPlanRoutes(app, database);
    await registerMealRecordRoutes(app, database);
    await registerUploadRoutes(app, database);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await database.$disconnect();
  });

  it('三张真实上传：规范 JSON、首张 imagePath、GET/list/update 顺序完整一致', async () => {
    const photoA = await uploadPhoto('a');
    const photoB = await uploadPhoto('b');
    const photoC = await uploadPhoto('c');
    const photos = [photoA.url, photoB.url, photoC.url];

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: recordPayload({ photos, notes: '三张图记录' })
    });
    expect(created.statusCode).toBe(201);
    const record = created.json().data as {
      id: string;
      version: number;
      photos: string[] | null;
      imagePath: string | null;
    };
    expect(record.photos).toEqual(photos);
    expect(record.imagePath).toBe(photoA.url);

    // 落库 canonical JSON（无空格、顺序一致），不是响应层伪装
    const row = await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(row.photosJson).toBe(JSON.stringify(photos));
    expect(row.imagePath).toBe(photoA.url);

    const read = await app.inject({ method: 'GET', url: `/api/v1/records/${record.id}` });
    expect(read.json().data.photos).toEqual(photos);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/records?from=${RECORD_FROM}&to=${RECORD_TO}&pageSize=100`
    });
    const fromList = (listed.json().data.items as Array<{ id: string; photos: string[] | null }>).find(
      (item) => item.id === record.id
    );
    expect(fromList?.photos).toEqual(photos);

    // update 省略 photos → 顺序保留；只换第 2 张 → 新顺序完整落库
    const kept = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${record.id}`,
      payload: { version: record.version, notes: '只改备注' }
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().data.photos).toEqual(photos);
    expect((await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } })).photosJson).toBe(
      JSON.stringify(photos)
    );

    const photoD = await uploadPhoto('d');
    const reordered = [photoB.url, photoD.url];
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${record.id}`,
      payload: { version: kept.json().data.version, photos: reordered }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.photos).toEqual(reordered);
    expect(updated.json().data.imagePath).toBe(photoB.url);
    const rowAfter = await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(rowAfter.photosJson).toBe(JSON.stringify(reordered));
    expect(rowAfter.imagePath).toBe(photoB.url);
  });

  it('旧单图 imagePath 保真映射 photos；没有照片时为 null 而不是 []', async () => {
    const legacy = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: recordPayload({ recordDate: '2045-05-11', imagePath: '/uploads/legacy-single.jpg' })
    });
    expect(legacy.statusCode).toBe(201);
    // 旧单图没有 photos 输入 → photosJson 保持 NULL，读取侧回退 [imagePath]
    expect(legacy.json().data.photos).toEqual(['/uploads/legacy-single.jpg']);
    const legacyRow = await database.mealRecord.findUniqueOrThrow({ where: { id: legacy.json().data.id } });
    expect(legacyRow.photosJson).toBeNull();
    expect(legacyRow.imagePath).toBe('/uploads/legacy-single.jpg');

    const noPhotos = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: recordPayload({ recordDate: '2045-05-12' })
    });
    expect(noPhotos.statusCode).toBe(201);
    expect(noPhotos.json().data.photos).toBeNull();
    expect(noPhotos.json().data.imagePath).toBeNull();
    const emptyRow = await database.mealRecord.findUniqueOrThrow({ where: { id: noPhotos.json().data.id } });
    expect(emptyRow.photosJson).toBeNull();

    // 库内不存在 '' / '[]' 假数据
    expect(await database.mealRecord.count({ where: { OR: [{ photosJson: '' }, { photosJson: '[]' }] } })).toBe(0);
  });

  it('photos=null 与 photos=[] 都明确清空 photosJson 与 imagePath（省略则保留）', async () => {
    const photo = await uploadPhoto('clear');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: recordPayload({ recordDate: '2045-05-13', photos: [photo.url] })
    });
    expect(created.statusCode).toBe(201);
    const record = created.json().data as { id: string; version: number };

    const clearedByArray = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${record.id}`,
      payload: { version: record.version, photos: [] }
    });
    expect(clearedByArray.statusCode).toBe(200);
    expect(clearedByArray.json().data.photos).toBeNull();
    expect(clearedByArray.json().data.imagePath).toBeNull();
    let row = await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(row.photosJson).toBeNull();
    expect(row.imagePath).toBeNull();

    // 重新写入后再用显式 null 清空
    const rewrote = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${record.id}`,
      payload: { version: clearedByArray.json().data.version, photos: [photo.url] }
    });
    expect(rewrote.statusCode).toBe(200);
    const clearedByNull = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${record.id}`,
      payload: { version: rewrote.json().data.version, photos: null }
    });
    expect(clearedByNull.statusCode).toBe(200);
    expect(clearedByNull.json().data).toMatchObject({ photos: null, imagePath: null });
    row = await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(row).toMatchObject({ photosJson: null, imagePath: null });
  });

  it('非法输入快速失败：超过 3 张 / data URL / 路径逃逸 / 非字符串 / 非本服务上传 / 未知字段', async () => {
    const photoA = await uploadPhoto('bad-a');
    const photoB = await uploadPhoto('bad-b');
    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: recordPayload({
        recordDate: '2045-05-14',
        photos: [photoA.url, photoB.url, '/uploads/x1.jpg', '/uploads/x2.jpg']
      })
    });
    expect(tooMany.statusCode).toBe(400);

    const cases: Array<[string, unknown]> = [
      ['data URL base64', ['data:image/png;base64,iVBORw0KGgo=']],
      ['路径逃逸', ['/uploads/../../data/app.db']],
      ['非字符串元素', [123]],
      ['空字符串元素', ['']],
      ['非本服务上传（伪造路径）', ['/uploads/not-owned-0000.jpg']],
      ['未删除的伪造缩略图路径', ['/uploads/thumbnails/not-owned.webp']]
    ];
    for (const [label, photos] of cases) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/records',
        payload: recordPayload({ recordDate: '2045-05-14', photos })
      });
      expect(response.statusCode, label).toBe(400);
    }

    const unknownField = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: recordPayload({ recordDate: '2045-05-14', photoSlots: ['x'] })
    });
    expect(unknownField.statusCode).toBe(400);

    const stringPhotos = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: recordPayload({ recordDate: '2045-05-14', photos: photoA.url })
    });
    expect(stringPhotos.statusCode).toBe(400);

    expect(await database.mealRecord.count({ where: { recordDate: '2045-05-14' } })).toBe(0);
  });

  it('update 乐观锁与非法 photos 不改既有值；未知字段 PUT 400', async () => {
    const photo = await uploadPhoto('lock');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: recordPayload({ recordDate: '2045-05-15', photos: [photo.url] })
    });
    const record = created.json().data as { id: string; version: number };

    // 先做一次合法更新，让库内 version 前进到 2；随后用旧 version=1 触发乐观锁 409
    const bumped = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${record.id}`,
      payload: { version: record.version, notes: '推进版本' }
    });
    expect(bumped.statusCode).toBe(200);
    const bumpedVersion = (bumped.json().data as { version: number }).version;

    const stale = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${record.id}`,
      payload: { version: record.version, photos: [] }
    });
    expect(stale.statusCode).toBe(409);

    const invalid = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${record.id}`,
      payload: { version: bumpedVersion, photos: ['data:image/png;base64,AAAA'] }
    });
    expect(invalid.statusCode).toBe(400);

    const unknownPut = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${record.id}`,
      payload: { version: bumpedVersion, photos: [], junkField: 1 }
    });
    expect(unknownPut.statusCode).toBe(400);

    const row = await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(row.photosJson).toBe(JSON.stringify([photo.url]));
    expect(row.version).toBe(bumpedVersion);
  });

  it('计划完成生成的记录统一返回 photos 契约（null 不虚造）', async () => {
    const plan = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      payload: {
        planDate: '2045-05-16',
        mealType: 'DINNER',
        dinerCount: 1,
        items: [{ itemType: 'CUSTOM', customName: '多图契约计划餐', sortOrder: 0 }]
      }
    });
    expect(plan.statusCode).toBe(201);
    const planData = plan.json().data as { id: string; version: number };

    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${planData.id}/complete`,
      payload: { version: planData.version }
    });
    expect(completed.statusCode).toBe(200);
    const record = completed.json().data.record as { id: string; photos: string[] | null; imagePath: string | null };
    expect(record.photos).toBeNull();
    expect(record.imagePath).toBeNull();

    // 刷新后同一契约（GET/list 不因 raw 返回差异丢字段）
    const fetched = await app.inject({ method: 'GET', url: `/api/v1/records/${record.id}` });
    expect(fetched.json().data).toMatchObject({ photos: null, imagePath: null });
  });

  it('uploads 删除引用检查覆盖全部 photos：第 2/3 张被引用时 409，清空后可删；旧 imagePath 语义保留', async () => {
    const photoA = await uploadPhoto('ref-a');
    const photoB = await uploadPhoto('ref-b');
    const photoC = await uploadPhoto('ref-c');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: recordPayload({ recordDate: '2045-05-17', photos: [photoA.url, photoB.url, photoC.url] })
    });
    expect(created.statusCode).toBe(201);
    const record = created.json().data as { id: string; version: number };

    // 三张全部被引用 → 全部 409（修复前第 2/3 张会 200 并删掉文件）
    for (const asset of [photoA, photoB, photoC]) {
      const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/uploads/images/${asset.id}` });
      expect(blocked.statusCode).toBe(409);
      expect((blocked.json().error as { code: string }).code).toBe('REFERENCED_RESOURCE');
    }
    // 文件仍在磁盘可访问
    const served = await app.inject({ method: 'GET', url: photoB.url });
    expect(served.statusCode).toBe(200);

    // 记录清空多图后，三张都可删除（不再误保护，也不再误删他图）
    const cleared = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${record.id}`,
      payload: { version: record.version, photos: [] }
    });
    expect(cleared.statusCode).toBe(200);
    for (const asset of [photoA, photoB, photoC]) {
      const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/uploads/images/${asset.id}` });
      expect(deleted.statusCode).toBe(200);
    }

    // 旧单图 imagePath 引用仍然保护（兼容旧字段，不删用户图片）
    const legacyPhoto = await uploadPhoto('ref-legacy');
    const legacyRecord = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: recordPayload({ recordDate: '2045-05-18', imagePath: legacyPhoto.url })
    });
    expect(legacyRecord.statusCode).toBe(201);
    const legacyBlocked = await app.inject({ method: 'DELETE', url: `/api/v1/uploads/images/${legacyPhoto.id}` });
    expect(legacyBlocked.statusCode).toBe(409);
  });
});
