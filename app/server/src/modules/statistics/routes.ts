import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import { getStatistics } from './service.js';

export async function registerStatisticsRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get('/api/v1/statistics', async (request) =>
    success(await getStatistics(database, request.query as { start?: string; end?: string; dinerId?: string }))
  );
}
