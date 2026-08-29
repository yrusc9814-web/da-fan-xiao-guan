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

const recordBodySchema = {
  type: 'object',
  required: ['recordDate', 'mealType', 'sourceType'],
  properties: {
    recordDate: stringSchema,
    recordTime: nullableStringSchema,
    mealType: mealTypeSchema,
    sourceType: recordSourceTypeSchema,
    status: recordStatusSchema,
    imagePath: nullableStringSchema,
    rating: { type: ['number', 'null'], minimum: 0, maximum: 5 },
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
  app.post('/api/v1/records', { schema: { body: recordBodySchema } }, async (request, reply) =>
    reply.code(201).send(success(await createRecord(database, request.body as RecordInput)))
  );
  app.get('/api/v1/records/:id', async (request) =>
    success(await getRecord(database, (request.params as { id: string }).id))
  );
  app.put('/api/v1/records/:id', { schema: { body: recordUpdateBodySchema } }, async (request) => {
    const { version, ...input } = request.body as Partial<RecordInput> & { version: number };
    return success(await updateRecord(database, (request.params as { id: string }).id, version, input));
  });
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
