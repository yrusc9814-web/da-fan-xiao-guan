import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import { adjustInventory, createIngredient, deleteIngredient, getIngredient, listIngredients, listInventoryLogs, updateIngredient, type BatchAdjustmentInput, type IngredientWriteInput } from './service.js';

export async function registerIngredientRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get<{ Querystring: { search?: string; category?: string; status?: string } }>('/api/v1/ingredients', async (request) => success(await listIngredients(database, request.query)));
  app.post<{ Body: IngredientWriteInput }>('/api/v1/ingredients', async (request, reply) => reply.code(201).send(success(await createIngredient(database, request.body))));
  app.get<{ Params: { id: string } }>('/api/v1/ingredients/:id', async (request) => success(await getIngredient(database, request.params.id)));
  app.put<{ Params: { id: string }; Body: IngredientWriteInput & { version: number } }>('/api/v1/ingredients/:id', async (request) => {
    const { version, ...input } = request.body;
    return success(await updateIngredient(database, request.params.id, version, input));
  });
  app.delete<{ Params: { id: string }; Querystring: { version: number } }>('/api/v1/ingredients/:id', async (request) => success(await deleteIngredient(database, request.params.id, Number(request.query.version))));
  app.post<{ Params: { id: string }; Body: BatchAdjustmentInput }>('/api/v1/ingredients/:id/adjust', async (request) => success(await adjustInventory(database, request.params.id, request.body)));
  app.get<{ Params: { id: string } }>('/api/v1/ingredients/:id/logs', async (request) => success(await listInventoryLogs(database, request.params.id)));
}
