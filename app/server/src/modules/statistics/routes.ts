import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import { isoDateQuerySchema, stringSchema } from '../../shared/validation-schemas.js';
import { getStatistics } from './service.js';

const statisticsQuerySchema = {
  type: 'object',
  properties: { start: isoDateQuerySchema, end: isoDateQuerySchema, dinerId: stringSchema }
};

export async function registerStatisticsRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get('/api/v1/statistics', { schema: { querystring: statisticsQuerySchema } }, async (request) =>
    success(await getStatistics(database, request.query as { start?: string; end?: string; dinerId?: string }))
  );
}
