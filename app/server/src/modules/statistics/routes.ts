import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import { isoDateQuerySchema, stringSchema } from '../../shared/validation-schemas.js';
import { getStatistics } from './service.js';

const statisticsQuerySchema = {
  // 这里只校验形状（YYYY-MM-DD）；真实日历存在性（含闰年、2026-02-31 不得 rollover）由 service 层 400 拒绝。
  type: 'object',
  properties: { start: isoDateQuerySchema, end: isoDateQuerySchema, dinerId: stringSchema }
};

export async function registerStatisticsRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get('/api/v1/statistics', { schema: { querystring: statisticsQuerySchema } }, async (request) =>
    success(await getStatistics(database, request.query as { start?: string; end?: string; dinerId?: string }))
  );
}
