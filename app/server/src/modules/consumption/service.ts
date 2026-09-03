import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient, QuantityUnit, RecordSourceType, MealType } from '@prisma/client';

import { convertQuantity } from '../../database/units.js';
import { VersionConflictError } from '../../database/optimistic-lock.js';

type Database = PrismaClient | Prisma.TransactionClient;
export type BatchSelections = Record<string, string[]>;

interface Allocation {
  batchId: string;
  batchVersion: number;
  quantity: number;
  unit: QuantityUnit;
}
interface PreviewItem {
  recipeIngredientId: string;
  ingredientId: string | null;
  ingredientName: string;
  requiredQuantity: number;
  unit: QuantityUnit;
  allocations: Allocation[];
  availableBatches: Array<
    Allocation & { availableQuantity: number; expiryDate: string | null; location: string | null }
  >;
  shortageQuantity: number;
  requiresManualSelection: boolean;
}

interface RecipeLike {
  id: string;
  servings: number | null;
  ingredients: Array<{
    id: string;
    ingredientId: string | null;
    ingredientNameSnapshot: string;
    quantity: number | null;
    unit: QuantityUnit | null;
    optional: boolean;
  }>;
}

/** 即时用餐确认所需的记录上下文（无需先落库 DRAFT 记录）。 */
export interface ImmediateMealInput {
  recordDate: string;
  recordTime?: string | null;
  mealType: MealType;
  sourceType: RecordSourceType;
  notes?: string | null;
  dinerIds?: string[];
  /** 完成该计划（POST /plans/:id/complete）后收口计划时，把正式记录关联回原计划。 */
  relatedPlanId?: string | null;
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}
function round(value: number): number {
  return Number(value.toFixed(6));
}
function today(): string {
  return new Date().toLocaleDateString('sv-SE');
}
function previewHash(payload: object): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function buildPreviewForRecipe(
  database: Database,
  recipe: RecipeLike,
  dinerCount: number,
  selections: BatchSelections = {}
) {
  const items: PreviewItem[] = [];
  const scale = dinerCount / Math.max(recipe.servings ?? dinerCount, 1);
  for (const recipeIngredient of recipe.ingredients) {
    if (recipeIngredient.optional || recipeIngredient.quantity == null || recipeIngredient.unit == null) continue;
    const required = round(recipeIngredient.quantity * scale);
    const requiredUnit = recipeIngredient.unit;
    const base: PreviewItem = {
      recipeIngredientId: recipeIngredient.id,
      ingredientId: recipeIngredient.ingredientId,
      ingredientName: recipeIngredient.ingredientNameSnapshot,
      requiredQuantity: required,
      unit: requiredUnit,
      allocations: [],
      availableBatches: [],
      shortageQuantity: required,
      requiresManualSelection: false
    };
    if (!recipeIngredient.ingredientId) {
      items.push(base);
      continue;
    }

    let candidates = await database.inventoryBatch.findMany({
      where: {
        ingredientId: recipeIngredient.ingredientId,
        deletedAt: null,
        quantity: { gt: 0 },
        OR: [{ expiryDate: null }, { expiryDate: { gte: today() } }]
      },
      orderBy: [{ consumePriority: 'desc' }, { expiryDate: 'asc' }, { createdAt: 'asc' }]
    });
    const selectionProvided = Object.hasOwn(selections, recipeIngredient.id);
    const selectedIds = selections[recipeIngredient.id] ?? [];
    if (selectionProvided) {
      const order = new Map(selectedIds.map((id, index) => [id, index]));
      candidates = candidates
        .filter((batch) => order.has(batch.id))
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
    const compatible = candidates.filter((batch) => convertQuantity(1, batch.unit, requiredUnit) !== null);
    const allCompatible = selectionProvided
      ? await database.inventoryBatch.findMany({
          where: {
            ingredientId: recipeIngredient.ingredientId,
            deletedAt: null,
            quantity: { gt: 0 },
            OR: [{ expiryDate: null }, { expiryDate: { gte: today() } }]
          },
          orderBy: [{ consumePriority: 'desc' }, { expiryDate: 'asc' }, { createdAt: 'asc' }]
        })
      : compatible;
    base.availableBatches = allCompatible
      .filter((batch) => convertQuantity(1, batch.unit, requiredUnit) !== null)
      .map((batch) => ({
        batchId: batch.id,
        batchVersion: batch.version,
        quantity: batch.quantity,
        availableQuantity: batch.quantity,
        unit: batch.unit,
        expiryDate: batch.expiryDate,
        location: batch.location
      }));
    base.requiresManualSelection = compatible.length > 1 && !selectionProvided;
    let remaining = required;
    for (const batch of compatible) {
      const availableInRequiredUnit = convertQuantity(batch.quantity, batch.unit, requiredUnit) ?? 0;
      const takeInRequiredUnit = Math.min(remaining, availableInRequiredUnit);
      const takeInBatchUnit = convertQuantity(takeInRequiredUnit, requiredUnit, batch.unit) ?? 0;
      if (takeInBatchUnit > 0)
        base.allocations.push({
          batchId: batch.id,
          batchVersion: batch.version,
          quantity: round(takeInBatchUnit),
          unit: batch.unit
        });
      remaining = round(remaining - takeInRequiredUnit);
      if (remaining <= 0) break;
    }
    base.shortageQuantity = Math.max(0, remaining);
    items.push(base);
  }
  return items;
}

async function buildPreview(
  database: Database,
  recordId: string,
  recordVersion: number,
  selections: BatchSelections = {}
) {
  const record = await database.mealRecord.findFirst({
    where: { id: recordId, deletedAt: null },
    include: {
      sourceMealPlan: true,
      diners: true,
      items: {
        orderBy: { sortOrder: 'asc' },
        include: { recipe: { include: { ingredients: { orderBy: { sortOrder: 'asc' } } } } }
      }
    }
  });
  if (!record) throw httpError(404, '饮食记录不存在');
  if (record.version !== recordVersion)
    throw new VersionConflictError({
      entity: 'MealRecord',
      id: record.id,
      expectedVersion: recordVersion,
      actualVersion: record.version
    });
  if (record.status !== 'DRAFT') throw httpError(409, '只有日记草稿可以预览库存扣减');

  const dinerCount = Math.max(record.sourceMealPlan?.dinerCount ?? record.diners.length, 1);
  const items: PreviewItem[] = [];
  for (const recordItem of record.items) {
    if (!recordItem.recipe) continue;
    const recipeItems = await buildPreviewForRecipe(database, recordItem.recipe, dinerCount, selections);
    items.push(...recipeItems);
  }
  const hashPayload = { recordId: record.id, recordVersion: record.version, items };
  return { recordId: record.id, recordVersion: record.version, previewToken: previewHash(hashPayload), items };
}

export async function getConsumptionPreview(
  database: PrismaClient,
  recordId: string,
  recordVersion: number,
  selections?: BatchSelections
) {
  return buildPreview(database, recordId, recordVersion, selections);
}

async function mergeShortage(tx: Prisma.TransactionClient, listId: string, item: PreviewItem): Promise<void> {
  if (item.shortageQuantity <= 0) return;
  const existing = await tx.shoppingListItem.findMany({
    where: { shoppingListId: listId, completed: false, sourceType: 'INSUFFICIENT_STOCK' }
  });
  const match = existing.find(
    (candidate) =>
      (item.ingredientId
        ? candidate.ingredientId === item.ingredientId
        : candidate.ingredientNameSnapshot === item.ingredientName) &&
      convertQuantity(1, item.unit, candidate.unit) !== null
  );
  if (match) {
    const quantity = convertQuantity(item.shortageQuantity, item.unit, match.unit);
    if (quantity !== null) {
      await tx.shoppingListItem.update({ where: { id: match.id }, data: { quantity: { increment: quantity } } });
      return;
    }
  }
  await tx.shoppingListItem.create({
    data: {
      shoppingListId: listId,
      ingredientId: item.ingredientId,
      ingredientNameSnapshot: item.ingredientName,
      quantity: item.shortageQuantity,
      unit: item.unit,
      sourceType: 'INSUFFICIENT_STOCK',
      sourceId: item.recipeIngredientId,
      sortOrder: existing.length
    }
  });
}

/**
 * 在事务内执行库存扣减、缺料并入购物清单、刷新食材汇总。
 * 供「先建 DRAFT 再确认」与「即时用餐直接确认」两条路径复用。
 */
async function applyConsumption(
  tx: Prisma.TransactionClient,
  items: PreviewItem[],
  recordId: string
): Promise<{ logIds: string[]; shoppingListId: string | null }> {
  const logIds: string[] = [];
  for (const item of items) {
    for (const allocation of item.allocations) {
      const batch = await tx.inventoryBatch.findUnique({
        where: { id: allocation.batchId },
        include: { ingredient: true }
      });
      if (!batch || batch.deletedAt || batch.version !== allocation.batchVersion)
        throw httpError(409, '库存批次已变化，请重新预览');
      const after = round(batch.quantity - allocation.quantity);
      if (after < 0) throw httpError(409, '库存数量不足，请重新预览');
      const updated = await tx.inventoryBatch.updateMany({
        where: { id: batch.id, version: batch.version, deletedAt: null, quantity: { gte: allocation.quantity } },
        data: { quantity: after, version: { increment: 1 } }
      });
      if (!updated.count) throw httpError(409, '库存批次已变化，请重新预览');
      const log = await tx.inventoryLog.create({
        data: {
          ingredientId: batch.ingredientId,
          ingredientNameSnapshot: batch.ingredient.name,
          inventoryBatchId: batch.id,
          beforeQuantity: batch.quantity,
          changeQuantity: -allocation.quantity,
          afterQuantity: after,
          unit: batch.unit,
          changeType: 'COOK_DEDUCT',
          relatedRecordId: recordId
        }
      });
      logIds.push(log.id);
    }
  }

  const active = items.some((item) => item.shortageQuantity > 0)
    ? await tx.shoppingList.findFirst({
        where: { deletedAt: null, status: 'ACTIVE' },
        orderBy: { updatedAt: 'desc' }
      })
    : null;
  const shopping =
    active ??
    (items.some((item) => item.shortageQuantity > 0)
      ? await tx.shoppingList.create({ data: { name: '库存不足待采购' } })
      : null);
  if (shopping) {
    for (const item of items) await mergeShortage(tx, shopping.id, item);
    await tx.shoppingList.update({ where: { id: shopping.id }, data: { version: { increment: 1 } } });
  }

  for (const ingredientId of new Set(
    items.map((item) => item.ingredientId).filter((id): id is string => Boolean(id))
  )) {
    const ingredient = await tx.ingredient.findUnique({
      where: { id: ingredientId },
      include: { inventoryBatches: { where: { deletedAt: null } } }
    });
    if (!ingredient) continue;
    const quantity = ingredient.inventoryBatches.reduce(
      (sum, batch) => sum + (convertQuantity(batch.quantity, batch.unit, ingredient.unit) ?? 0),
      0
    );
    await tx.ingredient.update({ where: { id: ingredient.id }, data: { quantity, version: { increment: 1 } } });
  }

  return { logIds, shoppingListId: shopping?.id ?? null };
}

export async function confirmConsumption(
  database: PrismaClient,
  input: {
    recordId: string;
    recordVersion: number;
    previewToken: string;
    operationId: string;
    selections?: BatchSelections;
  }
) {
  if (!input.operationId?.trim()) throw httpError(400, 'operationId 不能为空');
  return database.$transaction(async (tx) => {
    const previous = await tx.consumptionOperation.findUnique({ where: { id: input.operationId } });
    if (previous) {
      if (previous.mealRecordId !== input.recordId || previous.previewHash !== input.previewToken) {
        throw httpError(409, 'operationId 已用于另一笔扣减请求');
      }
      const result = JSON.parse(previous.resultJson) as Record<string, unknown>;
      return { ...result, repeated: true };
    }
    const preview = await buildPreview(tx, input.recordId, input.recordVersion, input.selections);
    if (preview.previewToken !== input.previewToken) throw httpError(409, '库存已变化，请重新预览后确认');
    if (preview.items.some((item) => item.requiresManualSelection))
      throw httpError(422, '存在多个可用库存批次，请先明确选择批次');

    const { logIds, shoppingListId } = await applyConsumption(tx, preview.items, input.recordId);

    const record = await tx.mealRecord.update({
      where: { id: input.recordId },
      data: { status: 'CONFIRMED', confirmedAt: new Date(), version: { increment: 1 } }
    });
    const result = {
      operationId: input.operationId,
      recordId: record.id,
      recordVersion: record.version,
      inventoryLogIds: logIds,
      shoppingListId,
      repeated: false
    };
    await tx.consumptionOperation.create({
      data: {
        id: input.operationId,
        mealRecordId: record.id,
        previewHash: input.previewToken,
        resultJson: JSON.stringify(result)
      }
    });
    return result;
  });
}

interface PlanMealContext {
  mealType: MealType;
  recordDate: string;
  dinerCount: number;
  dinerIds: string[];
  /** 复用既有 MealPlan.version 乐观锁：preview 与 confirm 之间计划任何变更都会使 token 失效。 */
  planVersion: number;
}

/**
 * 计划完成语义：从饮食计划收口（relatedPlanId）时，记录必须以计划为准——
 * 餐次、记录日期取计划值；人数按计划人数缩放；完成后把计划置为已完成。
 * 仅允许「单条 RECIPE 计划」走即时用餐链路（与计划页/推荐入计划的口径一致），
 * 多项目计划仍由 MealPlansPage 走既有 completePlan（DRAFT + 后续确认）。
 */
async function resolvePlanCompletion(database: Database, planId: string, recipeId: string): Promise<PlanMealContext> {
  const plan = await database.mealPlan.findFirst({
    where: { id: planId, deletedAt: null },
    include: { items: true, diners: true }
  });
  if (!plan) throw httpError(404, '计划不存在');
  if (plan.status === 'CANCELLED') throw httpError(409, '该计划已取消，不能完成');
  if (plan.status === 'COMPLETED') throw httpError(409, '该计划已完成，无需重复记录');
  const singleItem = plan.items[0];
  if (plan.items.length !== 1 || singleItem.itemType !== 'RECIPE' || singleItem.recipeId !== recipeId) {
    throw httpError(409, '该计划包含多个项目，请在计划页完成这一餐');
  }
  return {
    mealType: plan.mealType,
    recordDate: plan.planDate,
    dinerCount: Math.max(plan.dinerCount ?? 1, 1),
    dinerIds: plan.diners.map((link) => link.dinerId).filter((id): id is string => Boolean(id)),
    planVersion: plan.version
  };
}

/**
 * 即时用餐 previewToken：完整绑定会影响最终完成语义的上下文——
 * 菜谱、关联计划（relatedPlanId + planVersion）、餐次、记录日期、人数与库存快照。
 * Preview 与 Confirm 必须逐字段一致，否则 409，杜绝「Preview 计划 A / Confirm 计划 B」
 * 或「Preview 晚餐 / Confirm 早餐」的静默错配。
 */
function immediatePreviewToken(
  input: Pick<ImmediateMealInput, 'mealType' | 'recordDate' | 'relatedPlanId'> & { recipeId: string },
  planContext: PlanMealContext | null,
  dinerCount: number,
  items: PreviewItem[]
): string {
  return previewHash({
    recipeId: input.recipeId,
    relatedPlanId: input.relatedPlanId ?? null,
    planVersion: planContext?.planVersion ?? null,
    mealType: input.mealType,
    recordDate: input.recordDate,
    dinerCount,
    items
  });
}

export async function getImmediateMealPreview(
  database: PrismaClient,
  input: ImmediateMealInput & { recipeId: string; selections?: BatchSelections }
) {
  const recipe = await database.recipe.findFirst({
    where: { id: input.recipeId, deletedAt: null },
    include: { ingredients: { orderBy: { sortOrder: 'asc' } } }
  });
  if (!recipe) throw httpError(404, '菜谱不存在');
  const planContext = input.relatedPlanId
    ? await resolvePlanCompletion(database, input.relatedPlanId, input.recipeId)
    : null;
  const dinerCount = Math.max(planContext?.dinerCount ?? input.dinerIds?.length ?? 1, 1);
  const items = await buildPreviewForRecipe(database, recipe, dinerCount, input.selections);
  const previewToken = immediatePreviewToken(input, planContext, dinerCount, items);
  return { recipeId: input.recipeId, dinerCount, previewToken, items };
}

export async function confirmImmediateMeal(
  database: PrismaClient,
  input: ImmediateMealInput & {
    recipeId: string;
    previewToken: string;
    operationId: string;
    selections?: BatchSelections;
  }
) {
  if (!input.operationId?.trim()) throw httpError(400, 'operationId 不能为空');
  return database.$transaction(async (tx) => {
    const previous = await tx.consumptionOperation.findUnique({ where: { id: input.operationId } });
    if (previous) {
      if (previous.previewHash !== input.previewToken) throw httpError(409, 'operationId 已用于另一笔请求');
      const result = JSON.parse(previous.resultJson) as Record<string, unknown>;
      return { ...result, repeated: true };
    }
    const recipe = await tx.recipe.findFirst({
      where: { id: input.recipeId, deletedAt: null },
      include: { ingredients: { orderBy: { sortOrder: 'asc' } } }
    });
    if (!recipe) throw httpError(404, '菜谱不存在');
    const planContext = input.relatedPlanId
      ? await resolvePlanCompletion(tx, input.relatedPlanId, input.recipeId)
      : null;
    const dinerCount = Math.max(planContext?.dinerCount ?? input.dinerIds?.length ?? 1, 1);
    const items = await buildPreviewForRecipe(tx, recipe, dinerCount, input.selections);
    const previewToken = immediatePreviewToken(input, planContext, dinerCount, items);
    if (previewToken !== input.previewToken) throw httpError(409, '库存或计划上下文已变化，请重新预览后确认');
    if (items.some((item) => item.requiresManualSelection))
      throw httpError(422, '存在多个可用库存批次，请先明确选择批次');
    if (planContext) {
      const duplicate = await tx.mealRecord.findUnique({ where: { sourceMealPlanId: input.relatedPlanId! } });
      if (duplicate) throw httpError(409, '该计划已生成记录，请勿重复完成');
    }

    // 真正确认时才创建正式记录，避免留下 DRAFT 幽灵记录；
    // 计划完成场景（relatedPlanId）以计划为准收口：记录关联原计划并置为已完成。
    const record = await tx.mealRecord.create({
      data: {
        recordDate: planContext?.recordDate ?? input.recordDate,
        recordTime: input.recordTime ?? null,
        mealType: planContext?.mealType ?? input.mealType,
        sourceType: input.sourceType,
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        notes: input.notes ?? null,
        relatedPlanId: input.relatedPlanId ?? null,
        sourceMealPlanId: input.relatedPlanId ?? null,
        items: {
          create: [{ itemType: 'RECIPE', recipeId: input.recipeId, mealRole: 'MAIN', sortOrder: 0 }]
        },
        diners: {
          create: [...new Set(planContext?.dinerIds ?? input.dinerIds ?? [])].map((dinerId) => ({ dinerId }))
        }
      }
    });
    if (input.relatedPlanId) {
      await tx.mealPlan.updateMany({
        where: { id: input.relatedPlanId, status: { in: ['PLANNED', 'UNPLANNED'] }, deletedAt: null },
        data: { status: 'COMPLETED', completedAt: new Date(), version: { increment: 1 } }
      });
    }

    const { logIds, shoppingListId } = await applyConsumption(tx, items, record.id);

    const result = {
      operationId: input.operationId,
      recordId: record.id,
      recordVersion: record.version,
      inventoryLogIds: logIds,
      shoppingListId,
      repeated: false
    };
    await tx.consumptionOperation.create({
      data: {
        id: input.operationId,
        mealRecordId: record.id,
        previewHash: input.previewToken,
        resultJson: JSON.stringify(result)
      }
    });
    return result;
  });
}
