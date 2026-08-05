import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { loadConfig, type AppConfig } from './config/env.js';
import { disconnectPrisma, prisma as defaultPrisma } from './database/client.js';
import { registerHealthRoutes } from './modules/health/routes.js';
import { registerCors } from './plugins/cors.js';
import { registerErrorHandlers } from './plugins/error-handler.js';

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
  database?: PrismaClient;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const database = options.database ?? defaultPrisma;
  const app = Fastify({
    logger: options.logger ?? true
  });

  registerErrorHandlers(app);
  await registerCors(app);
  await registerHealthRoutes(app, config, database);
  app.addHook('onClose', async () => {
    await disconnectPrisma(database);
  });

  return app;
}
