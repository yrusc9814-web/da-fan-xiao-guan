import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import {
  booleanSchema,
  mealRoleSchema,
  mealTypeSchema,
  nullableQuantityUnitSchema,
  nullableStringSchema,
  stringSchema,
  stringListSchema,
  versionBodySchema,
  versionQuerySchema
} from '../../shared/validation-schemas.js';
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

const recipeIngredientSchema = {
  type: 'object',
  properties: {
    ingredientId: nullableStringSchema,
    name: stringSchema,
    ingredientName: stringSchema,
    quantity: { type: ['number', 'null'], minimum: 0 },
    unit: nullableQuantityUnitSchema,
    optional: booleanSchema,
    isPrimary: booleanSchema
  }
};

const recipeBodySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: stringSchema,
    imagePath: nullableStringSchema,
    ingredientsText: nullableStringSchema,
    cookingTimeMinutes: { type: ['integer', 'null'], minimum: 0 },
    difficulty: nullableStringSchema,
    spicyLevel: { type: ['integer', 'null'], minimum: 0, maximum: 5 },
    servings: { type: ['integer', 'null'], minimum: 0 },
    sourceNote: nullableStringSchema,
    notes: nullableStringSchema,
    favorite: booleanSchema,
    enabledForRecommendation: booleanSchema,
    ingredients: { type: 'array', items: recipeIngredientSchema },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['content'],
        properties: { content: stringSchema, imagePath: nullableStringSchema }
      }
    },
    toolIds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: { toolId: nullableStringSchema, name: stringSchema, required: booleanSchema }
      }
    },
    tags: stringListSchema,
    mealTypes: { type: 'array', items: mealTypeSchema },
    mealRoles: { type: 'array', items: mealRoleSchema }
  }
};

const recipeUpdateBodySchema = {
  type: 'object',
  required: ['name', 'version'],
  properties: { ...recipeBodySchema.properties, version: versionBodySchema }
};

const versionQuerySchemaWrapper = {
  type: 'object',
  required: ['version'],
  properties: { version: versionQuerySchema }
};

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
  app.post<{ Body: RecipeWriteInput }>(
    '/api/v1/recipes',
    { schema: { body: recipeBodySchema } },
    async (request, reply) => reply.code(201).send(success(await createRecipe(database, request.body)))
  );
  app.get<{ Params: { id: string } }>('/api/v1/recipes/:id', async (request) =>
    success(await getRecipe(database, request.params.id))
  );
  app.put<{ Params: { id: string }; Body: RecipeWriteInput & { version: number } }>(
    '/api/v1/recipes/:id',
    { schema: { body: recipeUpdateBodySchema } },
    async (request) => {
      const { version, ...input } = request.body;
      return success(await updateRecipe(database, request.params.id, version, input));
    }
  );
  app.delete<{ Params: { id: string }; Querystring: { version: number } }>(
    '/api/v1/recipes/:id',
    { schema: { querystring: versionQuerySchemaWrapper } },
    async (request) => success(await deleteRecipe(database, request.params.id, Number(request.query.version)))
  );
  app.post<{ Params: { id: string }; Body: { version: number; favorite: boolean } }>(
    '/api/v1/recipes/:id/favorite',
    {
      schema: {
        body: {
          type: 'object',
          required: ['version', 'favorite'],
          properties: { version: versionBodySchema, favorite: booleanSchema }
        }
      }
    },
    async (request) =>
      success(await toggleRecipeFavorite(database, request.params.id, request.body.version, request.body.favorite))
  );
}
