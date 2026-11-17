import type { InventoryChangeType, Prisma, PrismaClient, QuantityUnit } from '@prisma/client';

import { VersionConflictError } from '../../database/optimistic-lock.js';
import { recordDeletedItem } from '../../database/deleted-items.js';
import { normalizePagination, toPaginationResponse } from '../../database/pagination.js';
import { convertQuantity } from '../../database/units.js';
import { normalizeIngredientCategory } from './categories.js';
import { persistImplicitBatch, roundQuantity, summarizeBatchMeta, summarizeQuantity } from './batches.js';

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
  /**
   * 食材级编辑（Google2 食材详情「✏️ 编辑」）：只在显式提供时生效，
   * 省略则保持既有「按活批次汇总」语义，不影响旧调用方。
   */
  quantity?: number | null;
  purchaseDate?: string | null;
  expiryDate?: string | null;
  location?: string | null;
  opened?: boolean;
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

/** Google2 库存详情固定按钮（消耗 100g / 250g / 全部用完）对应的聚合消耗输入。 */
export interface ConsumeInput {
  mode: 'QUANTITY' | 'ALL';
  quantity?: number;
  unit?: QuantityUnit;
  ingredientVersion: number;
  notes?: string | null;
}

export interface ConsumptionAllocation {
  batchId: string;
  batchVersion: number;
  beforeQuantity: number;
  afterQuantity: number;
  unit: QuantityUnit;
  changeQuantity: number;
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

type IngredientRow = {
  id: string;
  name: string;
  quantity: number;
  unit: QuantityUnit;
  purchaseDate: string | null;
  expiryDate: string | null;
  location: string | null;
  opened: boolean;
};

function toBatchFacts(ingredient: IngredientRow) {
  return {
    ingredientId: ingredient.id,
    name: ingredient.name,
    quantity: ingredient.quantity,
    unit: ingredient.unit,
    purchaseDate: ingredient.purchaseDate,
    expiryDate: ingredient.expiryDate,
    location: ingredient.location,
    opened: ingredient.opened
  };
}

const QUANTITY_EPSILON = 1e-9;

/**
 * 食材编辑时把「汇总库存」同步进批次，而不是只改汇总字段：
 * - 目标数量与活批次合计一致（纯改名/单位换算/元数据编辑）→ 不动数量；
 * - 目标数量更大 → 新建差额批次并记 ADJUST 日志；
 * - 目标数量更小 → 按既有消耗顺序扣减并记 MANUAL_DEDUCT 日志。
 * 这样编辑后的 quantity 与各活批次之和始终一致，不会再触发 INGREDIENT_BATCHES_UNSUPPORTED 类阻塞。
 */
async function synchronizeBatches(
  transaction: Prisma.TransactionClient,
  params: {
    ingredientId: string;
    ingredientName: string;
    baseUnit: QuantityUnit;
    targetQuantity: number;
    meta: {
      purchaseDate?: string | null;
      expiryDate?: string | null;
      location?: string | null;
      opened?: boolean;
    };
    metaTouched: boolean;
    fallbackMeta: { purchaseDate: string | null; expiryDate: string | null; location: string | null; opened: boolean };
  }
): Promise<void> {
  const { ingredientId, ingredientName, baseUnit, targetQuantity, meta, metaTouched } = params;
  const batches = await transaction.inventoryBatch.findMany({
    where: { ingredientId, deletedAt: null },
    orderBy: activeBatchOrder
  });
  const active = batches.filter((batch) => batch.quantity > 0);
  const total = roundQuantity(summarizeQuantity(active, baseUnit));
  const delta = roundQuantity(targetQuantity - total);

  if (delta > QUANTITY_EPSILON) {
    const created = await transaction.inventoryBatch.create({
      data: {
        ingredientId,
        quantity: delta,
        unit: baseUnit,
        purchaseDate: meta.purchaseDate === undefined ? params.fallbackMeta.purchaseDate : meta.purchaseDate,
        expiryDate: meta.expiryDate === undefined ? params.fallbackMeta.expiryDate : meta.expiryDate,
        location: meta.location === undefined ? params.fallbackMeta.location : meta.location,
        opened: meta.opened ?? params.fallbackMeta.opened
      }
    });
    await transaction.inventoryLog.create({
      data: {
        ingredientId,
        ingredientNameSnapshot: ingredientName,
        inventoryBatchId: created.id,
        beforeQuantity: 0,
        changeQuantity: delta,
        afterQuantity: delta,
        unit: baseUnit,
        changeType: 'ADJUST',
        notes: '食材编辑同步库存'
      }
    });
  } else if (delta < -QUANTITY_EPSILON) {
    let remaining = roundQuantity(-delta);
    for (const batch of active) {
      if (remaining <= QUANTITY_EPSILON) break;
      const available = convertQuantity(batch.quantity, batch.unit, baseUnit) ?? 0;
      if (available <= 0) continue;
      const take = Math.min(remaining, available);
      const takeInBatchUnit = Math.min(roundQuantity(convertQuantity(take, baseUnit, batch.unit) ?? 0), batch.quantity);
      const after = roundQuantity(batch.quantity - takeInBatchUnit);
      const updated = await transaction.inventoryBatch.updateMany({
        where: { id: batch.id, version: batch.version, deletedAt: null, quantity: { gte: takeInBatchUnit } },
        data: { quantity: after, version: { increment: 1 } }
      });
      if (!updated.count) {
        throw new VersionConflictError({
          entity: 'InventoryBatch',
          id: batch.id,
          expectedVersion: batch.version,
          actualVersion: batch.version + 1
        });
      }
      await transaction.inventoryLog.create({
        data: {
          ingredientId,
          ingredientNameSnapshot: ingredientName,
          inventoryBatchId: batch.id,
          beforeQuantity: batch.quantity,
          changeQuantity: -takeInBatchUnit,
          afterQuantity: after,
          unit: batch.unit,
          changeType: 'MANUAL_DEDUCT',
          notes: '食材编辑同步库存'
        }
      });
      remaining = roundQuantity(remaining - take);
    }
    if (remaining > QUANTITY_EPSILON) {
      throw Object.assign(new Error('库存数量不足，无法同步本次编辑'), { statusCode: 409 });
    }
  }

  if (!metaTouched) return;
  // 食材级字段适用于所有活批次；省略字段保留，显式 null 同步清空。
  await transaction.inventoryBatch.updateMany({
    where: { ingredientId, deletedAt: null, quantity: { gt: 0 } },
    data: {
      ...(meta.purchaseDate !== undefined ? { purchaseDate: meta.purchaseDate } : {}),
      ...(meta.expiryDate !== undefined ? { expiryDate: meta.expiryDate } : {}),
      ...(meta.location !== undefined ? { location: meta.location } : {}),
      ...(meta.opened !== undefined ? { opened: meta.opened } : {})
    }
  });
}

/** 读取视图统一把历史分类/空分类派生为标准 7 类，保证前端「全部 (N)」等于各分类计数之和。 */
type IngredientView = { name: string; category: string | null };
function withNormalizedCategory<T extends IngredientView>(ingredient: T): T & { category: string } {
  return { ...ingredient, category: normalizeIngredientCategory(ingredient.category, ingredient.name) };
}

/** 分类筛选支持标准分类与历史旧名；「全部」/空值不过滤。 */
function isAllCategory(value: string | null | undefined): boolean {
  const text = (value ?? '').trim();
  return !text || text === '全部' || text === 'ALL';
}

export async function listIngredients(
  database: PrismaClient,
  query: { search?: string; category?: string; status?: string; page?: number; pageSize?: number } = {}
) {
  const pagination = normalizePagination(query);
  const where: Prisma.IngredientWhereInput = {
    deletedAt: null,
    ...(query.search?.trim() ? { name: { contains: query.search.trim() } } : {})
  };
  const ingredients = await database.ingredient.findMany({
    where,
    include: ingredientInclude,
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }]
  });
  const requestedCategory = isAllCategory(query.category) ? null : normalizeIngredientCategory(query.category, null);
  // 分类/状态都需要归一化后比较（历史库里的旧分类无法用 SQL 等值命中），因此统一在内存中过滤再分页。
  const filtered = ingredients
    .map(withNormalizedCategory)
    .filter((item) => !requestedCategory || item.category === requestedCategory)
    .filter((item) => !query.status || ingredientStatus(item) === query.status);
  return toPaginationResponse(
    filtered.slice(pagination.skip, pagination.skip + pagination.take),
    pagination.page,
    pagination.pageSize,
    filtered.length
  );
}

export async function getIngredient(database: PrismaClient, id: string) {
  const ingredient = await database.ingredient.findFirst({
    where: { id, deletedAt: null },
    include: ingredientInclude
  });
  if (!ingredient) throw Object.assign(new Error('食材不存在'), { statusCode: 404 });
  return { ...withNormalizedCategory(ingredient), status: ingredientStatus(ingredient) };
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
        category: normalizeIngredientCategory(input.category, input.name),
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
    const batches = await transaction.inventoryBatch.findMany({
      where: { ingredientId: id, deletedAt: null },
      orderBy: activeBatchOrder
    });
    const converted = batches.map((batch) => convertQuantity(batch.quantity, batch.unit, input.unit));
    if (converted.some((quantity) => quantity == null)) {
      throw Object.assign(new Error('现有库存批次无法换算为新的基础单位'), { statusCode: 409 });
    }
    let batchTotal = roundQuantity(converted.reduce<number>((total, value) => total + (value ?? 0), 0));

    // 无活批次但存量 > 0 的历史食材：先补建等效批次，后续编辑/汇总都走真实批次。
    if (!batches.some((batch) => batch.quantity > 0) && batchTotal <= 0 && current.quantity > 0) {
      await persistImplicitBatch(transaction, toBatchFacts(current), []);
      batchTotal = roundQuantity(convertQuantity(current.quantity, current.unit, input.unit) ?? 0);
    }

    // 食材级编辑语义：quantity 显式提供时以用户输入为准，否则沿用「按活批次汇总」。
    const targetQuantity =
      input.quantity === undefined || input.quantity === null ? batchTotal : roundQuantity(input.quantity);

    const metaTouched =
      input.purchaseDate !== undefined ||
      input.expiryDate !== undefined ||
      input.location !== undefined ||
      input.opened !== undefined;
    await synchronizeBatches(transaction, {
      ingredientId: id,
      ingredientName: input.name.trim(),
      baseUnit: input.unit,
      targetQuantity,
      meta: {
        purchaseDate: input.purchaseDate,
        expiryDate: input.expiryDate,
        location: input.location,
        opened: input.opened
      },
      metaTouched,
      fallbackMeta: current
    });

    const finalBatches = await transaction.inventoryBatch.findMany({
      where: { ingredientId: id, deletedAt: null },
      orderBy: activeBatchOrder
    });
    const summary = summarizeBatchMeta(finalBatches);
    const result = await transaction.ingredient.updateMany({
      where: { id, version, deletedAt: null },
      data: {
        name: input.name.trim(),
        imagePath: input.imagePath ?? null,
        category: normalizeIngredientCategory(input.category ?? current.category, input.name),
        unit: input.unit,
        quantity: targetQuantity,
        minStock: input.minStock ?? null,
        maxStock: input.maxStock ?? null,
        notes: input.notes ?? null,
        // 显式输入优先；未传字段从批次派生，无事实可派生时保留历史汇总值。
        purchaseDate:
          input.purchaseDate === undefined ? (summary.purchaseDate ?? current.purchaseDate) : input.purchaseDate,
        expiryDate: input.expiryDate === undefined ? (summary.expiryDate ?? current.expiryDate) : input.expiryDate,
        location: input.location === undefined ? (summary.location ?? current.location) : input.location,
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

const activeBatchOrder = [
  { consumePriority: 'desc' as const },
  { expiryDate: 'asc' as const },
  { createdAt: 'asc' as const },
  { id: 'asc' as const }
];

/**
 * 聚合食材级消耗：库存详情页固定按钮「消耗 100g / 消耗 250g / 全部用完」的真实后端语义。
 *
 * - 批次顺序由服务端确定（consumePriority desc → expiryDate asc → createdAt asc → id asc），
 *   与 consumption/service.ts 预览分配规则一致；UI 无批次选择，不允许也不需要一个一个指定批次。
 * - QUANTITY：只从单位可换算到请求单位的活批次按序扣减；不可换算的活批次原样保留并在响应
 *   incompatibleBatchIds 中标出（不静默跳过）；兼容批次可用量不足 → 409，整单失败无部分扣减。
 * - ALL：把真实存在的全部活批次清零（不使用任何硬编码库存数字）。
 * - 乐观锁：ingredient.version 与各批次 version 均作为条件更新谓词；任一冲突 → 409 整单回滚。
 * - 每个被扣批次写 InventoryLog（before/change/after、批次单位、MANUAL_DEDUCT）并同步食材汇总。
 */
export async function consumeIngredient(database: PrismaClient, ingredientId: string, input: ConsumeInput) {
  if (!Number.isInteger(input.ingredientVersion) || input.ingredientVersion < 1)
    throw badRequest('ingredientVersion 必须是正整数');
  if (input.mode !== 'QUANTITY' && input.mode !== 'ALL') throw badRequest('消耗模式必须是 QUANTITY 或 ALL');
  if (input.mode === 'ALL' && (input.quantity != null || input.unit != null))
    throw badRequest('“全部用完”不接受数量或单位参数');
  if (input.mode === 'QUANTITY') {
    if (!Number.isFinite(input.quantity) || (input.quantity as number) <= 0)
      throw badRequest('消耗数量必须是大于 0 的有限数');
    if (!input.unit) throw badRequest('按数量消耗必须提供单位');
  }

  return database.$transaction(async (transaction) => {
    const ingredient = await transaction.ingredient.findFirst({ where: { id: ingredientId, deletedAt: null } });
    if (!ingredient) throw Object.assign(new Error('食材不存在'), { statusCode: 404 });
    if (ingredient.version !== input.ingredientVersion) {
      throw new VersionConflictError({
        entity: 'Ingredient',
        id: ingredientId,
        expectedVersion: input.ingredientVersion,
        actualVersion: ingredient.version
      });
    }

    let batches = await transaction.inventoryBatch.findMany({
      where: { ingredientId, deletedAt: null, quantity: { gt: 0 } },
      orderBy: activeBatchOrder
    });
    if (!batches.length) {
      // 历史存量：quantity > 0 但从未建过活批次。先按汇总补建等效批次再正常扣减，避免 409。
      const healed = await persistImplicitBatch(transaction, toBatchFacts(ingredient), []);
      if (healed) {
        batches = await transaction.inventoryBatch.findMany({
          where: { ingredientId, deletedAt: null, quantity: { gt: 0 } },
          orderBy: activeBatchOrder
        });
      }
    }
    if (!batches.length) throw Object.assign(new Error('库存数量不足，无法完成本次消耗'), { statusCode: 409 });

    const planned: Array<{ batch: (typeof batches)[number]; take: number }> = [];
    const incompatibleBatchIds: string[] = [];
    let consumedQuantity: number | null = null;

    if (input.mode === 'QUANTITY') {
      const unit = input.unit as QuantityUnit;
      const compatible = batches.filter((batch) => convertQuantity(1, batch.unit, unit) !== null);
      for (const batch of batches) {
        if (convertQuantity(1, batch.unit, unit) === null) incompatibleBatchIds.push(batch.id);
      }
      if (!compatible.length) throw Object.assign(new Error('库存单位不可换算，无法按该单位消耗'), { statusCode: 409 });
      const available = compatible.reduce(
        (total, batch) => total + (convertQuantity(batch.quantity, batch.unit, unit) ?? 0),
        0
      );
      if (roundQuantity(available) < roundQuantity(input.quantity as number))
        throw Object.assign(new Error('库存数量不足，无法完成本次消耗'), { statusCode: 409 });
      let remaining = input.quantity as number;
      for (const batch of compatible) {
        if (remaining <= 0) break;
        const availableInUnit = convertQuantity(batch.quantity, batch.unit, unit) ?? 0;
        const takeInUnit = Math.min(remaining, availableInUnit);
        const takeInBatchUnit = roundQuantity(convertQuantity(takeInUnit, unit, batch.unit) ?? 0);
        const take = Math.min(takeInBatchUnit, batch.quantity);
        if (take > 0) planned.push({ batch, take });
        remaining = roundQuantity(remaining - takeInUnit);
      }
      // 数量与 consumedUnit 使用同一请求单位，避免 kg 库存按 g 消耗时返回缩小 1000 倍的数量。
      consumedQuantity = roundQuantity(
        planned.reduce((total, { batch, take }) => total + (convertQuantity(take, batch.unit, unit) ?? 0), 0)
      );
    } else {
      for (const batch of batches) planned.push({ batch, take: batch.quantity });
      const totalInIngredientUnit = planned.reduce((total, { batch, take }) => {
        const converted = convertQuantity(take, batch.unit, ingredient.unit);
        return total + (converted ?? Number.NaN);
      }, 0);
      consumedQuantity = Number.isFinite(totalInIngredientUnit) ? roundQuantity(totalInIngredientUnit) : null;
    }

    const allocations: ConsumptionAllocation[] = [];
    const inventoryLogIds: string[] = [];
    for (const { batch, take } of planned) {
      const after = roundQuantity(batch.quantity - take);
      if (after < 0) throw Object.assign(new Error('库存数量不足，无法完成本次消耗'), { statusCode: 409 });
      const updated = await transaction.inventoryBatch.updateMany({
        where: { id: batch.id, version: batch.version, deletedAt: null, quantity: { gte: take } },
        data: { quantity: after, version: { increment: 1 } }
      });
      if (!updated.count) {
        throw new VersionConflictError({
          entity: 'InventoryBatch',
          id: batch.id,
          expectedVersion: batch.version,
          actualVersion: batch.version + 1
        });
      }
      const log = await transaction.inventoryLog.create({
        data: {
          ingredientId,
          ingredientNameSnapshot: ingredient.name,
          inventoryBatchId: batch.id,
          beforeQuantity: batch.quantity,
          changeQuantity: -take,
          afterQuantity: after,
          unit: batch.unit,
          changeType: 'MANUAL_DEDUCT',
          notes: input.notes ?? null
        }
      });
      inventoryLogIds.push(log.id);
      allocations.push({
        batchId: batch.id,
        batchVersion: batch.version,
        beforeQuantity: batch.quantity,
        afterQuantity: after,
        unit: batch.unit,
        changeQuantity: -take
      });
    }

    const remainingBatches = await transaction.inventoryBatch.findMany({
      where: { ingredientId, deletedAt: null },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }]
    });
    const quantity = roundQuantity(aggregateQuantity(remainingBatches, ingredient.unit));
    const earliest = [...remainingBatches]
      .filter((item) => item.quantity > 0)
      .sort((a, b) => (a.expiryDate ?? '9999-12-31').localeCompare(b.expiryDate ?? '9999-12-31'))[0];
    const summary = await transaction.ingredient.updateMany({
      where: { id: ingredientId, version: input.ingredientVersion, deletedAt: null },
      data: {
        quantity,
        purchaseDate: earliest?.purchaseDate ?? null,
        expiryDate: earliest?.expiryDate ?? null,
        location: earliest?.location ?? null,
        opened: remainingBatches.some((item) => item.quantity > 0 && item.opened),
        version: { increment: 1 }
      }
    });
    if (!summary.count) {
      const latest = await transaction.ingredient.findUnique({
        where: { id: ingredientId },
        select: { version: true, deletedAt: true }
      });
      if (!latest || latest.deletedAt) throw Object.assign(new Error('食材不存在'), { statusCode: 404 });
      throw new VersionConflictError({
        entity: 'Ingredient',
        id: ingredientId,
        expectedVersion: input.ingredientVersion,
        actualVersion: latest.version
      });
    }
    const updatedIngredient = await transaction.ingredient.findUniqueOrThrow({
      where: { id: ingredientId },
      include: ingredientInclude
    });
    return {
      mode: input.mode,
      consumedQuantity,
      consumedUnit: input.mode === 'QUANTITY' ? (input.unit as QuantityUnit) : ingredient.unit,
      allocations,
      incompatibleBatchIds,
      inventoryLogIds,
      ingredient: updatedIngredient
    };
  });
}
