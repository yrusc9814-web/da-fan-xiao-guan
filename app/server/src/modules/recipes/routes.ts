import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import {
  createRecipe,
  deleteRecipe,
  getRecipe,
  listRecipes,
  toggleRecipeFavorite,
  updateRecipe,
  type RecipeListQuery,
  type RecipeWriteInput
} from './service.js';

export async function registerRecipeRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/v1/recipes', async (request) =>
    success(
      await listRecipes(database, {
        ...request.query,
        page: request.query.page ? Number(request.query.page) : undefined,
        pageSize: request.query.pageSize ? Number(request.query.pageSize) : undefined,
        spicyLevel: request.query.spicyLevel ? Number(request.query.spicyLevel) : undefined,
        favorite: request.query.favorite == null ? undefined : request.query.favorite === 'true'
      } as RecipeListQuery)
    )
  );
  app.post<{ Body: RecipeWriteInput }>('/api/v1/recipes', async (request, reply) =>
    reply.code(201).send(success(await createRecipe(database, request.body)))
  );
  app.get<{ Params: { id: string } }>('/api/v1/recipes/:id', async (request) =>
    success(await getRecipe(database, request.params.id))
  );
  app.put<{ Params: { id: string }; Body: RecipeWriteInput & { version: number } }>(
    '/api/v1/recipes/:id',
    async (request) => {
      const { version, ...input } = request.body;
      return success(await updateRecipe(database, request.params.id, version, input));
    }
  );
  app.delete<{ Params: { id: string }; Querystring: { version: number } }>('/api/v1/recipes/:id', async (request) =>
    success(await deleteRecipe(database, request.params.id, Number(request.query.version)))
  );
  app.post<{ Params: { id: string }; Body: { version: number; favorite: boolean } }>(
    '/api/v1/recipes/:id/favorite',
    async (request) =>
      success(await toggleRecipeFavorite(database, request.params.id, request.body.version, request.body.favorite))
  );
}
