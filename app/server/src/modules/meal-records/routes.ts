import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import {
  booleanSchema,
  isoDateQuerySchema,
  mealTypeSchema,
  positiveIntQuerySchema,
  nullableMealRoleSchema,
  nullableStringSchema,
  recordItemTypeSchema,
  recordSourceTypeSchema,
  recordStatusSchema,
  stringListSchema,
  stringSchema,
  versionBodySchema,
  versionQuerySchema
} from '../../shared/validation-schemas.js';
import {
  confirmRecord,
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  setRecordFavorite,
  updateRecord,
  type RecordInput
} from './service.js';

const recordItemSchema = {
  type: 'object',
  required: ['itemType'],
  properties: {
    itemType: recordItemTypeSchema,
    mealRole: nullableMealRoleSchema,
    recipeId: nullableStringSchema,
    storeId: nullableStringSchema,
    customName: nullableStringSchema,
    sortOrder: { type: 'integer' }
  }
};

/** 饱腹度：前端正式档位（三分 / 五分 / 七分 / 八分 / 十分），旧演示值 4 不纳入正式契约。 */
const satietySchema = { type: ['integer', 'null'], enum: [3, 5, 7, 8, 10, null] };

/** 摄入热量（kcal）：非负整数，UI 未设上下界，不擅自加上限。 */
const recordCaloriesSchema = { type: ['integer', 'null'], minimum: 0 };

/** 就餐消费（元）：0..9999 整数。 */
const recordCostSchema = { type: ['integer', 'null'], minimum: 0, maximum: 9999 };

/**
 * 多图照片：0..3 张有序相对路径（第 1 张为封面），或 null/[] 表示清空，省略表示保留。
 * 只做形状级校验（类型/张数/长度）；/uploads 路径形态、data URL 禁止、上传归属与
 * 文件存在性由 service 快速失败（route 正则无法证明“这张图真实上传过”）。
 */
const recordPhotosSchema = {
  type: ['array', 'null'],
  maxItems: 3,
  items: { type: 'string', maxLength: 300 }
};

const recordBodySchema = {
  type: 'object',
  required: ['recordDate', 'mealType', 'sourceType'],
  properties: {
    recordDate: stringSchema,
    recordTime: nullableStringSchema,
    title: { type: ['string', 'null'], maxLength: 200 },
    mealType: mealTypeSchema,
    sourceType: recordSourceTypeSchema,
    status: recordStatusSchema,
    imagePath: nullableStringSchema,
    photos: recordPhotosSchema,
    rating: { type: ['number', 'null'], minimum: 0, maximum: 5 },
    satiety: satietySchema,
    calories: recordCaloriesSchema,
    cost: recordCostSchema,
    isNewTry: booleanSchema,
    favorite: booleanSchema,
    notes: nullableStringSchema,
    relatedPlanId: nullableStringSchema,
    items: { type: 'array', items: recordItemSchema },
    dinerIds: stringListSchema
  }
};

const recordUpdateBodySchema = {
  type: 'object',
  required: ['version'],
  properties: { ...recordBodySchema.properties, version: versionBodySchema }
};

/**
 * 记录写入 body 的允许字段。Fastify 默认 AJV 会静默剥离未知字段（removeAdditional），
 * 与“未知字段 fail-closed 快速失败”的契约冲突；preValidation 在 AJV 校验之前执行，
 * 可看到原始解析后的 body（与 ingredients / recipes / tools 同一既有模式）。
 */
const recordAllowedKeys: readonly string[] = [
  'recordDate',
  'recordTime',
  'title',
  'mealType',
  'sourceType',
  'status',
  'imagePath',
  'photos',
  'rating',
  'satiety',
  'calories',
  'cost',
  'isNewTry',
  'favorite',
  'notes',
  'relatedPlanId',
  'items',
  'dinerIds'
];
const recordUpdateAllowedKeys: readonly string[] = [...recordAllowedKeys, 'version'];

function assertRecordKeys(body: unknown, allowed: readonly string[]): void {
  if (!body || typeof body !== 'object') return;
  const unknown = Object.keys(body as Record<string, unknown>).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw Object.assign(new Error(`请求包含未支持的字段：${unknown.join(', ')}`), { statusCode: 400 });
  }
}

const versionBodyWrapper = { type: 'object', required: ['version'], properties: { version: versionBodySchema } };
const versionQueryWrapper = { type: 'object', required: ['version'], properties: { version: versionQuerySchema } };
const recordListQuerySchema = {
  type: 'object',
  properties: {
    from: isoDateQuerySchema,
    to: isoDateQuerySchema,
    sourceType: recordSourceTypeSchema,
    mealType: mealTypeSchema,
    status: recordStatusSchema,
    minRating: { type: 'string', pattern: '^(?:[0-4](?:\\.[0-9]+)?|5(?:\\.0+)?)$' },
    dinerId: stringSchema,
    q: stringSchema,
    page: positiveIntQuerySchema,
    pageSize: positiveIntQuerySchema
  }
};

export async function registerMealRecordRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get('/api/v1/records', { schema: { querystring: recordListQuerySchema } }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return success(
      await listRecords(database, {
        from: query.from,
        to: query.to,
        sourceType: query.sourceType as Parameters<typeof listRecords>[1]['sourceType'],
        mealType: query.mealType as Parameters<typeof listRecords>[1]['mealType'],
        status: query.status as Parameters<typeof listRecords>[1]['status'],
        minRating: query.minRating,
        dinerId: query.dinerId,
        q: query.q,
        page: query.page ? Number(query.page) : undefined,
        pageSize: query.pageSize ? Number(query.pageSize) : undefined
      })
    );
  });
  app.post(
    '/api/v1/records',
    {
      schema: { body: recordBodySchema },
      preValidation: async (request) => assertRecordKeys(request.body, recordAllowedKeys)
    },
    async (request, reply) => reply.code(201).send(success(await createRecord(database, request.body as RecordInput)))
  );
  app.get('/api/v1/records/:id', async (request) =>
    success(await getRecord(database, (request.params as { id: string }).id))
  );
  app.put(
    '/api/v1/records/:id',
    {
      schema: { body: recordUpdateBodySchema },
      preValidation: async (request) => assertRecordKeys(request.body, recordUpdateAllowedKeys)
    },
    async (request) => {
      const { version, ...input } = request.body as Partial<RecordInput> & { version: number };
      return success(await updateRecord(database, (request.params as { id: string }).id, version, input));
    }
  );
  app.delete('/api/v1/records/:id', { schema: { querystring: versionQueryWrapper } }, async (request) =>
    success(
      await deleteRecord(
        database,
        (request.params as { id: string }).id,
        Number((request.query as { version: string }).version)
      )
    )
  );
  app.post('/api/v1/records/:id/confirm', { schema: { body: versionBodyWrapper } }, async (request) =>
    success(
      await confirmRecord(
        database,
        (request.params as { id: string }).id,
        (request.body as { version: number }).version
      )
    )
  );
  app.post(
    '/api/v1/records/:id/favorite',
    {
      schema: {
        body: {
          type: 'object',
          required: ['version', 'favorite'],
          properties: { version: versionBodySchema, favorite: booleanSchema }
        }
      }
    },
    async (request) => {
      const body = request.body as { version: number; favorite: boolean };
      return success(
        await setRecordFavorite(database, (request.params as { id: string }).id, body.version, body.favorite)
      );
    }
  );
}
