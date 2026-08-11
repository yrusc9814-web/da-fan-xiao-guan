import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import type { AppConfig } from '../../config/env.js';
import { checkDatabaseHealth } from '../../database/health.js';
import { failure, success } from '../../shared/http.js';

export async function registerHealthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  database: PrismaClient
): Promise<void> {
  app.get('/api/v1/health', async (_request, reply) => {
    const databaseHealth = await checkDatabaseHealth(database);

    if (databaseHealth.status !== 'ok') {
      return reply.code(503).send(failure('DATABASE_ERROR', '数据库不可用'));
    }

    return reply.send(
      success({
        status: 'ok' as const,
        app: config.appName,
        version: config.version,
        database: databaseHealth,
        timestamp: new Date().toISOString()
      })
    );
  });
}
