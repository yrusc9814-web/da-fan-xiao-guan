import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import { stringListSchema } from '../../shared/validation-schemas.js';
import { listAllInventoryLogs, recommendFromInventory, type InventoryRecommendationInput } from './service.js';

const kitchenRecommendBodySchema = {
  type: 'object',
  required: ['mode'],
  properties: {
    mode: { type: 'string', enum: ['ONLY_INVENTORY', 'ALLOW_PURCHASE', 'MUST_CONSUME'] },
    dinerIds: stringListSchema,
    ingredientIds: stringListSchema,
    limit: { type: 'integer', minimum: 1 }
  }
};

export async function registerInventoryRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get<{ Querystring: { ingredientId?: string; batchId?: string; take?: number } }>(
    '/api/v1/inventory/logs',
    async (request) => success(await listAllInventoryLogs(database, request.query))
  );
  app.post<{ Body: InventoryRecommendationInput }>(
    '/api/v1/kitchen/recommend',
    { schema: { body: kitchenRecommendBodySchema } },
    async (request) => success(await recommendFromInventory(database, request.body))
  );
}
