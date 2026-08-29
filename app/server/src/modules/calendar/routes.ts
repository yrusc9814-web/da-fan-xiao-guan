import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import { isoDateQuerySchema } from '../../shared/validation-schemas.js';
import { getCalendar } from './service.js';

const calendarQuerySchema = {
  type: 'object',
  required: ['start', 'end'],
  properties: { start: isoDateQuerySchema, end: isoDateQuerySchema }
};

export async function registerCalendarRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get('/api/v1/calendar', { schema: { querystring: calendarQuerySchema } }, async (request) =>
    success(await getCalendar(database, request.query as { start: string; end: string }))
  );
}
