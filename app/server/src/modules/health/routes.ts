import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../../config/env.js';
import { success } from '../../shared/http.js';

export async function registerHealthRoutes(
  app: FastifyInstance,
  config: AppConfig
): Promise<void> {
  app.get('/api/v1/health', async () => {
    return success({
      status: 'ok' as const,
      app: config.appName,
      version: config.version,
      timestamp: new Date().toISOString()
    });
  });
}
