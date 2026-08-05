import Fastify, { type FastifyInstance } from 'fastify';

import { loadConfig, type AppConfig } from './config/env.js';
import { registerHealthRoutes } from './modules/health/routes.js';
import { registerCors } from './plugins/cors.js';
import { registerErrorHandlers } from './plugins/error-handler.js';

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger: options.logger ?? true
  });

  registerErrorHandlers(app);
  await registerCors(app);
  await registerHealthRoutes(app, config);

  return app;
}
