import { MealType, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { success } from '../../shared/http.js';
import {
  booleanSchema,
  mealTypeSchema,
  nullableStringSchema,
  stringSchema,
  versionBodySchema
} from '../../shared/validation-schemas.js';
import {
  createStore,
  deleteStore,
  getStore,
  listStoreCandidates,
  listStores,
  setStoreFavorite,
  StoreRequestError,
  updateStore,
  type StoreAcquisitionMode,
  type StoreCandidateQuery,
  type StoreListQuery,
  type StoreSortBy,
  type StoreUpdateInput,
  type StoreWriteInput
} from './service.js';

type Params = { id: string };
type RawStoreQuery = Record<string, string | undefined>;

const storeBodySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: stringSchema,
    imagePath: nullableStringSchema,
    address: nullableStringSchema,
    storeType: nullableStringSchema,
    cuisine: nullableStringSchema,
    averageCost: { type: ['number', 'null'], minimum: 0 },
    supportsDineIn: booleanSchema,
    supportsTakeout: booleanSchema,
    contact: nullableStringSchema,
    businessHours: nullableStringSchema,
    rating: { type: ['number', 'null'], minimum: 0, maximum: 5 },
    recommendedDishes: nullableStringSchema,
    avoidDishes: nullableStringSchema,
    tagsText: nullableStringSchema,
    notes: nullableStringSchema,
    favorite: booleanSchema,
    mealTypes: { type: 'array', items: mealTypeSchema }
  }
};

const storeUpdateBodySchema = {
  type: 'object',
  required: ['version'],
  properties: { ...storeBodySchema.properties, version: versionBodySchema }
};

function numberValue(value: string | undefined, field: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new StoreRequestError(`${field}必须是数字`);
  return parsed;
}

function booleanValue(value: string | undefined, field: string): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new StoreRequestError(`${field}必须是 true 或 false`);
}

function listValue(value: string | undefined): string[] | undefined {
  return value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function mealTypesValue(value: string | undefined): MealType[] | undefined {
  return listValue(value) as MealType[] | undefined;
}

function parseStoreQuery(query: RawStoreQuery): StoreListQuery {
  const mode = query.mode as StoreAcquisitionMode | undefined;
  if (mode !== undefined && mode !== 'DINE_IN' && mode !== 'TAKEOUT') throw new StoreRequestError('获取方式无效');
  const allowedSorts = new Set<StoreSortBy>(['name', 'averageCost', 'rating', 'createdAt', 'updatedAt', 'lastEaten']);
  const sortBy = query.sortBy as StoreSortBy | undefined;
  if (sortBy !== undefined && !allowedSorts.has(sortBy)) throw new StoreRequestError('排序字段无效');
  if (query.sortOrder !== undefined && query.sortOrder !== 'asc' && query.sortOrder !== 'desc')
    throw new StoreRequestError('排序方向无效');
  return {
    page: numberValue(query.page, '页码'),
    pageSize: numberValue(query.pageSize, '每页数量'),
    search: query.search,
    mode,
    storeType: query.storeType,
    cuisine: query.cuisine,
    minAverageCost: numberValue(query.minAverageCost, '最低人均消费'),
    maxAverageCost: numberValue(query.maxAverageCost, '最高人均消费'),
    minRating: numberValue(query.minRating, '最低评分'),
    tags: listValue(query.tags),
    recentlyEaten: booleanValue(query.recentlyEaten, '最近是否吃过'),
    recentDays: numberValue(query.recentDays, '最近天数'),
    favorite: booleanValue(query.favorite, '收藏状态'),
    mealTypes: mealTypesValue(query.mealTypes),
    sortBy,
    sortOrder: query.sortOrder as 'asc' | 'desc' | undefined
  };
}

function parseCandidateQuery(query: RawStoreQuery): StoreCandidateQuery {
  return {
    acquisitionModes: listValue(query.acquisitionModes) as StoreAcquisitionMode[] | undefined,
    mealTypes: mealTypesValue(query.mealTypes),
    wantedKeywords: listValue(query.wantedKeywords),
    unwantedKeywords: listValue(query.unwantedKeywords),
    dinerIds: listValue(query.dinerIds),
    repeatDays: numberValue(query.repeatDays, '不重复天数'),
    favoriteOnly: booleanValue(query.favoriteOnly, '仅收藏')
  };
}

export async function registerStoreRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get<{ Querystring: RawStoreQuery }>('/api/v1/stores', async (request) =>
    success(await listStores(database, parseStoreQuery(request.query)))
  );
  app.get<{ Querystring: RawStoreQuery }>('/api/v1/stores/candidates', async (request) =>
    success(await listStoreCandidates(database, parseCandidateQuery(request.query)))
  );
  app.post<{ Body: StoreWriteInput }>('/api/v1/stores', { schema: { body: storeBodySchema } }, async (request, reply) =>
    reply.code(201).send(success(await createStore(database, request.body)))
  );
  app.get<{ Params: Params }>('/api/v1/stores/:id', async (request) =>
    success(await getStore(database, request.params.id))
  );
  app.put<{ Params: Params; Body: StoreUpdateInput }>(
    '/api/v1/stores/:id',
    { schema: { body: storeUpdateBodySchema } },
    async (request) => success(await updateStore(database, request.params.id, request.body))
  );
  app.delete<{ Params: Params; Body: { version: number } }>('/api/v1/stores/:id', async (request) =>
    success(await deleteStore(database, request.params.id, request.body?.version))
  );
  app.post<{ Params: Params; Body: { favorite: boolean; version: number } }>(
    '/api/v1/stores/:id/favorite',
    async (request) => {
      return success(
        await setStoreFavorite(database, request.params.id, request.body?.favorite, request.body?.version)
      );
    }
  );
}
