import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { getDashboard } from './service.js';
import { failure, success } from '../../shared/http.js';

export async function registerDashboardRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get('/api/v1/dashboard', async (_request, reply) => {
    try {
      return reply.send(success(await getDashboard(database)));
    } catch (error) {
      app.log.error(error);
      return reply.code(503).send(failure('DATABASE_ERROR', '首页数据暂时不可用'));
    }
  });
}
