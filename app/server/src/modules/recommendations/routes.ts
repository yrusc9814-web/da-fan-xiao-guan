import type { MealType, PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { success } from '../../shared/http.js';
import {
  booleanSchema,
  integerSchema,
  mealTypeSchema,
  stringListSchema,
  stringSchema
} from '../../shared/validation-schemas.js';
import {
  addRecommendationToPlan,
  listRecommendationHistory,
  markRecommendation,
  mealSetRecommendation,
  randomRecommendation,
  type RecommendationInput
} from './service.js';

const recommendationBodySchema = {
  type: 'object',
  properties: {
    mealType: mealTypeSchema,
    dinerIds: stringListSchema,
    sourceTypes: { type: 'array', items: { type: 'string', enum: ['RECIPE', 'STORE'] } },
    inventoryOnly: booleanSchema,
    allowPurchase: booleanSchema,
    favoriteOnly: booleanSchema,
    repeatDays: { ...integerSchema, minimum: 0, maximum: 365 },
    acquisitionModes: { type: 'array', items: { type: 'string', enum: ['DINE_IN', 'TAKEOUT'] } }
  }
};

const addToPlanBodySchema = {
  type: 'object',
  required: ['planDate', 'mealType', 'dinerCount'],
  properties: {
    planDate: stringSchema,
    mealType: mealTypeSchema,
    dinerCount: { ...integerSchema, minimum: 1 },
    dinerIds: stringListSchema
  }
};

export async function registerRecommendationRoutes(app: FastifyInstance, database: PrismaClient) {
  app.post<{ Body: RecommendationInput }>(
    '/api/v1/recommendations/random',
    { schema: { body: recommendationBodySchema } },
    async (r) => success(await randomRecommendation(database, r.body ?? {}))
  );
  app.post<{ Body: RecommendationInput }>(
    '/api/v1/recommendations/meal-set',
    { schema: { body: recommendationBodySchema } },
    async (r) => success(await mealSetRecommendation(database, r.body ?? {}))
  );
  app.get('/api/v1/recommendations/history', async () => success(await listRecommendationHistory(database)));
  app.post<{
    Params: { id: string };
    Body: { planDate: string; mealType: MealType; dinerCount: number; dinerIds?: string[] };
  }>('/api/v1/recommendations/:id/add-to-plan', { schema: { body: addToPlanBodySchema } }, async (r) =>
    success(await addRecommendationToPlan(database, r.params.id, r.body))
  );
  app.post<{ Params: { id: string } }>('/api/v1/recommendations/:id/accept', async (r) =>
    success(await markRecommendation(database, r.params.id, 'accepted'))
  );
  app.post<{ Params: { id: string } }>('/api/v1/recommendations/:id/added-to-plan', async (r) =>
    success(await markRecommendation(database, r.params.id, 'addedToPlan'))
  );
}
