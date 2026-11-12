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
  uncompletePlan,
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
    // time/title/subtext/icon：nullable 真实字段。空串按“未填写”处理（service 归一为 null），
    // 严格 "HH:MM" 与限长由 service 快速失败；绝不注入 12:30 / 🍱 等默认值。
    time: { type: ['string', 'null'], maxLength: 5 },
    title: { type: ['string', 'null'], maxLength: 200 },
    subtext: { type: ['string', 'null'], maxLength: 200 },
    icon: { type: ['string', 'null'], maxLength: 20 },
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

/**
 * 撤销完成 body 的允许字段。Fastify 默认 AJV 会静默剥离未知字段（removeAdditional），
 * 与“未知字段 fail-closed 快速失败”的契约冲突；preValidation 在 AJV 校验之前执行，
 * 可看到原始解析后的 body（与 ingredients / recipes 路由同一既有模式）。
 */
const uncompleteAllowedKeys: readonly string[] = ['version'];

function assertExactKeys(body: unknown, allowed: readonly string[]): void {
  if (!body || typeof body !== 'object') return;
  const unknown = Object.keys(body as Record<string, unknown>).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw Object.assign(new Error(`请求包含未支持的字段：${unknown.join(', ')}`), { statusCode: 400 });
  }
}

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
  app.post(
    '/api/v1/plans/:id/uncomplete',
    {
      schema: { body: versionBodyWrapper },
      preValidation: async (request) => assertExactKeys(request.body, uncompleteAllowedKeys)
    },
    async (request) =>
      success(
        await uncompletePlan(
          database,
          (request.params as { id: string }).id,
          (request.body as { version: number }).version
        )
      )
  );
}
