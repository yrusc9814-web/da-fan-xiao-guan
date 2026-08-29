import type { PrismaClient } from '@prisma/client';

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function idsOf(items: Array<{ entityType: string; entityId: string }>, entityType: string): string[] {
  return items.filter((item) => item.entityType === entityType).map((item) => item.entityId);
}

export async function listDeletedItems(database: PrismaClient) {
  await database.deletedItem.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const items = await database.deletedItem.findMany({ orderBy: { deletedAt: 'desc' } });
  const names = new Map<string, string>();
  const key = (entityType: string, entityId: string) => `${entityType}:${entityId}`;

  const recipeIds = idsOf(items, 'Recipe');
  if (recipeIds.length) {
    const rows = await database.recipe.findMany({ where: { id: { in: recipeIds } }, select: { id: true, name: true } });
    for (const row of rows) names.set(key('Recipe', row.id), row.name);
  }
  const ingredientIds = idsOf(items, 'Ingredient');
  if (ingredientIds.length) {
    const rows = await database.ingredient.findMany({
      where: { id: { in: ingredientIds } },
      select: { id: true, name: true }
    });
    for (const row of rows) names.set(key('Ingredient', row.id), row.name);
  }
  const toolIds = idsOf(items, 'KitchenTool');
  if (toolIds.length) {
    const rows = await database.kitchenTool.findMany({
      where: { id: { in: toolIds } },
      select: { id: true, name: true }
    });
    for (const row of rows) names.set(key('KitchenTool', row.id), row.name);
  }
  const storeIds = idsOf(items, 'Store');
  if (storeIds.length) {
    const rows = await database.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true } });
    for (const row of rows) names.set(key('Store', row.id), row.name);
  }
  const planIds = idsOf(items, 'MealPlan');
  if (planIds.length) {
    const rows = await database.mealPlan.findMany({
      where: { id: { in: planIds } },
      select: { id: true, planDate: true, mealType: true }
    });
    for (const row of rows) names.set(key('MealPlan', row.id), `${row.planDate} ${row.mealType}`);
  }
  const recordIds = idsOf(items, 'MealRecord');
  if (recordIds.length) {
    const rows = await database.mealRecord.findMany({
      where: { id: { in: recordIds } },
      select: { id: true, recordDate: true, mealType: true }
    });
    for (const row of rows) names.set(key('MealRecord', row.id), `${row.recordDate} ${row.mealType}`);
  }
  const listIds = idsOf(items, 'ShoppingList');
  if (listIds.length) {
    const rows = await database.shoppingList.findMany({
      where: { id: { in: listIds } },
      select: { id: true, name: true }
    });
    for (const row of rows) names.set(key('ShoppingList', row.id), row.name);
  }

  return items.map((item) => ({
    ...item,
    name: names.get(key(item.entityType, item.entityId)) ?? item.entityId
  }));
}

export async function restoreDeletedItem(database: PrismaClient, id: string) {
  return database.$transaction(async (tx) => {
    const item = await tx.deletedItem.findUnique({ where: { id } });
    if (!item) throw httpError(404, '回收站项目不存在');
    if (item.expiresAt && item.expiresAt < new Date()) {
      await tx.deletedItem.delete({ where: { id } });
      throw httpError(410, '该项目已超过 30 天恢复期');
    }
    const data = { deletedAt: null, version: { increment: 1 } as const };
    if (item.entityType === 'Recipe') await tx.recipe.update({ where: { id: item.entityId }, data });
    else if (item.entityType === 'Ingredient') {
      await tx.ingredient.update({ where: { id: item.entityId }, data });
      await tx.inventoryBatch.updateMany({
        where: { ingredientId: item.entityId },
        data: { deletedAt: null, version: { increment: 1 } }
      });
    } else if (item.entityType === 'KitchenTool') await tx.kitchenTool.update({ where: { id: item.entityId }, data });
    else if (item.entityType === 'Store') await tx.store.update({ where: { id: item.entityId }, data });
    else if (item.entityType === 'MealPlan') await tx.mealPlan.update({ where: { id: item.entityId }, data });
    else if (item.entityType === 'MealRecord') await tx.mealRecord.update({ where: { id: item.entityId }, data });
    else if (item.entityType === 'ShoppingList') await tx.shoppingList.update({ where: { id: item.entityId }, data });
    else throw httpError(422, '该项目类型暂不支持恢复');
    await tx.deletedItem.delete({ where: { id } });
    return { id: item.entityId, entityType: item.entityType, restored: true };
  });
}
