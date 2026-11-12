import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import {
  booleanQuerySchema,
  booleanSchema,
  mealRoleSchema,
  mealTypeSchema,
  nullableQuantityUnitSchema,
  nullableStringSchema,
  positiveIntQuerySchema,
  sortOrderQuerySchema,
  stringSchema,
  stringListSchema,
  versionBodySchema,
  versionQuerySchema
} from '../../shared/validation-schemas.js';
import {
  cookCheckinRecipe,
  createRecipe,
  deleteRecipe,
  getRecipe,
  listRecipes,
  toggleRecipeFavorite,
  updateRecipe,
  type CookCheckinInput,
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
    /** 自由用量原文（"300g" / "半个" / "适量" / "2汤匙"）：仅字符串或 null，不做任何数值推测。 */
    amountText: nullableStringSchema,
    optional: booleanSchema,
    isPrimary: booleanSchema
  }
};

const recipeBodySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: stringSchema,
    /** 菜谱分类（前端 #formRecipeCategory）：与 tags 相互独立，null 表示未填写。 */
    category: nullableStringSchema,
    imagePath: nullableStringSchema,
    ingredientsText: nullableStringSchema,
    cookingTimeMinutes: { type: ['integer', 'null'], minimum: 0 },
    difficulty: nullableStringSchema,
    spicyLevel: { type: ['integer', 'null'], minimum: 0, maximum: 5 },
    servings: { type: ['integer', 'null'], minimum: 0 },
    calories: { type: ['integer', 'null'], minimum: 50, maximum: 2000 },
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
        properties: {
          content: stringSchema,
          /** 步骤标题：与 content（步骤说明）独立，null 表示未填写。 */
          title: nullableStringSchema,
          /** 步骤计时（分钟）：0..180 整数；null 表示未填写，0 是真实值。 */
          timerMinutes: { type: ['integer', 'null'], minimum: 0, maximum: 180 },
          imagePath: nullableStringSchema
        }
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

const recipeListQuerySchema = {
  type: 'object',
  properties: {
    page: positiveIntQuerySchema,
    pageSize: positiveIntQuerySchema,
    spicyLevel: { type: 'string', pattern: '^[0-5]$' },
    favorite: booleanQuerySchema,
    search: stringSchema,
    mealType: mealTypeSchema,
    difficulty: stringSchema,
    tag: stringSchema,
    sortBy: { type: 'string', enum: ['name', 'cookingTimeMinutes', 'favorite', 'createdAt', 'updatedAt'] },
    sortOrder: sortOrderQuerySchema
  }
};

/**
 * Google2「🍳 打卡」body：只允许真实打卡输入。
 *
 * 不含任何库存/扣减字段（打卡不扣库）；nutrition 字段可选且无默认值注入，
 * satiety 只接受正式档位 3/5/7/8/10，recordDate/mealType 必填且由真实请求提供。
 */
const cookSourceTypeSchema = {
  type: 'string',
  enum: ['HOMEMADE', 'TAKEOUT', 'DINE_IN', 'CUSTOM']
} as const;

const cookCheckinBodySchema = {
  type: 'object',
  required: ['recordDate', 'mealType'],
  additionalProperties: false,
  properties: {
    recordDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    mealType: mealTypeSchema,
    recordTime: nullableStringSchema,
    title: { type: ['string', 'null'], maxLength: 200 },
    notes: nullableStringSchema,
    photos: { type: ['array', 'null'], maxItems: 3, items: stringSchema },
    calories: { type: ['integer', 'null'], minimum: 0 },
    rating: { type: ['number', 'null'], minimum: 0, maximum: 5 },
    satiety: { type: ['integer', 'null'], enum: [3, 5, 7, 8, 10, null] },
    cost: { type: ['integer', 'null'], minimum: 0, maximum: 9999 },
    dinerIds: stringListSchema,
    sourceType: cookSourceTypeSchema
  }
};

/**
 * Google2「🍳 打卡」body 的允许字段（Fastify 默认 AJV 会静默剥离未知字段，
 * 与“打卡不接收任何库存/confirm 语义”的 fail-closed 契约冲突）。
 * preValidation 在 AJV 之前运行，能看到原始解析后的 body。
 */
const cookCheckinAllowedKeys: readonly string[] = [
  'recordDate',
  'mealType',
  'recordTime',
  'title',
  'notes',
  'photos',
  'calories',
  'rating',
  'satiety',
  'cost',
  'dinerIds',
  'sourceType'
];

function assertCookCheckinKeys(body: unknown): void {
  if (!body || typeof body !== 'object') return;
  const unknown = Object.keys(body as Record<string, unknown>).filter((key) => !cookCheckinAllowedKeys.includes(key));
  if (unknown.length) {
    throw Object.assign(new Error(`打卡请求包含未支持的字段：${unknown.join(', ')}`), { statusCode: 400 });
  }
}

export async function registerRecipeRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/api/v1/recipes',
    { schema: { querystring: recipeListQuerySchema } },
    async (request) =>
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
  // Google2 recipeDetail「🍳 打卡」：仅创建真实烹饪记录，不扣库。
  // 新建 201；同（菜谱, 日期, 餐次）已有 CONFIRMED 记录时返回既有记录 200（repeated=true）。
  app.post<{ Params: { id: string }; Body: CookCheckinInput }>(
    '/api/v1/recipes/:id/cook-checkin',
    {
      schema: { body: cookCheckinBodySchema },
      preValidation: async (request) => assertCookCheckinKeys(request.body)
    },
    async (request, reply) => {
      const result = await cookCheckinRecipe(database, request.params.id, request.body);
      return reply.code(result.repeated ? 200 : 201).send(success(result));
    }
  );
}
