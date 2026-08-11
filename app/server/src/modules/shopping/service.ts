import type { Prisma, PrismaClient, QuantityUnit, ShoppingListStatus, ShoppingSourceType } from '@prisma/client';

import { VersionConflictError } from '../../database/optimistic-lock.js';
import { recordDeletedItem } from '../../database/deleted-items.js';
import { canConvertUnit, convertQuantity } from '../../database/units.js';

export interface ShoppingItemInput {
  ingredientId?: string | null;
  ingredientName: string;
  quantity: number;
  unit: QuantityUnit;
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

const listInclude = { items: { orderBy: [{ completed: 'asc' as const }, { sortOrder: 'asc' as const }] } };
type Tx = Prisma.TransactionClient;

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function validateItem(item: ShoppingItemInput): void {
  if (!item.ingredientName.trim()) throw httpError(400, '食材名称不能为空');
  if (!Number.isFinite(item.quantity) || item.quantity <= 0) throw httpError(400, '购物数量必须大于 0');
}

async function assertListVersion(tx: Tx, id: string, version: number) {
  const list = await tx.shoppingList.findFirst({ where: { id, deletedAt: null } });
  if (!list) throw httpError(404, '购物清单不存在');
  if (list.version !== version) throw new VersionConflictError({ entity: 'ShoppingList', id, expectedVersion: version, actualVersion: list.version });
  return list;
}

function sameIngredient(existing: { ingredientId: string | null; ingredientNameSnapshot: string }, input: ShoppingItemInput): boolean {
  return input.ingredientId
    ? existing.ingredientId === input.ingredientId
    : !existing.ingredientId && existing.ingredientNameSnapshot.trim().toLocaleLowerCase() === input.ingredientName.trim().toLocaleLowerCase();
}

async function addOrMerge(tx: Tx, listId: string, input: ShoppingItemInput): Promise<void> {
  validateItem(input);
  const existingItems = await tx.shoppingListItem.findMany({ where: { shoppingListId: listId, completed: false } });
  const existing = existingItems.find((candidate) => sameIngredient(candidate, input) && canConvertUnit(input.unit, candidate.unit));
  if (existing) {
    const converted = convertQuantity(input.quantity, input.unit, existing.unit);
    if (converted !== null) {
      await tx.shoppingListItem.update({ where: { id: existing.id }, data: { quantity: existing.quantity + converted } });
      return;
    }
  }
  await tx.shoppingListItem.create({
    data: {
      shoppingListId: listId,
      ingredientId: input.ingredientId ?? null,
      ingredientNameSnapshot: input.ingredientName.trim(),
      quantity: input.quantity,
      unit: input.unit,
      sourceType: input.sourceType ?? 'MANUAL',
      sourceId: input.sourceId ?? null,
      completed: input.completed ?? false,
      sortOrder: input.sortOrder ?? existingItems.length,
      notes: input.notes ?? null
    }
  });
}

export async function listShoppingLists(database: PrismaClient, status?: ShoppingListStatus) {
  return database.shoppingList.findMany({ where: { deletedAt: null, ...(status ? { status } : {}) }, include: listInclude, orderBy: { updatedAt: 'desc' } });
}

export async function getShoppingList(database: PrismaClient, id: string) {
  const list = await database.shoppingList.findFirst({ where: { id, deletedAt: null }, include: listInclude });
  if (!list) throw httpError(404, '购物清单不存在');
  return list;
}

export async function createShoppingList(database: PrismaClient, input: ShoppingListInput) {
  if (!input.name?.trim()) throw httpError(400, '清单名称不能为空');
  return database.$transaction(async (tx) => {
    const list = await tx.shoppingList.create({ data: { name: input.name.trim(), status: input.status ?? 'ACTIVE', notes: input.notes ?? null } });
    for (const item of input.items ?? []) await addOrMerge(tx, list.id, item);
    return tx.shoppingList.findUniqueOrThrow({ where: { id: list.id }, include: listInclude });
  });
}

export async function updateShoppingList(database: PrismaClient, id: string, version: number, input: Partial<ShoppingListInput>) {
  return database.$transaction(async (tx) => {
    await assertListVersion(tx, id, version);
    if (input.name !== undefined && !input.name.trim()) throw httpError(400, '清单名称不能为空');
    await tx.shoppingList.update({ where: { id }, data: { name: input.name?.trim(), status: input.status, notes: input.notes, version: { increment: 1 } } });
    return tx.shoppingList.findUniqueOrThrow({ where: { id }, include: listInclude });
  });
}

export async function deleteShoppingList(database: PrismaClient, id: string, version: number) {
  return database.$transaction(async (tx) => {
    await assertListVersion(tx, id, version);
    const deletedAt=new Date();await tx.shoppingList.update({ where: { id }, data: { deletedAt, version: { increment: 1 } } });
    await recordDeletedItem(tx,'ShoppingList',id,deletedAt);
    return { id };
  });
}

export async function addShoppingItem(database: PrismaClient, listId: string, version: number, input: ShoppingItemInput) {
  return database.$transaction(async (tx) => {
    await assertListVersion(tx, listId, version);
    await addOrMerge(tx, listId, input);
    await tx.shoppingList.update({ where: { id: listId }, data: { version: { increment: 1 } } });
    return tx.shoppingList.findUniqueOrThrow({ where: { id: listId }, include: listInclude });
  });
}

export async function updateShoppingItem(database: PrismaClient, itemId: string, version: number, input: Partial<ShoppingItemInput>) {
  return database.$transaction(async (tx) => {
    const item = await tx.shoppingListItem.findUnique({ where: { id: itemId } });
    if (!item) throw httpError(404, '购物清单项目不存在');
    await assertListVersion(tx, item.shoppingListId, version);
    const quantity = input.quantity ?? item.quantity;
    const name = input.ingredientName ?? item.ingredientNameSnapshot;
    validateItem({ ingredientName: name, quantity, unit: input.unit ?? item.unit });
    await tx.shoppingListItem.update({ where: { id: itemId }, data: {
      ingredientId: input.ingredientId,
      ingredientNameSnapshot: input.ingredientName?.trim(),
      quantity: input.quantity,
      unit: input.unit,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      completed: input.completed,
      sortOrder: input.sortOrder,
      notes: input.notes
    } });
    await tx.shoppingList.update({ where: { id: item.shoppingListId }, data: { version: { increment: 1 } } });
    return tx.shoppingList.findUniqueOrThrow({ where: { id: item.shoppingListId }, include: listInclude });
  });
}

export async function deleteShoppingItem(database: PrismaClient, itemId: string, version: number) {
  return database.$transaction(async (tx) => {
    const item = await tx.shoppingListItem.findUnique({ where: { id: itemId } });
    if (!item) throw httpError(404, '购物清单项目不存在');
    await assertListVersion(tx, item.shoppingListId, version);
    await tx.shoppingListItem.delete({ where: { id: itemId } });
    await tx.shoppingList.update({ where: { id: item.shoppingListId }, data: { version: { increment: 1 } } });
    return { id: itemId, shoppingListId: item.shoppingListId };
  });
}

export async function clearCompleted(database: PrismaClient, listId: string, version: number) {
  return database.$transaction(async (tx) => {
    await assertListVersion(tx, listId, version);
    const result = await tx.shoppingListItem.deleteMany({ where: { shoppingListId: listId, completed: true } });
    await tx.shoppingList.update({ where: { id: listId }, data: { version: { increment: 1 } } });
    return { list: await tx.shoppingList.findUniqueOrThrow({ where: { id: listId }, include: listInclude }), cleared: result.count };
  });
}

export async function generateShoppingList(database: PrismaClient, input: { listId?: string; version?: number; name?: string; mode?: 'LOW_STOCK'; items?: ShoppingItemInput[] }) {
  return database.$transaction(async (tx) => {
    let listId = input.listId;
    if (listId) {
      if (input.version === undefined) throw httpError(400, '向现有清单生成项目时必须提供版本号');
      await assertListVersion(tx, listId, input.version);
    } else {
      const list = await tx.shoppingList.create({ data: { name: input.name?.trim() || '待采购清单' } });
      listId = list.id;
    }
    const items = [...(input.items ?? [])];
    if (input.mode === 'LOW_STOCK') {
      const ingredients = await tx.ingredient.findMany({ where: { deletedAt: null, minStock: { not: null } } });
      for (const ingredient of ingredients) {
        if (ingredient.minStock !== null && ingredient.quantity < ingredient.minStock) items.push({
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
    if (input.listId) await tx.shoppingList.update({ where: { id: listId }, data: { version: { increment: 1 } } });
    return tx.shoppingList.findUniqueOrThrow({ where: { id: listId }, include: listInclude });
  });
}
