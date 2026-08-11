import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import { listAllInventoryLogs, recommendFromInventory, type InventoryRecommendationInput } from './service.js';

export async function registerInventoryRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get<{ Querystring: { ingredientId?: string; batchId?: string; take?: number } }>(
    '/api/v1/inventory/logs',
    async (request) => success(await listAllInventoryLogs(database, request.query))
  );
  app.post<{ Body: InventoryRecommendationInput }>('/api/v1/kitchen/recommend', async (request) =>
    success(await recommendFromInventory(database, request.body))
  );
}
