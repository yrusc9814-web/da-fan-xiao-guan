import type { FastifyInstance } from 'fastify';
import type { PlanStatus, PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import { cancelPlan, completePlan, createPlan, deletePlan, getPlan, listPlans, updatePlan, type PlanInput } from './service.js';

export async function registerMealPlanRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get('/api/v1/plans', async (request) => success(await listPlans(database, request.query as { from?: string; to?: string; status?: PlanStatus })));
  app.post('/api/v1/plans', async (request, reply) => reply.code(201).send(success(await createPlan(database, request.body as PlanInput))));
  app.get('/api/v1/plans/:id', async (request) => success(await getPlan(database, (request.params as { id: string }).id)));
  app.put('/api/v1/plans/:id', async (request) => {
    const { version, ...input } = request.body as Partial<PlanInput> & { version: number };
    return success(await updatePlan(database, (request.params as { id: string }).id, version, input));
  });
  app.delete('/api/v1/plans/:id', async (request) => success(await deletePlan(database, (request.params as { id: string }).id, Number((request.query as { version: string }).version))));
  app.post('/api/v1/plans/:id/cancel', async (request) => success(await cancelPlan(database, (request.params as { id: string }).id, (request.body as { version: number }).version)));
  app.post('/api/v1/plans/:id/complete', async (request) => success(await completePlan(database, (request.params as { id: string }).id, (request.body as { version: number }).version)));
}
