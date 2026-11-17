import type { Prisma, QuantityUnit } from '@prisma/client';

import { convertQuantity } from '../../database/units.js';

/**
 * 存量无活批次的等效自愈。
 *
 * 历史数据里存在「食材 quantity > 0 但没有任何活 InventoryBatch」的记录（早期只写食材汇总、
 * 未建批次）。这类食材在聚合/推荐里必须与有批次的食材等价，否则会被判成缺料；消耗时若直接
 * 按批次扣减还会 409。这里统一按食材汇总字段派生一个等效批次：
 *
 * - 读路径（库存推荐聚合）：只在内存中派生，不改库；
 * - 写路径（消耗）：先真实补建批次 + 日志，再按正常批次规则扣减。
 */
export interface BatchFacts {
  ingredientId: string;
  quantity: number;
  unit: QuantityUnit;
  purchaseDate: string | null;
  expiryDate: string | null;
  location: string | null;
  opened: boolean;
}

export interface AggregatableBatch {
  ingredientId: string;
  quantity: number;
  unit: QuantityUnit;
  expiryDate: string | null;
  consumePriority: boolean;
  opened: boolean;
}

export function hasActiveStock(batches: ReadonlyArray<{ quantity: number }>): boolean {
  return batches.some((batch) => batch.quantity > 0);
}

function convertToBase(quantity: number, from: QuantityUnit, to: QuantityUnit): number {
  return convertQuantity(quantity, from, to) ?? 0;
}

/**
 * 返回可用于聚合/扣减的批次集合：无活批次且汇总数量 > 0 时追加一个等效批次。
 * 等效批次数量以食材基础单位表示，并继承汇总的到期日/开封状态。
 */
export function withImplicitBatch<T extends AggregatableBatch>(
  ingredient: BatchFacts,
  batches: T[]
): Array<T | AggregatableBatch> {
  if (hasActiveStock(batches) || !(ingredient.quantity > 0)) return batches;
  return [
    ...batches,
    {
      ingredientId: ingredient.ingredientId,
      quantity: ingredient.quantity,
      unit: ingredient.unit,
      expiryDate: ingredient.expiryDate,
      consumePriority: false,
      opened: ingredient.opened
    }
  ];
}

/**
 * 在事务内补建等效批次（消耗前调用）。调用方需已按条件（id/version/deletedAt）锁定食材，
 * 这里不再做并发校验；createdAt 与 id 交给数据库。
 */
export async function persistImplicitBatch(
  transaction: Prisma.TransactionClient,
  ingredient: BatchFacts & { name: string },
  existingBatches: ReadonlyArray<{ quantity: number }>
): Promise<{ batchId: string; quantity: number; unit: QuantityUnit } | null> {
  if (hasActiveStock(existingBatches) || !(ingredient.quantity > 0)) return null;
  const batch = await transaction.inventoryBatch.create({
    data: {
      ingredientId: ingredient.ingredientId,
      quantity: roundQuantity(ingredient.quantity),
      unit: ingredient.unit,
      purchaseDate: ingredient.purchaseDate,
      expiryDate: ingredient.expiryDate,
      location: ingredient.location,
      opened: ingredient.opened,
      notes: '历史存量自动补建等效批次'
    }
  });
  await transaction.inventoryLog.create({
    data: {
      ingredientId: ingredient.ingredientId,
      ingredientNameSnapshot: ingredient.name,
      inventoryBatchId: batch.id,
      beforeQuantity: 0,
      changeQuantity: roundQuantity(ingredient.quantity),
      afterQuantity: roundQuantity(ingredient.quantity),
      unit: ingredient.unit,
      changeType: 'ADJUST',
      notes: '历史存量自动补建等效批次'
    }
  });
  return { batchId: batch.id, quantity: batch.quantity, unit: ingredient.unit };
}

export function roundQuantity(value: number): number {
  return Number(value.toFixed(6));
}

/** 汇总数量：只统计 quantity > 0 的活批次，换算到基础单位后求和。 */
export function summarizeQuantity(
  batches: ReadonlyArray<{ quantity: number; unit: QuantityUnit }>,
  baseUnit: QuantityUnit
): number {
  return roundQuantity(
    batches.reduce(
      (total, batch) => total + (batch.quantity > 0 ? convertToBase(batch.quantity, batch.unit, baseUnit) : 0),
      0
    )
  );
}

/**
 * 汇总到期日/位置：沿用既有口径 —— 取有剩余数量的批次里到期日最早的一条；
 * 该批次没有位置时回退到其余活批次中的首个非空位置，避免编辑/入库把位置意外清空。
 */
export function summarizeBatchMeta<
  T extends { quantity: number; expiryDate: string | null; location?: string | null; purchaseDate?: string | null }
>(batches: T[]): { purchaseDate: string | null; expiryDate: string | null; location: string | null } {
  const active = batches.filter((batch) => batch.quantity > 0);
  const earliest = [...active].sort((a, b) =>
    (a.expiryDate ?? '9999-12-31').localeCompare(b.expiryDate ?? '9999-12-31')
  )[0];
  const location = earliest?.location ?? active.find((batch) => batch.location)?.location ?? null;
  return { purchaseDate: earliest?.purchaseDate ?? null, expiryDate: earliest?.expiryDate ?? null, location };
}
