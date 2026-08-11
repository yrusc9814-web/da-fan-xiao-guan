import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import { getCalendar } from './service.js';

export async function registerCalendarRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get('/api/v1/calendar', async (request) => success(await getCalendar(database, request.query as { start: string; end: string })));
}
