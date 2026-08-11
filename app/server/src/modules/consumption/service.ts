import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient, QuantityUnit } from '@prisma/client';

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
    const scale = dinerCount / Math.max(recordItem.recipe.servings ?? dinerCount, 1);
    for (const recipeIngredient of recordItem.recipe.ingredients) {
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

    const logIds: string[] = [];
    for (const item of preview.items) {
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
            relatedRecordId: input.recordId
          }
        });
        logIds.push(log.id);
      }
    }

    const active = preview.items.some((item) => item.shortageQuantity > 0)
      ? await tx.shoppingList.findFirst({
          where: { deletedAt: null, status: 'ACTIVE' },
          orderBy: { updatedAt: 'desc' }
        })
      : null;
    const shopping =
      active ??
      (preview.items.some((item) => item.shortageQuantity > 0)
        ? await tx.shoppingList.create({ data: { name: '库存不足待采购' } })
        : null);
    if (shopping) {
      for (const item of preview.items) await mergeShortage(tx, shopping.id, item);
      await tx.shoppingList.update({ where: { id: shopping.id }, data: { version: { increment: 1 } } });
    }

    const record = await tx.mealRecord.update({
      where: { id: input.recordId },
      data: { status: 'CONFIRMED', confirmedAt: new Date(), version: { increment: 1 } }
    });
    for (const ingredientId of new Set(
      preview.items.map((item) => item.ingredientId).filter((id): id is string => Boolean(id))
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
    const result = {
      operationId: input.operationId,
      recordId: record.id,
      recordVersion: record.version,
      inventoryLogIds: logIds,
      shoppingListId: shopping?.id ?? null,
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
