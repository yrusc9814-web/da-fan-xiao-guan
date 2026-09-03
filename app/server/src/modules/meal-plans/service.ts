import type { MealRole, MealType, PlanItemType, PlanStatus, Prisma, PrismaClient } from '@prisma/client';

import { VersionConflictError } from '../../database/optimistic-lock.js';
import { recordDeletedItem } from '../../database/deleted-items.js';

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
  items?: PlanItemInput[];
  dinerIds?: string[];
}

const planInclude = {
  items: { orderBy: { sortOrder: 'asc' as const }, include: { recipe: true, store: true } },
  diners: { include: { diner: true } }
};

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function validatePlan(input: PlanInput): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.planDate)) throw httpError(400, '计划日期必须使用 YYYY-MM-DD 格式');
  if (!Number.isInteger(input.dinerCount) || input.dinerCount < 0) throw httpError(400, '食用人数必须是非负整数');
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
      include: { items: true, diners: true }
    });
    if (!current) throw httpError(404, '计划不存在');
    const existingDraft = await tx.mealRecord.findUnique({
      where: { sourceMealPlanId: id },
      include: { items: true, diners: true }
    });
    if (current.status === 'COMPLETED' && existingDraft)
      return { plan: current, record: existingDraft, idempotent: true };
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
    const record =
      existingDraft ??
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
        include: { items: true, diners: true }
      }));
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
      record,
      idempotent: false,
      inventoryDeductionPromptEnabled: settings.autoDeductInventory,
      pendingDraftRecordId: record.id
    };
  });
}
