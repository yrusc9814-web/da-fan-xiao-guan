import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient, QuantityUnit, ShoppingListStatus, ShoppingSourceType } from '@prisma/client';

import { VersionConflictError } from '../../database/optimistic-lock.js';
import { recordDeletedItem } from '../../database/deleted-items.js';
import { canConvertUnit, convertQuantity } from '../../database/units.js';

export interface ShoppingCheckinInput {
  version: number;
  operationId: string;
  itemIds: string[];
}

function payloadHash(input: ShoppingCheckinInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ version: input.version, operationId: input.operationId, itemIds: [...input.itemIds].sort() })
    )
    .digest('hex');
}

function today(): string {
  return new Date().toLocaleDateString('sv-SE');
}

export interface ShoppingItemInput {
  ingredientId?: string | null;
  ingredientName: string;
  quantity?: number | null;
  unit?: QuantityUnit | null;
  amountText?: string | null;
  category?: string | null;
  sourceType?: ShoppingSourceType;
  sourceId?: string | null;
  completed?: boolean;
  sortOrder?: number;
  notes?: string | null;
}

export interface ShoppingListInput {
  name: string;
  status?: ShoppingListStatus;
  notes?: string | null;
  items?: ShoppingItemInput[];
}

export interface ReplenishRecipeInput {
  version: number;
  recipeId: string;
  items: ShoppingItemInput[];
}

const listInclude = { items: { orderBy: [{ completed: 'asc' as const }, { sortOrder: 'asc' as const }] } };
type Tx = Prisma.TransactionClient;

function httpError(statusCode: number, message: string, businessCode?: string): Error {
  const error = Object.assign(new Error(message), { statusCode });
  // error-handler 优先使用 businessCode 作为 error.code：用于需要精确业务码的少数错误，
  // 未提供时保持既有的 VALIDATION_ERROR/CONFLICT 等映射不变。
  return businessCode ? Object.assign(error, { businessCode }) : error;
}

function normalizeAmountText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeCategory(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

interface NormalizedItem {
  ingredientName: string;
  quantity: number | null;
  unit: QuantityUnit | null;
  amountText: string | null;
  category: string | null;
}

/**
 * 购物项不变量（创建清单初始项 / POST 新增项 / PUT 更新项 / 菜谱批量补齐共用）：
 * - 名称 trim 后非空；
 * - 结构化数量与单位必须成对出现（同时有值或同时为空），数量必须为有限正数；
 * - 结构化规格与自由规格至少满足其一。
 */
function validateItem(item: ShoppingItemInput, statusCode = 400): NormalizedItem {
  const ingredientName = (item.ingredientName ?? '').trim();
  if (!ingredientName) throw httpError(statusCode, '食材名称不能为空');
  const quantity = item.quantity ?? null;
  const unit = item.unit ?? null;
  if ((quantity === null) !== (unit === null))
    throw httpError(statusCode, '购物数量与单位必须同时提供或同时为空');
  if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0))
    throw httpError(statusCode, '购物数量必须大于 0');
  const amountText = normalizeAmountText(item.amountText);
  if (quantity === null && !amountText) throw httpError(statusCode, '购物数量/单位或自由规格至少需要填写一项');
  return { ingredientName, quantity, unit, amountText, category: normalizeCategory(item.category) };
}

/**
 * 原子条件推进清单版本：把 expectedVersion 放进 UPDATE 谓词而不是“先读再按 id 更新”，
 * 并发下同一 version 的写入只有一个能把版本推进，其余必然 count=0 → 409。
 * 事务内抛错会整体回滚，因此这里提前占用版本不会留下半成品。
 */
async function claimListVersion(tx: Tx, id: string, version: number): Promise<void> {
  const result = await tx.shoppingList.updateMany({
    where: { id, deletedAt: null, version },
    data: { version: { increment: 1 } }
  });
  if (result.count === 0) {
    const current = await tx.shoppingList.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw httpError(404, '购物清单不存在');
    throw new VersionConflictError({
      entity: 'ShoppingList',
      id,
      expectedVersion: version,
      actualVersion: current.version
    });
  }
}

function sameIngredient(
  existing: { ingredientId: string | null; ingredientNameSnapshot: string },
  input: ShoppingItemInput
): boolean {
  return input.ingredientId
    ? existing.ingredientId === input.ingredientId
    : !existing.ingredientId &&
        existing.ingredientNameSnapshot.trim().toLocaleLowerCase() === input.ingredientName.trim().toLocaleLowerCase();
}

function hasStructuredQuantity(item: {
  quantity: number | null;
  unit: QuantityUnit | null;
}): item is { quantity: number; unit: QuantityUnit } {
  return item.quantity !== null && Number.isFinite(item.quantity) && item.quantity > 0 && item.unit !== null;
}

async function addOrMerge(tx: Tx, listId: string, input: ShoppingItemInput): Promise<void> {
  const normalized = validateItem(input);
  const existingItems = await tx.shoppingListItem.findMany({ where: { shoppingListId: listId, completed: false } });
  // 只有“新项与既有项都具备有效结构化数量+单位且单位同维可换算”才数值累加；
  // 自由规格项（quantity/unit 为空）不参与累加，避免把「适量」当成 1 份翻倍。
  const inputQuantity = normalized.quantity;
  const inputUnit = normalized.unit;
  const existing =
    inputQuantity !== null && inputUnit !== null
      ? existingItems.find(
          (candidate) =>
            sameIngredient(candidate, input) &&
            hasStructuredQuantity(candidate) &&
            canConvertUnit(inputUnit, candidate.unit)
        )
      : undefined;
  if (existing && hasStructuredQuantity(existing) && inputQuantity !== null && inputUnit !== null) {
    const converted = convertQuantity(inputQuantity, inputUnit, existing.unit);
    if (converted !== null) {
      await tx.shoppingListItem.update({
        where: { id: existing.id },
        // 合并后旧自由规格文本必然过期（如「200克」+500g），同步清空；
        // category 仅在新值非空时对齐，未提供时保留原分类。
        data: {
          quantity: existing.quantity + converted,
          amountText: null,
          ...(normalized.category !== null ? { category: normalized.category } : {})
        }
      });
      return;
    }
  }
  await tx.shoppingListItem.create({
    data: {
      shoppingListId: listId,
      ingredientId: input.ingredientId ?? null,
      ingredientNameSnapshot: normalized.ingredientName,
      quantity: normalized.quantity,
      unit: normalized.unit,
      amountText: normalized.amountText,
      category: normalized.category,
      sourceType: input.sourceType ?? 'MANUAL',
      sourceId: input.sourceId ?? null,
      completed: input.completed ?? false,
      sortOrder: input.sortOrder ?? existingItems.length,
      notes: input.notes ?? null
    }
  });
}

export async function listShoppingLists(database: PrismaClient, status?: ShoppingListStatus) {
  return database.shoppingList.findMany({
    where: { deletedAt: null, ...(status ? { status } : {}) },
    include: listInclude,
    orderBy: { updatedAt: 'desc' }
  });
}

export async function getShoppingList(database: PrismaClient, id: string) {
  const list = await database.shoppingList.findFirst({ where: { id, deletedAt: null }, include: listInclude });
  if (!list) throw httpError(404, '购物清单不存在');
  return list;
}

export async function createShoppingList(database: PrismaClient, input: ShoppingListInput) {
  if (!input.name?.trim()) throw httpError(400, '清单名称不能为空');
  return database.$transaction(async (tx) => {
    const list = await tx.shoppingList.create({
      data: { name: input.name.trim(), status: input.status ?? 'ACTIVE', notes: input.notes ?? null }
    });
    for (const item of input.items ?? []) await addOrMerge(tx, list.id, item);
    return tx.shoppingList.findUniqueOrThrow({ where: { id: list.id }, include: listInclude });
  });
}

export async function updateShoppingList(
  database: PrismaClient,
  id: string,
  version: number,
  input: Partial<ShoppingListInput>
) {
  return database.$transaction(async (tx) => {
    await claimListVersion(tx, id, version);
    if (input.name !== undefined && !input.name.trim()) throw httpError(400, '清单名称不能为空');
    await tx.shoppingList.update({
      where: { id },
      data: { name: input.name?.trim(), status: input.status, notes: input.notes }
    });
    return tx.shoppingList.findUniqueOrThrow({ where: { id }, include: listInclude });
  });
}

export async function deleteShoppingList(database: PrismaClient, id: string, version: number) {
  return database.$transaction(async (tx) => {
    await claimListVersion(tx, id, version);
    const deletedAt = new Date();
    await tx.shoppingList.update({ where: { id }, data: { deletedAt } });
    await recordDeletedItem(tx, 'ShoppingList', id, deletedAt);
    return { id };
  });
}

export async function addShoppingItem(
  database: PrismaClient,
  listId: string,
  version: number,
  input: ShoppingItemInput
) {
  return database.$transaction(async (tx) => {
    await claimListVersion(tx, listId, version);
    await addOrMerge(tx, listId, input);
    return tx.shoppingList.findUniqueOrThrow({ where: { id: listId }, include: listInclude });
  });
}

export async function updateShoppingItem(
  database: PrismaClient,
  itemId: string,
  version: number,
  input: Partial<ShoppingItemInput>
) {
  return database.$transaction(async (tx) => {
    const item = await tx.shoppingListItem.findUnique({ where: { id: itemId } });
    if (!item) throw httpError(404, '购物清单项目不存在');
    await claimListVersion(tx, item.shoppingListId, version);

    // 显式请求校验：PUT 只要触及 quantity 或 unit，就必须同时显式提供两者，
    // 不再用原记录补齐缺的一方（否则 quantity-only 会被静默接受成“半更新”）。
    const structuredTouched = input.quantity !== undefined || input.unit !== undefined;
    if (structuredTouched && (input.quantity === undefined || input.unit === undefined))
      throw httpError(400, '更新采购数量与单位时必须同时提供或同时为空');

    const nextQuantity = input.quantity === undefined ? item.quantity : input.quantity;
    const nextUnit = input.unit === undefined ? item.unit : input.unit;
    const amountTextExplicit = input.amountText !== undefined;
    // 显式补填/改写结构化数量单位且未显式传 amountText 时，旧自由规格（如「适量」）必须失效，
    // 否则前端会继续优先展示过期文本。
    const nextAmountText = amountTextExplicit
      ? normalizeAmountText(input.amountText)
      : structuredTouched && nextQuantity !== null && nextUnit !== null
        ? null
        : item.amountText;
    const nextName = input.ingredientName ?? item.ingredientNameSnapshot;
    const normalized = validateItem({
      ingredientName: nextName,
      quantity: nextQuantity,
      unit: nextUnit,
      amountText: nextAmountText
    });

    await tx.shoppingListItem.update({
      where: { id: itemId },
      data: {
        // 未传 ingredientId 时 undefined → Prisma 不更新，既有食材关联不会丢
        ingredientId: input.ingredientId,
        ingredientNameSnapshot: normalized.ingredientName,
        quantity: input.quantity === undefined ? undefined : nextQuantity,
        unit: input.unit === undefined ? undefined : nextUnit,
        amountText: amountTextExplicit ? normalized.amountText : nextAmountText,
        // category 未传则保留原值；显式传空串/null 视为清空
        category: input.category === undefined ? undefined : normalizeCategory(input.category),
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        completed: input.completed,
        sortOrder: input.sortOrder,
        notes: input.notes
      }
    });
    return tx.shoppingList.findUniqueOrThrow({ where: { id: item.shoppingListId }, include: listInclude });
  });
}

export async function deleteShoppingItem(database: PrismaClient, itemId: string, version: number) {
  return database.$transaction(async (tx) => {
    const item = await tx.shoppingListItem.findUnique({ where: { id: itemId } });
    if (!item) throw httpError(404, '购物清单项目不存在');
    await claimListVersion(tx, item.shoppingListId, version);
    await tx.shoppingListItem.delete({ where: { id: itemId } });
    return { id: itemId, shoppingListId: item.shoppingListId };
  });
}

export async function clearCompleted(database: PrismaClient, listId: string, version: number) {
  return database.$transaction(async (tx) => {
    await claimListVersion(tx, listId, version);
    const result = await tx.shoppingListItem.deleteMany({ where: { shoppingListId: listId, completed: true } });
    return {
      list: await tx.shoppingList.findUniqueOrThrow({ where: { id: listId }, include: listInclude }),
      cleared: result.count
    };
  });
}

/**
 * 菜谱缺料批量补齐：同一事务内按「同菜谱同食材对齐 update / 未命中 create 独立行」处理，
 * 整批只推进一次清单版本；重复点击同一菜谱严格幂等（不会把 2 个累加成 4 个）。
 */
export async function replenishRecipeItems(database: PrismaClient, listId: string, input: ReplenishRecipeInput) {
  const recipeId = (input.recipeId ?? '').trim();
  if (!recipeId) throw httpError(400, '菜谱 ID 不能为空');
  if (!Array.isArray(input.items) || input.items.length === 0) throw httpError(400, '补货项目不能为空');
  return database.$transaction(async (tx) => {
    await claimListVersion(tx, listId, input.version);
    const list = await tx.shoppingList.findFirst({ where: { id: listId, deletedAt: null } });
    if (!list) throw httpError(404, '购物清单不存在');
    if (list.status !== 'ACTIVE') throw httpError(409, '仅进行中的购物清单支持补齐缺料');

    const allItems = await tx.shoppingListItem.findMany({ where: { shoppingListId: listId } });
    let nextSortOrder = allItems.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;
    const sameRecipeItems = allItems.filter(
      (item) => !item.completed && item.sourceType === 'RECIPE' && item.sourceId === recipeId
    );

    for (const raw of input.items) {
      const normalized = validateItem(raw);
      // 失效 ingredientId 自动降级为 null，避免外键报错阻断整批补货
      let ingredientId: string | null = null;
      if (raw.ingredientId) {
        const ingredient = await tx.ingredient.findFirst({ where: { id: raw.ingredientId, deletedAt: null } });
        ingredientId = ingredient?.id ?? null;
      }
      const matched = sameRecipeItems.find((existing) =>
        ingredientId !== null
          ? existing.ingredientId === ingredientId
          : existing.ingredientId === null &&
            existing.ingredientNameSnapshot.trim().toLocaleLowerCase() ===
              normalized.ingredientName.toLocaleLowerCase()
      );
      const notesUpdate =
        raw.notes !== undefined && raw.notes !== null && raw.notes.trim() !== '' ? raw.notes.trim() : undefined;
      if (matched) {
        await tx.shoppingListItem.update({
          where: { id: matched.id },
          data: {
            ingredientId,
            ingredientNameSnapshot: normalized.ingredientName,
            quantity: normalized.quantity,
            unit: normalized.unit,
            amountText: normalized.amountText,
            // category 与 notes 同策略：本次非空才对齐，未传/空值保留既有分类
            ...(normalized.category !== null ? { category: normalized.category } : {}),
            ...(notesUpdate !== undefined ? { notes: notesUpdate } : {})
          }
        });
        Object.assign(matched, {
          ingredientId,
          ingredientNameSnapshot: normalized.ingredientName,
          quantity: normalized.quantity,
          unit: normalized.unit,
          amountText: normalized.amountText,
          ...(normalized.category !== null ? { category: normalized.category } : {})
        });
        continue;
      }
      const created = await tx.shoppingListItem.create({
        data: {
          shoppingListId: listId,
          ingredientId,
          ingredientNameSnapshot: normalized.ingredientName,
          quantity: normalized.quantity,
          unit: normalized.unit,
          amountText: normalized.amountText,
          category: normalized.category,
          sourceType: 'RECIPE',
          sourceId: recipeId,
          completed: false,
          sortOrder: nextSortOrder++,
          notes: raw.notes ?? null
        }
      });
      sameRecipeItems.push(created);
    }
    return tx.shoppingList.findUniqueOrThrow({ where: { id: listId }, include: listInclude });
  });
}

export async function checkInShoppingList(database: PrismaClient, listId: string, input: ShoppingCheckinInput) {
  if (!input.operationId || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.operationId))
    throw httpError(400, 'operationId 无效');
  if (!Number.isInteger(input.version) || input.version < 1) throw httpError(400, 'version 必须是正整数');
  if (!Array.isArray(input.itemIds) || input.itemIds.length === 0 || input.itemIds.some((id) => typeof id !== 'string'))
    throw httpError(400, 'itemIds 必须是非空字符串数组');
  if (new Set(input.itemIds).size !== input.itemIds.length) throw httpError(400, 'itemIds 不能重复');
  const hash = payloadHash(input);
  return database.$transaction(async (tx) => {
    const prior = await tx.shoppingCheckinOperation.findUnique({ where: { id: input.operationId } });
    if (prior) {
      if (prior.payloadHash !== hash) throw httpError(409, 'operationId 已用于其他入库请求');
      // operationId 与首次入库的清单绑定：相同 payload 换 URL 清单不得返回旧清单的缓存结果（幂等假成功），
      // 否则另一张清单上的重复请求会被伪装成“已完成”。保留 payloadHash 方法，只补充该显式绑定校验。
      if (prior.shoppingListId !== listId) throw httpError(409, 'operationId 已用于其他购物清单的入库请求');
      return JSON.parse(prior.resultJson);
    }
    const list = await tx.shoppingList.findFirst({ where: { id: listId, deletedAt: null }, include: { items: true } });
    if (!list) throw httpError(404, '购物清单不存在');
    if (list.version !== input.version)
      throw new VersionConflictError({
        entity: 'ShoppingList',
        id: listId,
        expectedVersion: input.version,
        actualVersion: list.version
      });
    const selected = input.itemIds.map((id) => list.items.find((item) => item.id === id));
    if (selected.some((item) => !item)) throw httpError(400, '存在不属于该购物清单的项目');
    const items = selected as NonNullable<(typeof selected)[number]>[];
    // 缺量原子拦截：必须在任何库存写入 / 清单删除 / operation 记录之前完成判定。
    // 自由规格（amountText）项无法换算入库，要求用户先补填结构化数量单位。
    const missingQuantity = items.find((item) => !hasStructuredQuantity(item));
    if (missingQuantity)
      throw httpError(
        422,
        `食材「${missingQuantity.ingredientNameSnapshot}」缺少有效的采购数量或单位，请先补填后再入库`,
        'SHOPPING_CHECKIN_QUANTITY_REQUIRED'
      );
    const structuredItems = items as Array<(typeof items)[number] & { quantity: number; unit: QuantityUnit }>;
    for (const item of structuredItems) {
      if (item.ingredientId) {
        const ingredient = await tx.ingredient.findFirst({ where: { id: item.ingredientId, deletedAt: null } });
        if (!ingredient) throw httpError(409, `食材「${item.ingredientNameSnapshot}」不存在或已删除`);
        if (!canConvertUnit(item.unit, ingredient.unit))
          throw httpError(409, `食材「${item.ingredientNameSnapshot}」单位无法换算`);
        if (item.completed && item.ingredientId) continue;
      } else if (!item.ingredientNameSnapshot.trim()) throw httpError(400, '新食材名称不能为空');
    }
    for (const item of structuredItems) {
      if (item.ingredientId) {
        const ingredient = await tx.ingredient.findFirstOrThrow({ where: { id: item.ingredientId, deletedAt: null } });
        const added = convertQuantity(item.quantity, item.unit, ingredient.unit);
        if (added === null) throw httpError(409, '库存单位无法换算');
        const batch = await tx.inventoryBatch.create({
          data: { ingredientId: ingredient.id, quantity: item.quantity, unit: item.unit, purchaseDate: today() }
        });
        await tx.inventoryLog.create({
          data: {
            ingredientId: ingredient.id,
            ingredientNameSnapshot: ingredient.name,
            inventoryBatchId: batch.id,
            beforeQuantity: 0,
            changeQuantity: item.quantity,
            afterQuantity: item.quantity,
            unit: item.unit,
            changeType: 'PURCHASE'
          }
        });
        await tx.ingredient.update({
          where: { id: ingredient.id },
          data: { quantity: { increment: added }, version: { increment: 1 } }
        });
      } else {
        const ingredient = await tx.ingredient.create({
          data: {
            name: item.ingredientNameSnapshot.trim(),
            quantity: item.quantity,
            unit: item.unit,
            purchaseDate: today(),
            inventoryBatches: { create: { quantity: item.quantity, unit: item.unit, purchaseDate: today() } }
          },
          include: { inventoryBatches: true }
        });
        const batch = ingredient.inventoryBatches[0];
        await tx.inventoryLog.create({
          data: {
            ingredientId: ingredient.id,
            ingredientNameSnapshot: ingredient.name,
            inventoryBatchId: batch.id,
            beforeQuantity: 0,
            changeQuantity: item.quantity,
            afterQuantity: item.quantity,
            unit: item.unit,
            changeType: 'PURCHASE'
          }
        });
      }
    }
    await tx.shoppingListItem.deleteMany({ where: { shoppingListId: listId, id: { in: input.itemIds } } });
    await claimListVersion(tx, listId, input.version);
    const result = await tx.shoppingList.findUniqueOrThrow({ where: { id: listId }, include: listInclude });
    await tx.shoppingCheckinOperation.create({
      data: { id: input.operationId, shoppingListId: listId, payloadHash: hash, resultJson: JSON.stringify(result) }
    });
    return result;
  });
}

export async function generateShoppingList(
  database: PrismaClient,
  input: { listId?: string; version?: number; name?: string; mode?: 'LOW_STOCK'; items?: ShoppingItemInput[] }
) {
  return database.$transaction(async (tx) => {
    let listId = input.listId;
    if (listId) {
      if (input.version === undefined) throw httpError(400, '向现有清单生成项目时必须提供版本号');
      await claimListVersion(tx, listId, input.version);
    } else {
      const list = await tx.shoppingList.create({ data: { name: input.name?.trim() || '待采购清单' } });
      listId = list.id;
    }
    const items = [...(input.items ?? [])];
    if (input.mode === 'LOW_STOCK') {
      const ingredients = await tx.ingredient.findMany({ where: { deletedAt: null, minStock: { not: null } } });
      for (const ingredient of ingredients) {
        if (ingredient.minStock !== null && ingredient.quantity < ingredient.minStock)
          items.push({
            ingredientId: ingredient.id,
            ingredientName: ingredient.name,
            quantity: ingredient.minStock - ingredient.quantity,
            unit: ingredient.unit,
            sourceType: ingredient.quantity <= 0 ? 'INSUFFICIENT_STOCK' : 'LOW_STOCK',
            sourceId: ingredient.id
          });
      }
    }
    for (const item of items) await addOrMerge(tx, listId, item);
    return tx.shoppingList.findUniqueOrThrow({ where: { id: listId }, include: listInclude });
  });
}
