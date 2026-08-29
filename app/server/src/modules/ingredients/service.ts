import type { InventoryChangeType, Prisma, PrismaClient, QuantityUnit } from '@prisma/client';

import { VersionConflictError } from '../../database/optimistic-lock.js';
import { recordDeletedItem } from '../../database/deleted-items.js';
import { normalizePagination, toPaginationResponse } from '../../database/pagination.js';
import { convertQuantity } from '../../database/units.js';

export interface BatchInput {
  quantity: number;
  unit: QuantityUnit;
  purchaseDate?: string | null;
  expiryDate?: string | null;
  location?: string | null;
  opened?: boolean;
  consumePriority?: boolean;
  notes?: string | null;
}

export interface IngredientWriteInput {
  name: string;
  imagePath?: string | null;
  category?: string | null;
  unit: QuantityUnit;
  minStock?: number | null;
  maxStock?: number | null;
  notes?: string | null;
  batches?: BatchInput[];
}

export interface BatchAdjustmentInput {
  batchId?: string;
  batchVersion?: number;
  quantity: number;
  unit: QuantityUnit;
  changeType: InventoryChangeType;
  purchaseDate?: string | null;
  expiryDate?: string | null;
  location?: string | null;
  opened?: boolean;
  consumePriority?: boolean;
  notes?: string | null;
}

const ingredientInclude = {
  inventoryBatches: {
    where: { deletedAt: null },
    orderBy: [{ consumePriority: 'desc' as const }, { expiryDate: 'asc' as const }]
  }
};

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function assertNonNegative(value: number | null | undefined, field: string): void {
  if (value != null && (!Number.isFinite(value) || value < 0)) throw badRequest(`${field}不能为负数`);
}
function assertInput(input: IngredientWriteInput): void {
  if (!input.name?.trim()) throw badRequest('食材名称不能为空');
  assertNonNegative(input.minStock, '最低库存');
  assertNonNegative(input.maxStock, '最高库存');
  if (input.minStock != null && input.maxStock != null && input.minStock > input.maxStock)
    throw badRequest('最低库存不能大于最高库存');
  for (const batch of input.batches ?? []) {
    assertNonNegative(batch.quantity, '批次数量');
    if (convertQuantity(batch.quantity, batch.unit, input.unit) == null)
      throw badRequest('批次单位必须可换算为食材基础单位');
  }
}

function aggregateQuantity(batches: Array<{ quantity: number; unit: QuantityUnit }>, baseUnit: QuantityUnit): number {
  return batches.reduce((total, batch) => {
    const converted = convertQuantity(batch.quantity, batch.unit, baseUnit);
    return total + (converted ?? (batch.unit === baseUnit ? batch.quantity : 0));
  }, 0);
}

export async function listIngredients(
  database: PrismaClient,
  query: { search?: string; category?: string; status?: string; page?: number; pageSize?: number } = {}
) {
  const pagination = normalizePagination(query);
  const where: Prisma.IngredientWhereInput = {
    deletedAt: null,
    ...(query.search?.trim() ? { name: { contains: query.search.trim() } } : {}),
    ...(query.category ? { category: query.category } : {})
  };
  if (query.status) {
    const ingredients = await database.ingredient.findMany({
      where,
      include: ingredientInclude,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }]
    });
    const mapped = ingredients.filter((item) => ingredientStatus(item) === query.status);
    return toPaginationResponse(
      mapped.slice(pagination.skip, pagination.skip + pagination.take),
      pagination.page,
      pagination.pageSize,
      mapped.length
    );
  }
  const [items, total] = await Promise.all([
    database.ingredient.findMany({
      where,
      include: ingredientInclude,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: pagination.skip,
      take: pagination.take
    }),
    database.ingredient.count({ where })
  ]);
  return toPaginationResponse(items, pagination.page, pagination.pageSize, total);
}

export async function getIngredient(database: PrismaClient, id: string) {
  const ingredient = await database.ingredient.findFirst({
    where: { id, deletedAt: null },
    include: ingredientInclude
  });
  if (!ingredient) throw Object.assign(new Error('食材不存在'), { statusCode: 404 });
  return { ...ingredient, status: ingredientStatus(ingredient) };
}

export function ingredientStatus(ingredient: {
  quantity: number;
  minStock: number | null;
  expiryDate: string | null;
}): string {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const soon = new Date(today);
  soon.setDate(soon.getDate() + 3);
  const soonDate = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
  if (ingredient.quantity <= 0) return 'DEPLETED';
  if (ingredient.expiryDate && ingredient.expiryDate < date) return 'EXPIRED';
  if (ingredient.expiryDate && ingredient.expiryDate <= soonDate) return 'EXPIRING_SOON';
  if (ingredient.minStock != null && ingredient.quantity < ingredient.minStock) return 'LOW_STOCK';
  return 'NORMAL';
}

export async function createIngredient(database: PrismaClient, input: IngredientWriteInput) {
  assertInput(input);
  return database.$transaction(async (transaction) => {
    const quantity = aggregateQuantity(input.batches ?? [], input.unit);
    const first = input.batches?.[0];
    const ingredient = await transaction.ingredient.create({
      data: {
        name: input.name.trim(),
        imagePath: input.imagePath ?? null,
        category: input.category ?? null,
        quantity,
        unit: input.unit,
        minStock: input.minStock ?? null,
        maxStock: input.maxStock ?? null,
        purchaseDate: first?.purchaseDate ?? null,
        expiryDate: first?.expiryDate ?? null,
        location: first?.location ?? null,
        opened: first?.opened ?? false,
        notes: input.notes ?? null,
        inventoryBatches: input.batches?.length
          ? { create: input.batches.map((batch) => ({ ...batch, notes: batch.notes ?? null })) }
          : undefined
      },
      include: ingredientInclude
    });
    if (ingredient.inventoryBatches.length) {
      await transaction.inventoryLog.createMany({
        data: ingredient.inventoryBatches.map((batch) => ({
          ingredientId: ingredient.id,
          ingredientNameSnapshot: ingredient.name,
          inventoryBatchId: batch.id,
          beforeQuantity: 0,
          changeQuantity: batch.quantity,
          afterQuantity: batch.quantity,
          unit: batch.unit,
          changeType: 'PURCHASE',
          notes: batch.notes
        }))
      });
    }
    return ingredient;
  });
}

export async function updateIngredient(
  database: PrismaClient,
  id: string,
  version: number,
  input: IngredientWriteInput
) {
  if (!Number.isInteger(version) || version < 1) throw badRequest('version 必须是正整数');
  assertInput(input);
  return database.$transaction(async (transaction) => {
    const current = await transaction.ingredient.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw Object.assign(new Error('食材不存在'), { statusCode: 404 });
    if (current.version !== version) {
      throw new VersionConflictError({
        entity: 'Ingredient',
        id,
        expectedVersion: version,
        actualVersion: current.version
      });
    }
    const batches = await transaction.inventoryBatch.findMany({ where: { ingredientId: id, deletedAt: null } });
    const converted = batches.map((batch) => convertQuantity(batch.quantity, batch.unit, input.unit));
    if (converted.some((quantity) => quantity == null)) {
      throw Object.assign(new Error('现有库存批次无法换算为新的基础单位'), { statusCode: 409 });
    }
    const quantity = converted.reduce<number>((total, value) => total + (value ?? 0), 0);
    const result = await transaction.ingredient.updateMany({
      where: { id, version, deletedAt: null },
      data: {
        name: input.name.trim(),
        imagePath: input.imagePath ?? null,
        category: input.category ?? null,
        unit: input.unit,
        quantity,
        minStock: input.minStock ?? null,
        maxStock: input.maxStock ?? null,
        notes: input.notes ?? null,
        version: { increment: 1 }
      }
    });
    if (!result.count) {
      const latest = await transaction.ingredient.findUnique({
        where: { id },
        select: { version: true, deletedAt: true }
      });
      if (!latest || latest.deletedAt) throw Object.assign(new Error('食材不存在'), { statusCode: 404 });
      throw new VersionConflictError({
        entity: 'Ingredient',
        id,
        expectedVersion: version,
        actualVersion: latest.version
      });
    }
    return transaction.ingredient.findUniqueOrThrow({ where: { id }, include: ingredientInclude });
  });
}

export async function deleteIngredient(database: PrismaClient, id: string, version: number) {
  if (!Number.isInteger(version) || version < 1) throw badRequest('version 必须是正整数');
  return database.$transaction(async (transaction) => {
    const deletedAt = new Date();
    const result = await transaction.ingredient.updateMany({
      where: { id, version, deletedAt: null },
      data: { deletedAt, version: { increment: 1 } }
    });
    if (!result.count) {
      const current = await transaction.ingredient.findUnique({
        where: { id },
        select: { version: true, deletedAt: true }
      });
      if (!current || current.deletedAt) throw Object.assign(new Error('食材不存在'), { statusCode: 404 });
      throw new VersionConflictError({
        entity: 'Ingredient',
        id,
        expectedVersion: version,
        actualVersion: current.version
      });
    }
    await transaction.inventoryBatch.updateMany({
      where: { ingredientId: id, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } }
    });
    await recordDeletedItem(transaction, 'Ingredient', id, deletedAt);
    return { id, deleted: true };
  });
}

export async function adjustInventory(database: PrismaClient, ingredientId: string, input: BatchAdjustmentInput) {
  if (!Number.isFinite(input.quantity) || (input.quantity === 0 && !input.batchId))
    throw badRequest('调整数量不能为 0');
  return database.$transaction(async (transaction) => {
    const ingredient = await transaction.ingredient.findFirst({ where: { id: ingredientId, deletedAt: null } });
    if (!ingredient) throw Object.assign(new Error('食材不存在'), { statusCode: 404 });
    let batch;
    if (!input.batchId) {
      if (input.quantity < 0) throw badRequest('新批次数量必须大于 0');
      if (convertQuantity(input.quantity, input.unit, ingredient.unit) == null)
        throw Object.assign(new Error('库存单位不可换算'), { statusCode: 409 });
      batch = await transaction.inventoryBatch.create({
        data: {
          ingredientId,
          quantity: input.quantity,
          unit: input.unit,
          purchaseDate: input.purchaseDate ?? null,
          expiryDate: input.expiryDate ?? null,
          location: input.location ?? null,
          opened: input.opened ?? false,
          consumePriority: input.consumePriority ?? false,
          notes: input.notes ?? null
        }
      });
      await transaction.inventoryLog.create({
        data: {
          ingredientId,
          ingredientNameSnapshot: ingredient.name,
          inventoryBatchId: batch.id,
          beforeQuantity: 0,
          changeQuantity: input.quantity,
          afterQuantity: input.quantity,
          unit: input.unit,
          changeType: input.changeType,
          notes: input.notes ?? null
        }
      });
    } else {
      const current = await transaction.inventoryBatch.findFirst({
        where: { id: input.batchId, ingredientId, deletedAt: null }
      });
      if (!current) throw Object.assign(new Error('库存批次不存在'), { statusCode: 404 });
      if (input.batchVersion == null) throw badRequest('调整已有批次必须提供 batchVersion');
      if (current.version !== input.batchVersion)
        throw new VersionConflictError({
          entity: 'InventoryBatch',
          id: current.id,
          expectedVersion: input.batchVersion,
          actualVersion: current.version
        });
      const delta = convertQuantity(Math.abs(input.quantity), input.unit, current.unit);
      if (delta == null) throw Object.assign(new Error('库存单位不可换算'), { statusCode: 409 });
      const signedDelta = input.quantity < 0 ? -delta : delta;
      const after = current.quantity + signedDelta;
      if (after < 0) throw Object.assign(new Error('库存数量不足'), { statusCode: 409 });
      const updated = await transaction.inventoryBatch.updateMany({
        where: { id: current.id, version: input.batchVersion, deletedAt: null },
        data: {
          quantity: after,
          version: { increment: 1 },
          opened: input.opened ?? current.opened,
          consumePriority: input.consumePriority ?? current.consumePriority,
          notes: input.notes ?? current.notes,
          expiryDate: input.expiryDate === undefined ? current.expiryDate : input.expiryDate
        }
      });
      if (!updated.count)
        throw new VersionConflictError({
          entity: 'InventoryBatch',
          id: current.id,
          expectedVersion: input.batchVersion,
          actualVersion: current.version + 1
        });
      batch = await transaction.inventoryBatch.findUniqueOrThrow({ where: { id: current.id } });
      await transaction.inventoryLog.create({
        data: {
          ingredientId,
          ingredientNameSnapshot: ingredient.name,
          inventoryBatchId: current.id,
          beforeQuantity: current.quantity,
          changeQuantity: signedDelta,
          afterQuantity: after,
          unit: current.unit,
          changeType: input.changeType,
          notes: input.notes ?? null
        }
      });
    }
    const batches = await transaction.inventoryBatch.findMany({ where: { ingredientId, deletedAt: null } });
    const quantity = aggregateQuantity(batches, ingredient.unit);
    const earliest = [...batches]
      .filter((item) => item.quantity > 0)
      .sort((a, b) => (a.expiryDate ?? '9999-12-31').localeCompare(b.expiryDate ?? '9999-12-31'))[0];
    await transaction.ingredient.update({
      where: { id: ingredientId },
      data: {
        quantity,
        purchaseDate: earliest?.purchaseDate ?? null,
        expiryDate: earliest?.expiryDate ?? null,
        location: earliest?.location ?? null,
        opened: batches.some((item) => item.quantity > 0 && item.opened),
        version: { increment: 1 }
      }
    });
    return { batch, quantity };
  });
}

export async function listInventoryLogs(database: PrismaClient, ingredientId: string) {
  await getIngredient(database, ingredientId);
  return database.inventoryLog.findMany({ where: { ingredientId }, orderBy: { createdAt: 'desc' } });
}
