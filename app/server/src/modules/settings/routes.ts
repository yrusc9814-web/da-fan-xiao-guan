import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { failure, success } from '../../shared/http.js';
import {
  completeOnboarding,
  createAccessQr,
  createHighRiskAuthorization,
  getSettings,
  setPin,
  updateSettings,
  validPinSession,
  verifyPinAndCreateSession
} from './service.js';

export function registerPinGuard(app: FastifyInstance, database: PrismaClient) {
  app.addHook('preHandler', async (request, reply) => {
    if (
      !request.url.startsWith('/api/v1/') ||
      request.url === '/api/v1/health' ||
      (request.method === 'POST' && request.url === '/api/v1/settings/pin/verify') ||
      (request.method === 'POST' && request.url === '/api/v1/settings/onboarding') ||
      (request.method === 'GET' && request.url === '/api/v1/settings')
    )
      return;
    const settings = await database.settings.findUnique({ where: { id: 1 }, select: { pinEnabled: true } });
    if (settings?.pinEnabled && !validPinSession(request.headers['x-app-pin-token'] as string | undefined)) {
      return reply.code(401).send(failure('UNAUTHORIZED', '需要先验证本地 PIN'));
    }
  });
}

export async function registerSettingsRoutes(app: FastifyInstance, database: PrismaClient) {
  app.get('/api/v1/settings', async () => success(await getSettings(database)));
  app.post<{ Body: Parameters<typeof completeOnboarding>[1] }>('/api/v1/settings/onboarding', async (request) =>
    success(await completeOnboarding(database, request.body))
  );
  app.get('/api/v1/settings/pin/session', async () => success({ valid: true }));
  app.put<{ Body: { version: number } & Parameters<typeof updateSettings>[2] }>('/api/v1/settings', async (request) => {
    const { version, ...input } = request.body;
    return success(await updateSettings(database, version, input));
  });
  app.put<{ Body: { version: number; pin: string | null; enabled: boolean } }>(
    '/api/v1/settings/pin',
    async (request) => success(await setPin(database, request.body.version, request.body.pin, request.body.enabled))
  );
  app.post<{ Body: { pin: string } }>('/api/v1/settings/pin/verify', async (request) =>
    success(await verifyPinAndCreateSession(database, request.body.pin))
  );
  app.post<{ Body: { action: 'RESTORE'; pin?: string; confirmation?: string; challenge?: string } }>(
    '/api/v1/settings/high-risk/authorize',
    async (request) => success(await createHighRiskAuthorization(database, request.body))
  );
  app.get<{ Querystring: { url: string } }>('/api/v1/settings/access-qr', async (request) =>
    success(await createAccessQr(request.query.url))
  );
}
