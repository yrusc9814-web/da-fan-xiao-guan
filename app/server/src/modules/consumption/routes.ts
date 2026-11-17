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
import { isValidBusinessDate } from '../calendar/business-date.js';
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
  selections?: BatchSelections;
}

/** 缺省日期用本地业务日；显式传入时必须通过真实日历日期校验（E6）。 */
function todayBusinessDate(): string {
  return new Date().toLocaleDateString('sv-SE');
}

/**
 * 即时用餐 recordDate 校验：schema 只做 string 形状，这里补严格日历校验。
 * 拒绝 '2026-9-1' / 'abc' / 2026-02-31 等，避免写入后任何月份迭代/范围查询都看不到的幽灵记录。
 */
function resolveImmediateRecordDate(recordDate: string | undefined): string {
  if (recordDate === undefined) return todayBusinessDate();
  if (!isValidBusinessDate(recordDate)) {
    throw Object.assign(new Error('记录日期必须使用 YYYY-MM-DD 格式且为真实存在的日期'), { statusCode: 400 });
  }
  return recordDate;
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
      const { recordDate, recordTime, notes, dinerIds, ...rest } = request.body;
      return success(
        await getImmediateMealPreview(database, {
          ...rest,
          recordDate: resolveImmediateRecordDate(recordDate),
          recordTime,
          notes,
          dinerIds
        })
      );
    }
  );

  // 即时用餐：真正点确认时原子创建正式记录并扣减库存（不产生 DRAFT）
  app.post<{ Body: ImmediateMealBody & { previewToken: string; operationId: string } }>(
    '/api/v1/consumption/confirm-from-recipe',
    { schema: { body: immediateMealConfirmBodySchema } },
    async (request) => {
      const { recordDate, recordTime, notes, dinerIds, ...rest } = request.body;
      return success(
        await confirmImmediateMeal(database, {
          ...rest,
          // 与预览同一口径：显式日期必须真实存在，缺省才用本地业务日。
          // 只校验预览会让非法日期在确认时落库，形成任何视图都看不到的幽灵记录。
          recordDate: resolveImmediateRecordDate(recordDate),
          recordTime,
          notes,
          dinerIds
        })
      );
    }
  );
}
