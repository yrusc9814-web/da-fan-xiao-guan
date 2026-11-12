import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../../database/test-database.js';
import { registerErrorHandlers } from '../../plugins/error-handler.js';
import { registerShoppingRoutes } from './routes.js';

const database = createTestPrismaClient();
const app = Fastify({ logger: false });
const runId = randomUUID().slice(0, 8);
const PREFIX = `van31-${runId}`;
const today = () => new Date().toLocaleDateString('sv-SE');

const trackedIngredientIds: string[] = [];
const trackedListIds: string[] = [];

async function createIngredient(name: string, quantity: number, unit: 'GRAM' | 'KILOGRAM' | 'PIECE') {
  const ingredient = await database.ingredient.create({ data: { name, quantity, unit } });
  trackedIngredientIds.push(ingredient.id);
  return ingredient;
}

async function createList(name: string, items: Array<Record<string, unknown>>) {
  // 显式 sortOrder：嵌套 create 的默认 sortOrder 全为 0，读回顺序不稳定，会让“选中项”定位错位
  const withOrder = items.map((item, index) => ({ sortOrder: index, ...item }));
  const created = await database.shoppingList.create({ data: { name, items: { create: withOrder as never } } });
  trackedListIds.push(created.id);
  // 按 sortOrder 读回，与创建顺序一致（API 的 items 顺序是 completed 优先，不能直接用来定位测试项）
  return database.shoppingList.findUniqueOrThrow({
    where: { id: created.id },
    include: { items: { orderBy: { sortOrder: 'asc' } } }
  });
}

const itemIdByName = (list: { items: Array<{ id: string; ingredientNameSnapshot: string }> }, name: string) => {
  const item = list.items.find((candidate) => candidate.ingredientNameSnapshot === name);
  if (!item) throw new Error(`测试夹具缺少购物项：${name}`);
  return item.id;
};

const checkIn = (listId: string, payload: { version: number; operationId: string; itemIds: string[] }) =>
  app.inject({ method: 'POST', url: `/api/v1/shopping-lists/${listId}/check-in`, payload });

const purchaseLogs = (ingredientIds: string[]) =>
  database.inventoryLog.findMany({
    where: { changeType: 'PURCHASE', ingredientId: { in: ingredientIds } },
    orderBy: { createdAt: 'asc' }
  });

describe('VAN-31 shopping check-in', () => {
  beforeAll(async () => {
    await database.$connect();
    registerErrorHandlers(app);
    await registerShoppingRoutes(app, database);
  });

  afterAll(async () => {
    // 只清理本文件自己创建的数据（按前缀 + 显式 track），不依赖任何全局 reset
    const ingredients = await database.ingredient.findMany({
      where: { OR: [{ name: { startsWith: PREFIX } }, { id: { in: trackedIngredientIds } }] }
    });
    const ingredientIds = ingredients.map((row) => row.id);
    const lists = await database.shoppingList.findMany({
      where: { OR: [{ name: { startsWith: PREFIX } }, { id: { in: trackedListIds } }] }
    });
    const listIds = lists.map((row) => row.id);

    await database.inventoryLog.deleteMany({
      where: { OR: [{ ingredientId: { in: ingredientIds } }, { ingredientNameSnapshot: { startsWith: PREFIX } }] }
    });
    await database.inventoryBatch.deleteMany({ where: { ingredientId: { in: ingredientIds } } });
    await database.shoppingListItem.deleteMany({
      where: { OR: [{ shoppingListId: { in: listIds } }, { ingredientNameSnapshot: { startsWith: PREFIX } }] }
    });
    await database.shoppingCheckinOperation.deleteMany({
      where: { OR: [{ shoppingListId: { in: listIds } }, { id: { startsWith: PREFIX } }] }
    });
    await database.shoppingList.deleteMany({ where: { id: { in: listIds } } });
    await database.deletedItem.deleteMany({ where: { entityId: { in: listIds } } });
    await database.ingredient.deleteMany({ where: { id: { in: ingredientIds } } });

    await app.close();
    await database.$disconnect();
  });

  it('existing 项加库存、new 项建食材+批次+日志，unchecked 与不相关 completed 项原样保留', async () => {
    const existing = await createIngredient(`${PREFIX}-米`, 100, 'GRAM');
    const list = await createList(`${PREFIX}-主清单`, [
      {
        ingredientId: existing.id,
        ingredientNameSnapshot: `${PREFIX}-米`,
        quantity: 500,
        unit: 'GRAM',
        sourceType: 'MANUAL',
        completed: true
      },
      { ingredientNameSnapshot: `${PREFIX}-鸡蛋`, quantity: 6, unit: 'PIECE', sourceType: 'MANUAL', completed: true },
      { ingredientNameSnapshot: `${PREFIX}-未勾选`, quantity: 1, unit: 'BAG', sourceType: 'MANUAL', completed: false },
      {
        ingredientNameSnapshot: `${PREFIX}-无关已完成`,
        quantity: 2,
        unit: 'PIECE',
        sourceType: 'MANUAL',
        completed: true
      }
    ]);
    const selected = list.items.slice(0, 2).map((item) => item.id);

    const response = await checkIn(list.id, {
      version: list.version,
      operationId: `${PREFIX}-op-main`,
      itemIds: selected
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = JSON.parse(response.body).data;
    expect(body.version).toBe(list.version + 1);
    expect(body.items.map((item: { ingredientNameSnapshot: string }) => item.ingredientNameSnapshot)).toEqual([
      `${PREFIX}-未勾选`,
      `${PREFIX}-无关已完成`
    ]);

    const updatedExisting = await database.ingredient.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updatedExisting.quantity).toBe(600);
    expect(updatedExisting.version).toBe(existing.version + 1);

    const created = await database.ingredient.findFirstOrThrow({
      where: { name: `${PREFIX}-鸡蛋` },
      include: { inventoryBatches: true }
    });
    expect(created).toMatchObject({ quantity: 6, unit: 'PIECE' });
    expect(created.inventoryBatches).toHaveLength(1);
    expect(created.inventoryBatches[0]).toMatchObject({
      quantity: 6,
      unit: 'PIECE',
      purchaseDate: today(),
      ingredientId: created.id
    });

    const logs = await purchaseLogs([existing.id, created.id]);
    expect(logs).toHaveLength(2);
    expect(logs.find((log) => log.ingredientId === existing.id)).toMatchObject({
      beforeQuantity: 0,
      changeQuantity: 500,
      afterQuantity: 500,
      unit: 'GRAM',
      ingredientNameSnapshot: `${PREFIX}-米`
    });
    expect(logs.find((log) => log.ingredientId === created.id)).toMatchObject({
      beforeQuantity: 0,
      changeQuantity: 6,
      afterQuantity: 6,
      unit: 'PIECE'
    });

    const operation = await database.shoppingCheckinOperation.findUniqueOrThrow({
      where: { id: `${PREFIX}-op-main` }
    });
    expect(operation.shoppingListId).toBe(list.id);
    expect(JSON.parse(operation.resultJson).version).toBe(list.version + 1);
  });

  it('可换算单位按目标单位折算入库；不可换算单位 409 且零写入', async () => {
    const rice = await createIngredient(`${PREFIX}-换算米`, 500, 'GRAM');
    const convertible = await createList(`${PREFIX}-换算清单`, [
      {
        ingredientId: rice.id,
        ingredientNameSnapshot: `${PREFIX}-换算米`,
        quantity: 2,
        unit: 'KILOGRAM',
        sourceType: 'MANUAL',
        completed: true
      }
    ]);
    const ok = await checkIn(convertible.id, {
      version: convertible.version,
      operationId: `${PREFIX}-op-convert`,
      itemIds: convertible.items.map((item) => item.id)
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await database.ingredient.findUniqueOrThrow({ where: { id: rice.id } })).quantity).toBe(2500);
    expect((await purchaseLogs([rice.id]))[0]).toMatchObject({ changeQuantity: 2, unit: 'KILOGRAM' });

    const blocked = await createList(`${PREFIX}-阻断清单`, [
      {
        ingredientId: rice.id,
        ingredientNameSnapshot: `${PREFIX}-换算米`,
        quantity: 3,
        unit: 'PIECE',
        sourceType: 'MANUAL',
        completed: true
      }
    ]);
    const quantityBefore = (await database.ingredient.findUniqueOrThrow({ where: { id: rice.id } })).quantity;
    const logsBefore = await purchaseLogs([rice.id]);
    const rejected = await checkIn(blocked.id, {
      version: blocked.version,
      operationId: `${PREFIX}-op-blocked`,
      itemIds: blocked.items.map((item) => item.id)
    });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(JSON.parse(rejected.body).error.message).toContain('单位无法换算');
    expect((await database.ingredient.findUniqueOrThrow({ where: { id: rice.id } })).quantity).toBe(quantityBefore);
    expect(await purchaseLogs([rice.id])).toHaveLength(logsBefore.length);
    const after = await database.shoppingList.findUniqueOrThrow({
      where: { id: blocked.id },
      include: { items: true }
    });
    expect(after.version).toBe(blocked.version);
    expect(after.items).toHaveLength(1);
    expect(await database.shoppingCheckinOperation.count({ where: { id: `${PREFIX}-op-blocked` } })).toBe(0);
  });

  it('stale version 返回 409 VERSION_CONFLICT 且零写入', async () => {
    const list = await createList(`${PREFIX}-版本清单`, [
      { ingredientNameSnapshot: `${PREFIX}-版本米`, quantity: 1, unit: 'GRAM', sourceType: 'MANUAL', completed: true }
    ]);
    const stale = await checkIn(list.id, {
      version: list.version + 3,
      operationId: `${PREFIX}-op-stale`,
      itemIds: list.items.map((item) => item.id)
    });
    expect(stale.statusCode, stale.body).toBe(409);
    const error = JSON.parse(stale.body).error;
    expect(error.code).toBe('VERSION_CONFLICT');
    expect(error.details).toMatchObject({
      entity: 'ShoppingList',
      id: list.id,
      expectedVersion: list.version + 3,
      actualVersion: list.version
    });
    expect(await database.ingredient.count({ where: { name: `${PREFIX}-版本米` } })).toBe(0);
    const after = await database.shoppingList.findUniqueOrThrow({ where: { id: list.id }, include: { items: true } });
    expect(after.version).toBe(list.version);
    expect(after.items).toHaveLength(1);
  });

  it('重复 id、跨清单 id、不存在 id 均 400 且不产生任何库存变化', async () => {
    const list = await createList(`${PREFIX}-非法清单`, [
      { ingredientNameSnapshot: `${PREFIX}-非法A`, quantity: 1, unit: 'GRAM', sourceType: 'MANUAL', completed: true },
      { ingredientNameSnapshot: `${PREFIX}-非法B`, quantity: 1, unit: 'GRAM', sourceType: 'MANUAL', completed: true }
    ]);
    const other = await createList(`${PREFIX}-其他清单`, [
      { ingredientNameSnapshot: `${PREFIX}-外来项`, quantity: 1, unit: 'GRAM', sourceType: 'MANUAL', completed: true }
    ]);
    const ingredientsBefore = await database.ingredient.count({ where: { name: { startsWith: PREFIX } } });
    const idA = list.items[0].id;
    const idB = list.items[1].id;

    const duplicate = await checkIn(list.id, {
      version: list.version,
      operationId: `${PREFIX}-op-duplicate`,
      itemIds: [idA, idA]
    });
    expect(duplicate.statusCode, duplicate.body).toBe(400);
    expect(JSON.parse(duplicate.body).error.message).toContain('不能重复');

    const crossList = await checkIn(list.id, {
      version: list.version,
      operationId: `${PREFIX}-op-cross`,
      itemIds: [idA, other.items[0].id]
    });
    expect(crossList.statusCode, crossList.body).toBe(400);
    expect(JSON.parse(crossList.body).error.message).toContain('不属于该购物清单');

    const missing = await checkIn(list.id, {
      version: list.version,
      operationId: `${PREFIX}-op-missing`,
      itemIds: [idB, `${PREFIX}-不存在的项目`]
    });
    expect(missing.statusCode, missing.body).toBe(400);

    expect(await database.ingredient.count({ where: { name: { startsWith: PREFIX } } })).toBe(ingredientsBefore);
    const after = await database.shoppingList.findUniqueOrThrow({ where: { id: list.id }, include: { items: true } });
    expect(after.items).toHaveLength(2);
    expect(after.version).toBe(list.version);
    expect(
      await database.shoppingCheckinOperation.count({
        where: { id: { startsWith: `${PREFIX}-op-` }, shoppingListId: list.id }
      })
    ).toBe(0);
  });

  it('任一项失败时第一项批次/日志/库存零变化，清单项与 version 全部保留', async () => {
    const healthy = await createIngredient(`${PREFIX}-健康米`, 100, 'GRAM');
    const softDeleted = await createIngredient(`${PREFIX}-已删食材`, 10, 'GRAM');
    await database.ingredient.update({ where: { id: softDeleted.id }, data: { deletedAt: new Date() } });
    const list = await createList(`${PREFIX}-部分失败清单`, [
      {
        ingredientId: healthy.id,
        ingredientNameSnapshot: `${PREFIX}-健康米`,
        quantity: 200,
        unit: 'GRAM',
        sourceType: 'MANUAL',
        completed: true
      },
      { ingredientNameSnapshot: `${PREFIX}-新建项`, quantity: 3, unit: 'PIECE', sourceType: 'MANUAL', completed: true },
      {
        ingredientId: softDeleted.id,
        ingredientNameSnapshot: `${PREFIX}-已删食材`,
        quantity: 5,
        unit: 'GRAM',
        sourceType: 'MANUAL',
        completed: true
      }
    ]);

    const response = await checkIn(list.id, {
      version: list.version,
      operationId: `${PREFIX}-op-partial`,
      itemIds: list.items.map((item) => item.id)
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(JSON.parse(response.body).error.message).toContain('不存在或已删除');

    // 第一项（existing）零变化
    expect((await database.ingredient.findUniqueOrThrow({ where: { id: healthy.id } })).quantity).toBe(100);
    // 第二项（new）没有被创建
    expect(await database.ingredient.count({ where: { name: `${PREFIX}-新建项` } })).toBe(0);
    expect(await purchaseLogs([healthy.id])).toHaveLength(0);
    expect(await database.inventoryBatch.count({ where: { ingredientId: healthy.id } })).toBe(0);
    // 清单项与 version 全部保留
    const after = await database.shoppingList.findUniqueOrThrow({ where: { id: list.id }, include: { items: true } });
    expect(after.version).toBe(list.version);
    expect(after.items).toHaveLength(3);
    expect(await database.shoppingCheckinOperation.count({ where: { id: `${PREFIX}-op-partial` } })).toBe(0);
  });

  it('同一 operationId 原负载重试只写入一次，payload 不同则 409', async () => {
    const existing = await createIngredient(`${PREFIX}-幂等米`, 0, 'GRAM');
    const list = await createList(`${PREFIX}-幂等清单`, [
      {
        ingredientId: existing.id,
        ingredientNameSnapshot: `${PREFIX}-幂等米`,
        quantity: 300,
        unit: 'GRAM',
        sourceType: 'MANUAL',
        completed: true
      },
      { ingredientNameSnapshot: `${PREFIX}-幂等蛋`, quantity: 4, unit: 'PIECE', sourceType: 'MANUAL', completed: true }
    ]);
    const payload = {
      version: list.version,
      operationId: `${PREFIX}-op-idempotent`,
      itemIds: list.items.map((item) => item.id)
    };

    const first = await checkIn(list.id, payload);
    expect(first.statusCode, first.body).toBe(200);
    const second = await checkIn(list.id, payload);
    expect(second.statusCode, second.body).toBe(200);
    expect(JSON.parse(second.body).data).toEqual(JSON.parse(first.body).data);

    const replayed = await database.ingredient.findFirstOrThrow({ where: { name: `${PREFIX}-幂等蛋` } });
    expect(await purchaseLogs([existing.id, replayed.id])).toHaveLength(2);
    expect((await database.ingredient.findUniqueOrThrow({ where: { id: existing.id } })).quantity).toBe(300);
    expect(replayed.quantity).toBe(4);
    expect(await database.shoppingCheckinOperation.count({ where: { id: payload.operationId } })).toBe(1);

    const conflicting = await checkIn(list.id, { ...payload, itemIds: [payload.itemIds[0]] });
    expect(conflicting.statusCode, conflicting.body).toBe(409);
    expect(JSON.parse(conflicting.body).error.message).toContain('operationId 已用于其他入库请求');
    expect((await database.ingredient.findUniqueOrThrow({ where: { id: existing.id } })).quantity).toBe(300);
    expect(replayed.quantity).toBe(4);
    expect(await purchaseLogs([existing.id, replayed.id])).toHaveLength(2);

    const versionConflictReuse = await checkIn(list.id, { ...payload, version: payload.version + 1 });
    expect(versionConflictReuse.statusCode, versionConflictReuse.body).toBe(409);
  });

  it('只删除本次选中的项：未勾选项与其他已完成项保留且库存不变', async () => {
    const list = await createList(`${PREFIX}-保留清单`, [
      { ingredientNameSnapshot: `${PREFIX}-选中项`, quantity: 2, unit: 'GRAM', sourceType: 'MANUAL', completed: true },
      { ingredientNameSnapshot: `${PREFIX}-未勾选`, quantity: 5, unit: 'GRAM', sourceType: 'MANUAL', completed: false },
      {
        ingredientNameSnapshot: `${PREFIX}-无关已完成`,
        quantity: 7,
        unit: 'GRAM',
        sourceType: 'MANUAL',
        completed: true
      }
    ]);
    const response = await checkIn(list.id, {
      version: list.version,
      operationId: `${PREFIX}-op-retain`,
      itemIds: [itemIdByName(list, `${PREFIX}-选中项`)]
    });
    expect(response.statusCode, response.body).toBe(200);
    const after = await database.shoppingList.findUniqueOrThrow({ where: { id: list.id }, include: { items: true } });
    expect(after.items.map((item) => item.ingredientNameSnapshot).sort()).toEqual([
      `${PREFIX}-无关已完成`,
      `${PREFIX}-未勾选`
    ]);
    expect(after.items.map((item) => item.completed).sort()).toEqual([false, true]);
    // 未选中项不得产生任何库存
    expect(await database.ingredient.count({ where: { name: `${PREFIX}-无关已完成` } })).toBe(0);
    expect(await database.ingredient.count({ where: { name: `${PREFIX}-未勾选` } })).toBe(0);
    const created = await database.ingredient.findFirstOrThrow({ where: { name: `${PREFIX}-选中项` } });
    expect(created.quantity).toBe(2);
  });

  it('同一 operationId 相同 payload 换清单 URL 必须 409：无幂等假成功、两清单零写入，原 URL 仍缓存重放', async () => {
    const listA = await createList(`${PREFIX}-绑定清单A`, [
      {
        ingredientNameSnapshot: `${PREFIX}-绑定米A`,
        quantity: 2,
        unit: 'GRAM',
        sourceType: 'MANUAL',
        completed: true
      }
    ]);
    const listB = await createList(`${PREFIX}-绑定清单B`, [
      {
        ingredientNameSnapshot: `${PREFIX}-绑定米B`,
        quantity: 3,
        unit: 'GRAM',
        sourceType: 'MANUAL',
        completed: true
      }
    ]);
    const payload = {
      version: listA.version,
      operationId: `${PREFIX}-op-listbinding`,
      itemIds: listA.items.map((item) => item.id)
    };
    const first = await checkIn(listA.id, payload);
    expect(first.statusCode, first.body).toBe(200);
    const cached = JSON.parse(first.body).data;

    // 相同 version/operationId/itemIds 但 URL 指向另一张清单：payloadHash 相同也不能返回 A 的缓存结果
    const cross = await checkIn(listB.id, payload);
    expect(cross.statusCode, cross.body).toBe(409);
    expect(JSON.parse(cross.body).error.message).toContain('operationId');
    expect(JSON.parse(cross.body).error.message).toContain('购物清单');

    // 两张清单、库存、日志均不再变化
    const listAAfter = await database.shoppingList.findUniqueOrThrow({
      where: { id: listA.id },
      include: { items: true }
    });
    const listBAfter = await database.shoppingList.findUniqueOrThrow({
      where: { id: listB.id },
      include: { items: true }
    });
    expect(listAAfter.version).toBe(listA.version + 1);
    expect(listAAfter.items).toHaveLength(0);
    expect(listBAfter.version).toBe(listB.version);
    expect(listBAfter.items).toHaveLength(1);
    const ingredientA = await database.ingredient.findFirstOrThrow({ where: { name: `${PREFIX}-绑定米A` } });
    expect(ingredientA.quantity).toBe(2);
    expect(await database.ingredient.count({ where: { name: `${PREFIX}-绑定米B` } })).toBe(0);
    expect(await database.inventoryLog.count({ where: { ingredientNameSnapshot: `${PREFIX}-绑定米A` } })).toBe(1);
    expect(await database.inventoryLog.count({ where: { ingredientNameSnapshot: `${PREFIX}-绑定米B` } })).toBe(0);
    expect(await database.shoppingCheckinOperation.count({ where: { id: payload.operationId } })).toBe(1);

    // 正确原 URL + 原 payload 仍然命中幂等缓存，绝不重复扣减/重复入库
    const replay = await checkIn(listA.id, payload);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(JSON.parse(replay.body).data).toEqual(cached);
    expect((await database.ingredient.findFirstOrThrow({ where: { name: `${PREFIX}-绑定米A` } })).quantity).toBe(2);
    expect(await database.inventoryLog.count({ where: { ingredientNameSnapshot: `${PREFIX}-绑定米A` } })).toBe(1);
  });

  it('operationId 与 version 非法时 400，且不创建幂等记录', async () => {
    const list = await createList(`${PREFIX}-校验清单`, [
      { ingredientNameSnapshot: `${PREFIX}-校验米`, quantity: 1, unit: 'GRAM', sourceType: 'MANUAL', completed: true }
    ]);
    const itemIds = list.items.map((item) => item.id);
    const badOperation = await checkIn(list.id, { version: list.version, operationId: 'bad op id!', itemIds });
    expect(badOperation.statusCode, badOperation.body).toBe(400);
    expect(JSON.parse(badOperation.body).error.message).toContain('operationId 无效');

    const badVersion = await checkIn(list.id, { version: 0, operationId: `${PREFIX}-op-zero`, itemIds });
    // version 0 由路由 schema 直接拒绝（到不了 service），两种拦截都必须是 400 且零副作用
    expect(badVersion.statusCode, badVersion.body).toBe(400);

    expect(await database.shoppingCheckinOperation.count({ where: { id: { startsWith: `${PREFIX}-op-zero` } } })).toBe(
      0
    );
    expect(await database.ingredient.count({ where: { name: `${PREFIX}-校验米` } })).toBe(0);
    const after = await database.shoppingList.findUniqueOrThrow({ where: { id: list.id }, include: { items: true } });
    expect(after.items).toHaveLength(1);
    expect(after.version).toBe(list.version);
  });
});
