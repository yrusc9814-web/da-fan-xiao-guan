import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import {
  booleanSchema,
  inventoryChangeTypeSchema,
  nullableStringSchema,
  positiveIntQuerySchema,
  quantityUnitSchema,
  stringSchema,
  versionBodySchema,
  versionQuerySchema
} from '../../shared/validation-schemas.js';
import {
  adjustInventory,
  consumeIngredient,
  createIngredient,
  deleteIngredient,
  getIngredient,
  listIngredients,
  listInventoryLogs,
  updateIngredient,
  type BatchAdjustmentInput,
  type ConsumeInput,
  type IngredientWriteInput
} from './service.js';

const ingredientBatchSchema = {
  type: 'object',
  properties: {
    quantity: { type: 'number', minimum: 0 },
    unit: quantityUnitSchema,
    purchaseDate: nullableStringSchema,
    expiryDate: nullableStringSchema,
    location: nullableStringSchema,
    opened: booleanSchema,
    consumePriority: booleanSchema,
    notes: nullableStringSchema
  }
};

/**
 * 食材分类：统一 7 类；同时接受历史旧名（蛋奶/烘焙/水果/肉类…），
 * 由 service 归一化后落库，避免旧前端或旧调用方直接被 400 打断。
 */
const ingredientCategorySchema = {
  type: 'string',
  enum: [
    '蔬菜',
    '肉禽',
    '水产',
    '蛋奶豆制',
    '主食粮油',
    '调味',
    '其他',
    '蛋奶',
    '烘焙',
    '水果',
    '日常',
    '肉类',
    '禽类',
    '海鲜',
    '蛋类',
    '豆制品',
    '主食',
    '粮油',
    '调料',
    '调味品'
  ]
};

const ingredientBodySchema = {
  type: 'object',
  required: ['name', 'unit'],
  properties: {
    name: stringSchema,
    imagePath: nullableStringSchema,
    category: { anyOf: [ingredientCategorySchema, { type: 'null' }] },
    unit: quantityUnitSchema,
    minStock: { type: ['number', 'null'], minimum: 0 },
    maxStock: { type: ['number', 'null'], minimum: 0 },
    notes: nullableStringSchema,
    // 食材级编辑（详情「✏️ 编辑」）：数量与批次元数据，由 service 同步进批次
    quantity: { type: ['number', 'null'], minimum: 0 },
    purchaseDate: nullableStringSchema,
    expiryDate: nullableStringSchema,
    location: nullableStringSchema,
    storageLocation: nullableStringSchema,
    opened: booleanSchema,
    batches: { type: 'array', items: ingredientBatchSchema }
  }
};

const ingredientUpdateBodySchema = {
  type: 'object',
  required: ['name', 'unit', 'version'],
  properties: { ...ingredientBodySchema.properties, version: versionBodySchema }
};

const versionQueryWrapper = { type: 'object', required: ['version'], properties: { version: versionQuerySchema } };

const batchAdjustmentBodySchema = {
  type: 'object',
  required: ['quantity', 'unit', 'changeType'],
  properties: {
    batchId: nullableStringSchema,
    batchVersion: { type: 'integer', minimum: 1 },
    quantity: { type: 'number' },
    unit: quantityUnitSchema,
    changeType: inventoryChangeTypeSchema,
    purchaseDate: nullableStringSchema,
    expiryDate: nullableStringSchema,
    location: nullableStringSchema,
    opened: booleanSchema,
    consumePriority: booleanSchema,
    notes: nullableStringSchema
  }
};

/**
 * Google2 库存详情固定按钮的聚合消耗契约：
 * mode=QUANTITY 时 quantity+unit 必填；mode=ALL 时两者必须省略（“全部用完”按真实全部活批次清零）。
 * 未知字段 fail-closed，不做静默丢弃。
 */
const consumeBodySchema = {
  type: 'object',
  required: ['mode', 'ingredientVersion'],
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['QUANTITY', 'ALL'] },
    quantity: { type: 'number' },
    unit: quantityUnitSchema,
    ingredientVersion: versionBodySchema,
    notes: nullableStringSchema
  }
};

/**
 * 聚合消耗 body 的允许字段。Fastify 默认 AJV 会静默剥离未知字段（removeAdditional），
 * 与 fail-closed 契约冲突；preValidation 在 AJV 校验之前执行，可看到原始解析后的 body。
 */
const consumeAllowedKeys: readonly string[] = ['mode', 'quantity', 'unit', 'ingredientVersion', 'notes'];

function assertExactKeys(body: unknown, allowed: readonly string[]): void {
  if (!body || typeof body !== 'object') return;
  const unknown = Object.keys(body as Record<string, unknown>).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw Object.assign(new Error(`请求包含未支持的字段：${unknown.join(', ')}`), { statusCode: 400 });
  }
}

export async function registerIngredientRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get<{
    Querystring: { search?: string; category?: string; status?: string; page?: string; pageSize?: string };
  }>(
    '/api/v1/ingredients',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            search: stringSchema,
            category: stringSchema,
            status: { type: 'string', enum: ['DEPLETED', 'EXPIRED', 'EXPIRING_SOON', 'LOW_STOCK', 'NORMAL'] },
            page: positiveIntQuerySchema,
            pageSize: positiveIntQuerySchema
          }
        }
      }
    },
    async (request) =>
      success(
        await listIngredients(database, {
          search: request.query.search,
          category: request.query.category,
          status: request.query.status,
          page: request.query.page ? Number(request.query.page) : undefined,
          pageSize: request.query.pageSize ? Number(request.query.pageSize) : undefined
        })
      )
  );
  app.post<{ Body: IngredientWriteInput }>(
    '/api/v1/ingredients',
    { schema: { body: ingredientBodySchema } },
    async (request, reply) => reply.code(201).send(success(await createIngredient(database, request.body)))
  );
  app.get<{ Params: { id: string } }>('/api/v1/ingredients/:id', async (request) =>
    success(await getIngredient(database, request.params.id))
  );
  app.put<{ Params: { id: string }; Body: IngredientWriteInput & { version: number } }>(
    '/api/v1/ingredients/:id',
    { schema: { body: ingredientUpdateBodySchema } },
    async (request) => {
      const { version, ...input } = request.body;
      // 前端历史字段名 storageLocation 与 location 等价，二者取其一。
      const { storageLocation, ...rest } = input as IngredientWriteInput & { storageLocation?: string | null };
      const merged: IngredientWriteInput = {
        ...rest,
        ...(rest.location === undefined && storageLocation !== undefined ? { location: storageLocation } : {})
      };
      return success(await updateIngredient(database, request.params.id, version, merged));
    }
  );
  app.delete<{ Params: { id: string }; Querystring: { version: number } }>(
    '/api/v1/ingredients/:id',
    { schema: { querystring: versionQueryWrapper } },
    async (request) => success(await deleteIngredient(database, request.params.id, Number(request.query.version)))
  );
  app.post<{ Params: { id: string }; Body: BatchAdjustmentInput }>(
    '/api/v1/ingredients/:id/adjust',
    { schema: { body: batchAdjustmentBodySchema } },
    async (request) => success(await adjustInventory(database, request.params.id, request.body))
  );
  // Google2 库存详情「消耗 100g / 消耗 250g / 全部用完」：聚合食材级消耗，批次顺序由服务端确定。
  app.post<{ Params: { id: string }; Body: ConsumeInput }>(
    '/api/v1/ingredients/:id/consume',
    {
      schema: { body: consumeBodySchema },
      preValidation: async (request) => assertExactKeys(request.body, consumeAllowedKeys)
    },
    async (request) => success(await consumeIngredient(database, request.params.id, request.body))
  );
  app.get<{ Params: { id: string } }>('/api/v1/ingredients/:id/logs', async (request) =>
    success(await listInventoryLogs(database, request.params.id))
  );
}
