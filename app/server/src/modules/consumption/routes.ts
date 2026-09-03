import type { MealType, PrismaClient, RecordSourceType } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { success } from '../../shared/http.js';
import {
  consumptionSelectionsSchema,
  mealTypeSchema,
  nullableStringSchema,
  recordSourceTypeSchema,
  stringListSchema,
  stringSchema,
  versionBodySchema
} from '../../shared/validation-schemas.js';
import {
  confirmConsumption,
  confirmImmediateMeal,
  getConsumptionPreview,
  getImmediateMealPreview,
  type BatchSelections
} from './service.js';

const consumptionPreviewBodySchema = {
  type: 'object',
  required: ['recordVersion'],
  properties: { recordVersion: versionBodySchema, selections: consumptionSelectionsSchema }
};

const consumptionConfirmBodySchema = {
  type: 'object',
  required: ['recordVersion', 'previewToken', 'operationId'],
  properties: {
    recordVersion: versionBodySchema,
    previewToken: stringSchema,
    operationId: stringSchema,
    selections: consumptionSelectionsSchema
  }
};

const immediateMealBaseProperties = {
  recipeId: stringSchema,
  mealType: mealTypeSchema,
  sourceType: recordSourceTypeSchema,
  recordDate: stringSchema,
  recordTime: nullableStringSchema,
  notes: nullableStringSchema,
  dinerIds: stringListSchema,
  relatedPlanId: nullableStringSchema,
  selections: consumptionSelectionsSchema
};

const immediateMealPreviewBodySchema = {
  type: 'object',
  required: ['recipeId', 'mealType', 'sourceType'],
  properties: immediateMealBaseProperties
};

const immediateMealConfirmBodySchema = {
  type: 'object',
  required: ['recipeId', 'mealType', 'sourceType', 'previewToken', 'operationId'],
  properties: {
    ...immediateMealBaseProperties,
    previewToken: stringSchema,
    operationId: stringSchema
  }
};

interface ImmediateMealBody {
  recipeId: string;
  mealType: MealType;
  sourceType: RecordSourceType;
  recordDate?: string;
  recordTime?: string | null;
  notes?: string | null;
  dinerIds?: string[];
  relatedPlanId?: string | null;
  selections?: BatchSelections;
}

export async function registerConsumptionRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.post<{ Params: { id: string }; Body: { recordVersion: number; selections?: BatchSelections } }>(
    '/api/v1/records/:id/consumption-preview',
    { schema: { body: consumptionPreviewBodySchema } },
    async (request) =>
      success(
        await getConsumptionPreview(database, request.params.id, request.body.recordVersion, request.body.selections)
      )
  );
  app.post<{
    Params: { id: string };
    Body: { recordVersion: number; previewToken: string; operationId: string; selections?: BatchSelections };
  }>('/api/v1/records/:id/confirm-consumption', { schema: { body: consumptionConfirmBodySchema } }, async (request) =>
    success(await confirmConsumption(database, { recordId: request.params.id, ...request.body }))
  );

  // 即时用餐：无需先建 DRAFT，直接在内存计算库存预览
  app.post<{ Body: ImmediateMealBody }>(
    '/api/v1/consumption/preview-from-recipe',
    { schema: { body: immediateMealPreviewBodySchema } },
    async (request) => {
      const { recordDate, recordTime, notes, dinerIds, relatedPlanId, ...rest } = request.body;
      return success(
        await getImmediateMealPreview(database, {
          ...rest,
          recordDate: recordDate ?? new Date().toLocaleDateString('sv-SE'),
          recordTime,
          notes,
          dinerIds,
          relatedPlanId
        })
      );
    }
  );

  // 即时用餐：真正点确认时原子创建正式记录并扣减库存（不产生 DRAFT）
  app.post<{ Body: ImmediateMealBody & { previewToken: string; operationId: string } }>(
    '/api/v1/consumption/confirm-from-recipe',
    { schema: { body: immediateMealConfirmBodySchema } },
    async (request) => {
      const { recordDate, recordTime, notes, dinerIds, relatedPlanId, ...rest } = request.body;
      return success(
        await confirmImmediateMeal(database, {
          ...rest,
          recordDate: recordDate ?? new Date().toLocaleDateString('sv-SE'),
          recordTime,
          notes,
          dinerIds,
          relatedPlanId
        })
      );
    }
  );
}
