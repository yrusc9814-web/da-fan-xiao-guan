import type {
  MealRole,
  MealType,
  PlanItemType,
  PlanStatus,
  Prisma,
  PrismaClient,
  RecordItemType,
  RecordSourceType
} from '@prisma/client';

import { VersionConflictError } from '../../database/optimistic-lock.js';
import { recordDeletedItem } from '../../database/deleted-items.js';
import { recordDtoWithPhotos } from '../meal-records/service.js';

export interface PlanItemInput {
  itemType: PlanItemType;
  mealRole?: MealRole | null;
  recipeId?: string | null;
  storeId?: string | null;
  customName?: string | null;
  sortOrder?: number;
}

export interface PlanInput {
  planDate: string;
  mealType: MealType;
  dinerCount: number;
  status?: PlanStatus;
  notes?: string | null;
  /** 计划就餐时间 "HH:MM" 24 小时制；null/空串表示未填写，绝不默认 12:30。 */
  time?: string | null;
  /** 计划标题（PlanPicker 目标名原文）；null 表示未填写，不由后端拼接。 */
  title?: string | null;
  /** 计划副文案（预估热量/人均渠道等原文）；null 表示未填写，不由后端生成。 */
  subtext?: string | null;
  /** 计划图标（emoji 原文）；null 表示未填写，读取侧不得以默认值替代。 */
  icon?: string | null;
  items?: PlanItemInput[];
  dinerIds?: string[];
}

const planInclude = {
  items: { orderBy: { sortOrder: 'asc' as const }, include: { recipe: true, store: true } },
  diners: { include: { diner: true } }
};

/** 计划时间严格 "HH:MM"（与前端 isValidBentoTime 同一正则），不做 12:30 兜底。 */
const PLAN_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** 计划文本字段限长（与冻结 UI 的表单容量对应；超限快速失败而非静默截断）。 */
const PLAN_TITLE_LIMIT = 200;
const PLAN_SUBTEXT_LIMIT = 200;
const PLAN_ICON_LIMIT = 20;

type PlanUncompleteSnapshot = {
  recordDate: string;
  recordTime: string | null;
  mealType: MealType;
  sourceType: RecordSourceType;
  title: string | null;
  imagePath: string | null;
  photosJson: string | null;
  rating: number | null;
  satiety: number | null;
  calories: number | null;
  cost: number | null;
  isNewTry: boolean;
  favorite: boolean;
  notes: string | null;
  relatedPlanId: string | null;
  sourceMealPlanId: string | null;
  status: string;
  items: Array<{
    itemType: RecordItemType;
    mealRole: MealRole | null;
    recipeId: string | null;
    storeId: string | null;
    customName: string | null;
    sortOrder: number;
  }>;
  dinerIds: Array<string | null>;
};
type PlanUncompleteProof = {
  origin: 'PLAN_UNCOMPLETE';
  sourcePlanId: string;
  sourceRecordId: string;
  sourcePlanVersion: number;
  sourceRecordVersion: number;
  snapshot: PlanUncompleteSnapshot;
};
function planUncompleteSnapshot(record: {
  recordDate: string;
  recordTime: string | null;
  mealType: MealType;
  sourceType: RecordSourceType;
  title: string | null;
  imagePath: string | null;
  photosJson: string | null;
  rating: number | null;
  satiety: number | null;
  calories: number | null;
  cost: number | null;
  isNewTry: boolean;
  favorite: boolean;
  notes: string | null;
  relatedPlanId: string | null;
  sourceMealPlanId: string | null;
  status: string;
  items: PlanUncompleteSnapshot['items'];
  diners: Array<{ dinerId: string | null }>;
}): PlanUncompleteSnapshot {
  return {
    recordDate: record.recordDate,
    recordTime: record.recordTime,
    mealType: record.mealType,
    sourceType: record.sourceType,
    title: record.title,
    imagePath: record.imagePath,
    photosJson: record.photosJson,
    rating: record.rating,
    satiety: record.satiety,
    calories: record.calories,
    cost: record.cost,
    isNewTry: record.isNewTry,
    favorite: record.favorite,
    notes: record.notes,
    relatedPlanId: record.relatedPlanId,
    sourceMealPlanId: record.sourceMealPlanId,
    status: record.status,
    items: record.items.map(({ itemType, mealRole, recipeId, storeId, customName, sortOrder }) => ({
      itemType,
      mealRole,
      recipeId,
      storeId,
      customName,
      sortOrder
    })),
    dinerIds: record.diners.map(({ dinerId }) => dinerId).sort()
  };
}
function parsePlanUncompleteProof(value: string | null): PlanUncompleteProof | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const proof = parsed as Partial<PlanUncompleteProof>;
    if (
      proof.origin !== 'PLAN_UNCOMPLETE' ||
      typeof proof.sourcePlanId !== 'string' ||
      typeof proof.sourceRecordId !== 'string' ||
      !Number.isSafeInteger(proof.sourcePlanVersion) ||
      !Number.isSafeInteger(proof.sourceRecordVersion) ||
      (proof.sourcePlanVersion as number) <= 0 ||
      (proof.sourceRecordVersion as number) <= 0 ||
      !proof.snapshot ||
      typeof proof.snapshot !== 'object'
    )
      return null;
    return proof as PlanUncompleteProof;
  } catch {
    return null;
  }
}

/**
 * 计划可空文本字段：null/undefined → null；空串/纯空白 → null（等价“未填写”）；
 * 非字符串或超限 → 400。null 意味着清空，省略意味着保留，二者语义不同。
 */
function cleanedPlanText(value: unknown, field: string, limit: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw httpError(400, `${field}必须是字符串`);
  const cleaned = value.trim();
  if (cleaned.length > limit) throw httpError(400, `${field}不能超过 ${limit} 个字符`);
  return cleaned || null;
}

/** 计划时间：null/空串 → null；其余必须是严格 "HH:MM"，失败 400（不造时间）。 */
function cleanedPlanTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw httpError(400, '计划时间必须是字符串');
  const cleaned = value.trim();
  if (!cleaned) return null;
  if (!PLAN_TIME_PATTERN.test(cleaned)) throw httpError(400, '计划时间必须使用 HH:MM 24 小时制格式');
  return cleaned;
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function validatePlan(input: PlanInput): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.planDate)) throw httpError(400, '计划日期必须使用 YYYY-MM-DD 格式');
  if (!Number.isInteger(input.dinerCount) || input.dinerCount < 0) throw httpError(400, '食用人数必须是非负整数');
  cleanedPlanTime(input.time);
  cleanedPlanText(input.title, '计划标题', PLAN_TITLE_LIMIT);
  cleanedPlanText(input.subtext, '计划副文案', PLAN_SUBTEXT_LIMIT);
  cleanedPlanText(input.icon, '计划图标', PLAN_ICON_LIMIT);
  for (const item of input.items ?? []) {
    const links =
      Number(Boolean(item.recipeId)) + Number(Boolean(item.storeId)) + Number(Boolean(item.customName?.trim()));
    if (links !== 1) throw httpError(400, '每个计划项目必须且只能关联菜谱、店铺或自定义名称之一');
    if (
      (item.itemType === 'RECIPE') !== Boolean(item.recipeId) ||
      (item.itemType === 'STORE') !== Boolean(item.storeId) ||
      (item.itemType === 'CUSTOM') !== Boolean(item.customName?.trim())
    ) {
      throw httpError(400, '计划项目类型与关联内容不一致');
    }
  }
}

function itemCreates(items: PlanItemInput[] = []): Prisma.MealPlanItemCreateWithoutMealPlanInput[] {
  return items.map((item, index) => ({
    itemType: item.itemType,
    mealRole: item.mealRole ?? null,
    recipe: item.recipeId ? { connect: { id: item.recipeId } } : undefined,
    store: item.storeId ? { connect: { id: item.storeId } } : undefined,
    customName: item.customName?.trim() || null,
    sortOrder: item.sortOrder ?? index
  }));
}

export async function listPlans(database: PrismaClient, query: { from?: string; to?: string; status?: PlanStatus }) {
  return database.mealPlan.findMany({
    where: {
      deletedAt: null,
      ...(query.from || query.to
        ? { planDate: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
      ...(query.status ? { status: query.status } : {})
    },
    include: planInclude,
    orderBy: [{ planDate: 'asc' }, { mealType: 'asc' }]
  });
}

export async function getPlan(database: PrismaClient, id: string) {
  const plan = await database.mealPlan.findFirst({ where: { id, deletedAt: null }, include: planInclude });
  if (!plan) throw httpError(404, '计划不存在');
  return plan;
}

export async function createPlan(database: PrismaClient, input: PlanInput) {
  validatePlan(input);
  const status = input.status ?? 'PLANNED';
  if (status === 'COMPLETED' || status === 'CANCELLED') throw httpError(400, '新计划只能是未安排或已安排状态');
  return database.$transaction(async (tx) => {
    const existing = await tx.mealPlan.findUnique({
      where: { planDate_mealType: { planDate: input.planDate, mealType: input.mealType } }
    });
    if (existing && existing.deletedAt === null) throw httpError(409, '该日期和餐次已存在计划');
    if (existing) {
      await tx.deletedItem.deleteMany({ where: { entityType: 'MealPlan', entityId: existing.id } });
      await tx.mealPlanItem.deleteMany({ where: { mealPlanId: existing.id } });
      await tx.mealPlanDiner.deleteMany({ where: { mealPlanId: existing.id } });
      await tx.mealPlan.update({
        where: { id: existing.id },
        data: {
          dinerCount: input.dinerCount,
          status,
          notes: input.notes ?? null,
          time: cleanedPlanTime(input.time),
          title: cleanedPlanText(input.title, '计划标题', PLAN_TITLE_LIMIT),
          subtext: cleanedPlanText(input.subtext, '计划副文案', PLAN_SUBTEXT_LIMIT),
          icon: cleanedPlanText(input.icon, '计划图标', PLAN_ICON_LIMIT),
          deletedAt: null,
          completedAt: null,
          version: { increment: 1 },
          items: { create: itemCreates(input.items) },
          diners: { create: [...new Set(input.dinerIds ?? [])].map((dinerId) => ({ dinerId })) }
        }
      });
      return tx.mealPlan.findUniqueOrThrow({ where: { id: existing.id }, include: planInclude });
    }
    return tx.mealPlan.create({
      data: {
        planDate: input.planDate,
        mealType: input.mealType,
        dinerCount: input.dinerCount,
        status,
        notes: input.notes ?? null,
        time: cleanedPlanTime(input.time),
        title: cleanedPlanText(input.title, '计划标题', PLAN_TITLE_LIMIT),
        subtext: cleanedPlanText(input.subtext, '计划副文案', PLAN_SUBTEXT_LIMIT),
        icon: cleanedPlanText(input.icon, '计划图标', PLAN_ICON_LIMIT),
        items: { create: itemCreates(input.items) },
        diners: { create: [...new Set(input.dinerIds ?? [])].map((dinerId) => ({ dinerId })) }
      },
      include: planInclude
    });
  });
}

export async function updatePlan(database: PrismaClient, id: string, version: number, input: Partial<PlanInput>) {
  return database.$transaction(async (tx) => {
    const current = await tx.mealPlan.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw httpError(404, '计划不存在');
    if (current.version !== version)
      throw new VersionConflictError({
        entity: 'MealPlan',
        id,
        expectedVersion: version,
        actualVersion: current.version
      });
    if (current.status === 'COMPLETED') throw httpError(409, '已完成计划不能修改');
    if (current.status === 'CANCELLED' && input.status !== 'CANCELLED')
      throw httpError(409, '已取消计划不能恢复为其他状态');
    if (input.status === 'COMPLETED') throw httpError(409, '请使用完成计划操作，不能直接修改为已完成');
    if (current.status === 'PLANNED' && input.status === 'UNPLANNED') throw httpError(409, '已安排计划不能退回未安排');
    const merged: PlanInput = {
      planDate: input.planDate ?? current.planDate,
      mealType: input.mealType ?? current.mealType,
      dinerCount: input.dinerCount ?? current.dinerCount,
      status: input.status ?? current.status,
      notes: input.notes === undefined ? current.notes : input.notes,
      // 省略 → 保留旧值；显式 null/空串 → 清空（与 notes 同一既有语义）。
      time: input.time === undefined ? current.time : input.time,
      title: input.title === undefined ? current.title : input.title,
      subtext: input.subtext === undefined ? current.subtext : input.subtext,
      icon: input.icon === undefined ? current.icon : input.icon,
      items: input.items
    };
    validatePlan(merged);
    if (input.items) await tx.mealPlanItem.deleteMany({ where: { mealPlanId: id } });
    if (input.dinerIds) await tx.mealPlanDiner.deleteMany({ where: { mealPlanId: id } });
    await tx.mealPlan.update({
      where: { id },
      data: {
        planDate: merged.planDate,
        mealType: merged.mealType,
        dinerCount: merged.dinerCount,
        status: merged.status,
        notes: merged.notes,
        time: cleanedPlanTime(merged.time),
        title: cleanedPlanText(merged.title, '计划标题', PLAN_TITLE_LIMIT),
        subtext: cleanedPlanText(merged.subtext, '计划副文案', PLAN_SUBTEXT_LIMIT),
        icon: cleanedPlanText(merged.icon, '计划图标', PLAN_ICON_LIMIT),
        version: { increment: 1 },
        ...(input.items ? { items: { create: itemCreates(input.items) } } : {}),
        ...(input.dinerIds ? { diners: { create: [...new Set(input.dinerIds)].map((dinerId) => ({ dinerId })) } } : {})
      }
    });
    return tx.mealPlan.findUniqueOrThrow({ where: { id }, include: planInclude });
  });
}

export async function deletePlan(database: PrismaClient, id: string, version: number) {
  return database.$transaction(async (tx) => {
    const current = await tx.mealPlan.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw httpError(404, '计划不存在');
    if (current.version !== version)
      throw new VersionConflictError({
        entity: 'MealPlan',
        id,
        expectedVersion: version,
        actualVersion: current.version
      });
    if (current.status === 'COMPLETED') throw httpError(409, '已完成计划已关联饮食记录，不能删除');
    const deletedAt = new Date();
    await tx.mealPlan.update({ where: { id }, data: { deletedAt, version: { increment: 1 } } });
    await recordDeletedItem(tx, 'MealPlan', id, deletedAt);
    return { id };
  });
}

export async function cancelPlan(database: PrismaClient, id: string, version: number) {
  const current = await getPlan(database, id);
  if (current.status === 'COMPLETED') throw httpError(409, '已完成计划不能取消');
  if (current.status === 'CANCELLED') return current;
  return updatePlan(database, id, version, { status: 'CANCELLED' });
}

export async function completePlan(database: PrismaClient, id: string, version: number) {
  return database.$transaction(async (tx) => {
    const current = await tx.mealPlan.findFirst({
      where: { id, deletedAt: null },
      include: {
        items: { orderBy: { sortOrder: 'asc' as const }, include: { recipe: true, store: true } },
        diners: true
      }
    });
    if (!current) throw httpError(404, '计划不存在');
    const existingDraft = await tx.mealRecord.findUnique({
      where: { sourceMealPlanId: id },
      include: {
        items: { orderBy: { sortOrder: 'asc' as const }, include: { recipe: true, store: true } },
        diners: true
      }
    });
    if (current.status === 'COMPLETED' && existingDraft && existingDraft.deletedAt === null)
      return {
        plan: current,
        record: recordDtoWithPhotos(existingDraft),
        idempotent: true
      };
    if (current.version !== version)
      throw new VersionConflictError({
        entity: 'MealPlan',
        id,
        expectedVersion: version,
        actualVersion: current.version
      });
    if (current.status === 'CANCELLED') throw httpError(409, '已取消计划不能完成');
    if (current.items.length === 0) throw httpError(400, '空计划不能完成');

    const sourceType = current.items.every((item) => item.itemType === 'STORE') ? 'DINE_IN' : 'HOMEMADE';
    // 仅允许出现在「上一轮完成 → 撤销」后的软删除自动记录：复活并以当前计划内容刷新关联，
    // 保证 sourceMealPlanId 唯一约束不与新生成冲突，计划项目改动后再次完成仍得到正确记录。
    if (existingDraft && existingDraft.deletedAt !== null) {
      if (existingDraft.status !== 'DRAFT' || (await recordHasConsumptionHistory(tx, existingDraft.id)))
        throw httpError(409, '关联饮食记录已确认或已有消费历史，不能覆盖；请先处理该记录');
      const deletionProof = await tx.deletedItem.findUnique({
        where: { entityType_entityId: { entityType: 'MealRecord', entityId: existingDraft.id } },
        select: { planUncompleteProof: true }
      });
      const parsedProof = parsePlanUncompleteProof(deletionProof?.planUncompleteProof ?? null);
      const snapshotMatches =
        parsedProof !== null &&
        parsedProof.sourcePlanId === id &&
        parsedProof.sourceRecordId === existingDraft.id &&
        parsedProof.sourceRecordVersion === existingDraft.version &&
        JSON.stringify(parsedProof.snapshot) === JSON.stringify(planUncompleteSnapshot(existingDraft));
      // planUncompleteProof 是唯一可信 provenance；普通删除、缺失、畸形或快照变化一律拒绝。
      // 仅依据 typed proof snapshot、版本和当前记录状态判断自动草稿；不使用归档时间推断用户是否编辑。
      if (
        current.status === 'COMPLETED' ||
        !parsedProof ||
        !snapshotMatches ||
        !isUneditedAutomaticRecord(existingDraft, existingDraft.sourceType)
      )
        throw httpError(409, '关联饮食记录包含用户编辑或无法证明为自动草稿，不能覆盖；请先处理该记录');
      await tx.deletedItem.deleteMany({ where: { entityType: 'MealRecord', entityId: existingDraft.id } });
      await tx.mealRecordItem.deleteMany({ where: { mealRecordId: existingDraft.id } });
      await tx.mealRecordDiner.deleteMany({ where: { mealRecordId: existingDraft.id } });
      await tx.mealRecord.update({
        where: { id: existingDraft.id },
        data: {
          recordDate: current.planDate,
          mealType: current.mealType,
          sourceType,
          deletedAt: null,
          version: { increment: 1 },
          items: {
            create: current.items.map((item) => ({
              itemType: item.itemType,
              mealRole: item.mealRole,
              recipeId: item.recipeId,
              storeId: item.storeId,
              customName: item.customName,
              sortOrder: item.sortOrder
            }))
          },
          diners: { create: current.diners.map((link) => ({ dinerId: link.dinerId })) }
        }
      });
    }
    const record =
      existingDraft && existingDraft.deletedAt !== null
        ? await tx.mealRecord.findUniqueOrThrow({
            where: { id: existingDraft.id },
            include: {
              items: { orderBy: { sortOrder: 'asc' as const }, include: { recipe: true, store: true } },
              diners: true
            }
          })
        : (existingDraft ??
          (await tx.mealRecord.create({
            data: {
              recordDate: current.planDate,
              mealType: current.mealType,
              sourceType,
              status: 'DRAFT',
              relatedPlanId: id,
              sourceMealPlanId: id,
              items: {
                create: current.items.map((item) => ({
                  itemType: item.itemType,
                  mealRole: item.mealRole,
                  recipeId: item.recipeId,
                  storeId: item.storeId,
                  customName: item.customName,
                  sortOrder: item.sortOrder
                }))
              },
              diners: { create: current.diners.map((link) => ({ dinerId: link.dinerId })) }
            },
            include: {
              items: { orderBy: { sortOrder: 'asc' as const }, include: { recipe: true, store: true } },
              diners: true
            }
          })));
    const [plan, settings] = await Promise.all([
      tx.mealPlan.update({
        where: { id },
        data: { status: 'COMPLETED', completedAt: new Date(), version: { increment: 1 } },
        include: planInclude
      }),
      tx.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {}, select: { autoDeductInventory: true } })
    ]);
    return {
      plan,
      record: recordDtoWithPhotos(record),
      idempotent: false,
      inventoryDeductionPromptEnabled: settings.autoDeductInventory
    };
  });
}

async function recordHasConsumptionHistory(tx: Prisma.TransactionClient, recordId: string): Promise<boolean> {
  const [logs, operations] = await Promise.all([
    tx.inventoryLog.count({ where: { relatedRecordId: recordId } }),
    tx.consumptionOperation.count({ where: { mealRecordId: recordId } })
  ]);
  return logs > 0 || operations > 0;
}

function isUneditedAutomaticRecord(
  record: Parameters<typeof isAutomaticPlanRecord>[0],
  sourceType: RecordSourceType
): boolean {
  return (
    record.sourceType === sourceType &&
    record.title === null &&
    record.recordTime === null &&
    record.imagePath === null &&
    record.photosJson === null &&
    record.rating === null &&
    record.satiety === null &&
    record.calories === null &&
    record.cost === null &&
    !record.isNewTry &&
    !record.favorite &&
    record.notes === null
  );
}

function isAutomaticPlanRecord(
  record: {
    recordDate: string;
    mealType: MealType;
    sourceType: RecordSourceType;
    title?: string | null;
    recordTime: string | null;
    imagePath: string | null;
    photosJson: string | null;
    rating: number | null;
    satiety: number | null;
    calories: number | null;
    cost: number | null;
    isNewTry: boolean;
    favorite: boolean;
    notes: string | null;
    relatedPlanId: string | null;
    sourceMealPlanId: string | null;
    items: Array<{
      itemType: RecordItemType;
      mealRole: MealRole | null;
      recipeId: string | null;
      storeId: string | null;
      customName: string | null;
      sortOrder: number;
    }>;
    diners: Array<{ dinerId: string | null }>;
  },
  plan: {
    id: string;
    planDate: string;
    mealType: MealType;
    items: Array<{
      itemType: PlanItemType;
      mealRole: MealRole | null;
      recipeId: string | null;
      storeId: string | null;
      customName: string | null;
      sortOrder: number;
    }>;
    diners: Array<{ dinerId: string | null }>;
  }
): boolean {
  if (
    record.recordDate !== plan.planDate ||
    record.mealType !== plan.mealType ||
    record.sourceType !==
      (plan.items.length > 0 && plan.items.every((item) => item.itemType === 'STORE') ? 'DINE_IN' : 'HOMEMADE') ||
    record.relatedPlanId !== plan.id ||
    record.sourceMealPlanId !== plan.id ||
    record.title !== null ||
    record.recordTime !== null ||
    record.imagePath !== null ||
    record.photosJson !== null ||
    record.rating !== null ||
    record.satiety !== null ||
    record.calories !== null ||
    record.cost !== null ||
    record.isNewTry ||
    record.favorite ||
    record.notes !== null
  )
    return false;
  const recordItems = record.items.map(({ itemType, mealRole, recipeId, storeId, customName, sortOrder }) => ({
    itemType,
    mealRole,
    recipeId,
    storeId,
    customName,
    sortOrder
  }));
  const planItems = plan.items.map(({ itemType, mealRole, recipeId, storeId, customName, sortOrder }) => ({
    itemType,
    mealRole,
    recipeId,
    storeId,
    customName,
    sortOrder
  }));
  const recordDinerIds = record.diners.map(({ dinerId }) => dinerId).sort();
  const planDinerIds = plan.diners.map(({ dinerId }) => dinerId).sort();
  return (
    JSON.stringify(recordItems) === JSON.stringify(planItems) &&
    JSON.stringify(recordDinerIds) === JSON.stringify(planDinerIds)
  );
}

/**
 * 撤销完成计划：仅合法 COMPLETED → PLANNED。
 *
 * - 乐观锁：version 必须与当前计划一致，否则 409 VERSION_CONFLICT。
 * - 幂等：计划已不是 COMPLETED（PLANNED/UNPLANNED/CANCELLED）时直接返回当前计划，
 *   不产生任何写入，idempotent=true，前端重复点击安全。
 * - 关联生成记录保护：
 *   - 仅 sourceMealPlanId 指向本计划且无库存消费历史（InventoryLog / ConsumptionOperation 均无）
 *     的 DRAFT 记录会被软删除（deletedAt + DeletedItem，保留回收站 30 天可恢复），
 *     不是物理删除，用户手工编辑过的字段不丢数据。
 *   - 已 CONFIRMED、或存在任何库存消费历史的记录绝不删除：返回 409，界面必须如实报错，
 *     绝不回滚库存、绝不擅自删用户数据，也绝不谎报撤销成功。
 * - 不触碰库存：本操作不做任何库存回滚（库存确认不在本轮范围）。
 */
export async function uncompletePlan(database: PrismaClient, id: string, version: number) {
  return database.$transaction(async (tx) => {
    const current = await tx.mealPlan.findFirst({ where: { id, deletedAt: null }, include: planInclude });
    if (!current) throw httpError(404, '计划不存在');
    // 幂等：目标状态（非 COMPLETED）已达成时直接返回当前计划，不做任何写入。
    // 与 repo 既有 cancelPlan/completePlan 的重复请求语义一致。
    if (current.status !== 'COMPLETED') return { plan: current, removedRecord: null, idempotent: true };
    // 乐观锁只守护真正的状态迁移 COMPLETED → PLANNED。
    if (current.version !== version)
      throw new VersionConflictError({
        entity: 'MealPlan',
        id,
        expectedVersion: version,
        actualVersion: current.version
      });

    const sourceRecord = await tx.mealRecord.findFirst({
      where: { sourceMealPlanId: id, deletedAt: null },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        diners: true
      }
    });
    let removedRecord: { id: string } | null = null;
    if (sourceRecord) {
      if (sourceRecord.status === 'CONFIRMED')
        throw httpError(409, '关联饮食记录已确认，不能撤销完成；请先在饮食记录中处理该记录');
      if (await recordHasConsumptionHistory(tx, sourceRecord.id))
        throw httpError(409, '关联饮食记录已有库存扣减历史，不能撤销完成');
      if (!isAutomaticPlanRecord(sourceRecord, current))
        throw httpError(409, '关联饮食记录包含用户编辑，不能撤销完成；请先处理该记录');
      const deletedAt = new Date();
      const sourceRecordVersion = sourceRecord.version + 1;
      await tx.mealRecord.update({
        where: { id: sourceRecord.id },
        data: { deletedAt, version: { increment: 1 } }
      });
      await recordDeletedItem(tx, 'MealRecord', sourceRecord.id, deletedAt);
      const proof: PlanUncompleteProof = {
        origin: 'PLAN_UNCOMPLETE',
        sourcePlanId: id,
        sourceRecordId: sourceRecord.id,
        sourcePlanVersion: current.version,
        sourceRecordVersion,
        snapshot: planUncompleteSnapshot(sourceRecord)
      };
      await tx.deletedItem.update({
        where: { entityType_entityId: { entityType: 'MealRecord', entityId: sourceRecord.id } },
        data: { planUncompleteProof: JSON.stringify(proof) }
      });
      removedRecord = { id: sourceRecord.id };
    }

    const plan = await tx.mealPlan.update({
      where: { id },
      data: { status: 'PLANNED', completedAt: null, version: { increment: 1 } },
      include: planInclude
    });
    return { plan, removedRecord, idempotent: false };
  });
}
