import type { FastifyInstance } from 'fastify';
import type { PlanStatus, PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import {
  isoDateQuerySchema,
  mealTypeSchema,
  nullableMealRoleSchema,
  nullableStringSchema,
  planItemTypeSchema,
  planStatusSchema,
  stringListSchema,
  stringSchema,
  versionBodySchema,
  versionQuerySchema
} from '../../shared/validation-schemas.js';
import {
  cancelPlan,
  completePlan,
  createPlan,
  deletePlan,
  getPlan,
  listPlans,
  updatePlan,
  type PlanInput
} from './service.js';

const planItemSchema = {
  type: 'object',
  required: ['itemType'],
  properties: {
    itemType: planItemTypeSchema,
    mealRole: nullableMealRoleSchema,
    recipeId: nullableStringSchema,
    storeId: nullableStringSchema,
    customName: nullableStringSchema,
    sortOrder: { type: 'integer' }
  }
};

const planBodySchema = {
  type: 'object',
  required: ['planDate', 'mealType', 'dinerCount'],
  properties: {
    planDate: stringSchema,
    mealType: mealTypeSchema,
    dinerCount: { type: 'integer', minimum: 0 },
    status: planStatusSchema,
    notes: nullableStringSchema,
    items: { type: 'array', items: planItemSchema },
    dinerIds: stringListSchema
  }
};

const planUpdateBodySchema = {
  type: 'object',
  required: ['version'],
  properties: { ...planBodySchema.properties, version: versionBodySchema }
};

const versionBodyWrapper = { type: 'object', required: ['version'], properties: { version: versionBodySchema } };
const versionQueryWrapper = { type: 'object', required: ['version'], properties: { version: versionQuerySchema } };
const planListQuerySchema = {
  type: 'object',
  properties: { from: isoDateQuerySchema, to: isoDateQuerySchema, status: planStatusSchema }
};

export async function registerMealPlanRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get('/api/v1/plans', { schema: { querystring: planListQuerySchema } }, async (request) =>
    success(await listPlans(database, request.query as { from?: string; to?: string; status?: PlanStatus }))
  );
  app.post('/api/v1/plans', { schema: { body: planBodySchema } }, async (request, reply) =>
    reply.code(201).send(success(await createPlan(database, request.body as PlanInput)))
  );
  app.get('/api/v1/plans/:id', async (request) =>
    success(await getPlan(database, (request.params as { id: string }).id))
  );
  app.put('/api/v1/plans/:id', { schema: { body: planUpdateBodySchema } }, async (request) => {
    const { version, ...input } = request.body as Partial<PlanInput> & { version: number };
    return success(await updatePlan(database, (request.params as { id: string }).id, version, input));
  });
  app.delete('/api/v1/plans/:id', { schema: { querystring: versionQueryWrapper } }, async (request) =>
    success(
      await deletePlan(
        database,
        (request.params as { id: string }).id,
        Number((request.query as { version: string }).version)
      )
    )
  );
  app.post('/api/v1/plans/:id/cancel', { schema: { body: versionBodyWrapper } }, async (request) =>
    success(
      await cancelPlan(database, (request.params as { id: string }).id, (request.body as { version: number }).version)
    )
  );
  app.post('/api/v1/plans/:id/complete', { schema: { body: versionBodyWrapper } }, async (request) =>
    success(
      await completePlan(database, (request.params as { id: string }).id, (request.body as { version: number }).version)
    )
  );
}
