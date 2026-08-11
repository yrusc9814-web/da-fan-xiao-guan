import type { MealType, PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { success } from '../../shared/http.js';
import {
  addRecommendationToPlan,
  listRecommendationHistory,
  markRecommendation,
  mealSetRecommendation,
  randomRecommendation,
  type RecommendationInput
} from './service.js';

export async function registerRecommendationRoutes(app: FastifyInstance, database: PrismaClient) {
  app.post<{ Body: RecommendationInput }>('/api/v1/recommendations/random', async (r) =>
    success(await randomRecommendation(database, r.body ?? {}))
  );
  app.post<{ Body: RecommendationInput }>('/api/v1/recommendations/meal-set', async (r) =>
    success(await mealSetRecommendation(database, r.body ?? {}))
  );
  app.get('/api/v1/recommendations/history', async () => success(await listRecommendationHistory(database)));
  app.post<{
    Params: { id: string };
    Body: { planDate: string; mealType: MealType; dinerCount: number; dinerIds?: string[] };
  }>('/api/v1/recommendations/:id/add-to-plan', async (r) =>
    success(await addRecommendationToPlan(database, r.params.id, r.body))
  );
  app.post<{ Params: { id: string } }>('/api/v1/recommendations/:id/accept', async (r) =>
    success(await markRecommendation(database, r.params.id, 'accepted'))
  );
  app.post<{ Params: { id: string } }>('/api/v1/recommendations/:id/added-to-plan', async (r) =>
    success(await markRecommendation(database, r.params.id, 'addedToPlan'))
  );
}
