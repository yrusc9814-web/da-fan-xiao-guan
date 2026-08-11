import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';

import { loadConfig, type AppConfig } from './config/env.js';
import { disconnectPrisma, prisma as defaultPrisma } from './database/client.js';
import { registerHealthRoutes } from './modules/health/routes.js';
import { registerDashboardRoutes } from './modules/dashboard/routes.js';
import { registerDinerRoutes } from './modules/diners/routes.js';
import { registerDeletedItemRoutes } from './modules/deleted-items/routes.js';
import { registerCalendarRoutes } from './modules/calendar/routes.js';
import { registerBackupRoutes } from './modules/backup/routes.js';
import { registerConsumptionRoutes } from './modules/consumption/routes.js';
import { registerIngredientRoutes } from './modules/ingredients/routes.js';
import { registerInventoryRoutes } from './modules/inventory/routes.js';
import { registerMealPlanRoutes } from './modules/meal-plans/routes.js';
import { registerMealRecordRoutes } from './modules/meal-records/routes.js';
import { registerRecipeRoutes } from './modules/recipes/routes.js';
import { registerRecommendationRoutes } from './modules/recommendations/routes.js';
import { registerShoppingRoutes } from './modules/shopping/routes.js';
import { registerPinGuard, registerSettingsRoutes } from './modules/settings/routes.js';
import { registerSearchRoutes } from './modules/search/routes.js';
import { registerStatisticsRoutes } from './modules/statistics/routes.js';
import { registerStoreRoutes } from './modules/stores/routes.js';
import { registerToolRoutes } from './modules/tools/routes.js';
import { registerUploadRoutes } from './modules/uploads/routes.js';
import { registerCors } from './plugins/cors.js';
import { registerErrorHandlers } from './plugins/error-handler.js';
import { registerMaintenanceGuard } from './plugins/maintenance.js';

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
  database?: PrismaClient;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const database = options.database ?? defaultPrisma;
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 9 * 1024 * 1024
  });

  registerErrorHandlers(app);
  registerMaintenanceGuard(app);
  registerPinGuard(app, database);
  await registerCors(app);
  await registerHealthRoutes(app, config, database);
  await registerDashboardRoutes(app, database);
  await registerStoreRoutes(app, database);
  await registerDinerRoutes(app, database);
  await registerDeletedItemRoutes(app, database);
  await registerRecipeRoutes(app, database);
  await registerRecommendationRoutes(app, database);
  await registerIngredientRoutes(app, database);
  await registerInventoryRoutes(app, database);
  await registerToolRoutes(app, database);
  await registerMealPlanRoutes(app, database);
  await registerMealRecordRoutes(app, database);
  await registerShoppingRoutes(app, database);
  await registerSettingsRoutes(app, database);
  await registerSearchRoutes(app, database);
  await registerCalendarRoutes(app, database);
  await registerConsumptionRoutes(app, database);
  await registerStatisticsRoutes(app, database);
  await registerUploadRoutes(app, database);
  await registerBackupRoutes(app, database);
  if (config.environment === 'production') {
    await app.register(fastifyStatic, {
      root: resolve(process.cwd(), 'app/client/dist'),
      prefix: '/',
      wildcard: false
    });
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/uploads/')) {
        return reply.code(404).send({ success: false, data: null, error: { code: 'NOT_FOUND', message: '请求的资源不存在' } });
      }
      return reply.sendFile('index.html');
    });
  }
  app.addHook('onClose', async () => {
    await disconnectPrisma(database);
  });

  return app;
}
