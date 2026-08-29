import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import {
  booleanSchema,
  inventoryChangeTypeSchema,
  nullableStringSchema,
  quantityUnitSchema,
  stringSchema,
  versionBodySchema,
  versionQuerySchema
} from '../../shared/validation-schemas.js';
import {
  adjustInventory,
  createIngredient,
  deleteIngredient,
  getIngredient,
  listIngredients,
  listInventoryLogs,
  updateIngredient,
  type BatchAdjustmentInput,
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

const ingredientBodySchema = {
  type: 'object',
  required: ['name', 'unit'],
  properties: {
    name: stringSchema,
    imagePath: nullableStringSchema,
    category: nullableStringSchema,
    unit: quantityUnitSchema,
    minStock: { type: ['number', 'null'], minimum: 0 },
    maxStock: { type: ['number', 'null'], minimum: 0 },
    notes: nullableStringSchema,
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

export async function registerIngredientRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get<{ Querystring: { search?: string; category?: string; status?: string } }>(
    '/api/v1/ingredients',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            search: stringSchema,
            category: stringSchema,
            status: { type: 'string', enum: ['DEPLETED', 'EXPIRED', 'EXPIRING_SOON', 'LOW_STOCK', 'NORMAL'] }
          }
        }
      }
    },
    async (request) => success(await listIngredients(database, request.query))
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
      return success(await updateIngredient(database, request.params.id, version, input));
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
  app.get<{ Params: { id: string } }>('/api/v1/ingredients/:id/logs', async (request) =>
    success(await listInventoryLogs(database, request.params.id))
  );
}
