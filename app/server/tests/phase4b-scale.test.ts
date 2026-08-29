import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { deleteIngredient } from '../src/modules/ingredients/service.js';
import { registerIngredientRoutes } from '../src/modules/ingredients/routes.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';
import { registerRecipeRoutes } from '../src/modules/recipes/routes.js';
import { registerShoppingRoutes } from '../src/modules/shopping/routes.js';
import { addShoppingItem, createShoppingList } from '../src/modules/shopping/service.js';
import { listDeletedItems, restoreDeletedItem } from '../src/modules/deleted-items/service.js';
import { deleteRecipe } from '../src/modules/recipes/service.js';
import { deleteTool } from '../src/modules/tools/service.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';

const database = createTestPrismaClient();
let app: FastifyInstance;
const prefix = '验收4B-';

describe('Phase 4B 规模、分页、原子性与回收站查询', () => {
  beforeAll(async () => {
    // backup.test.ts 的 restore 会替换 data/test.db inode，module-level createTestPrismaClient()
    // 在同一 Node 进程里复用旧句柄时，后续 create 看似成功但读不到（即"菜谱不存在"，
    // 见 recipes/service.ts 的 deleteRecipe 抛错路径）。强制重建连接以刷新 inode。
    await database.$disconnect().catch(() => undefined);
    await database.$connect();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerIngredientRoutes(app, database);
    await registerRecipeRoutes(app, database);
    await registerMealRecordRoutes(app, database);
    await registerShoppingRoutes(app, database);
  });

  afterAll(async () => {
    // Phase 4B 测试造 120+ 食材/菜谱/记录后必须清理，避免影响后续的
    // recommendations.test.ts（它假设数据规模小、推荐不会被 limit=50 截掉）。
    // 严格遵守外键顺序：先子表再主表，避免 SQLite Restrict 阻塞。
    const cleanupRecipes = await database.recipe.findMany({
      where: { name: { startsWith: prefix } },
      select: { id: true }
    });
    const cleanupRecipeIds = cleanupRecipes.map((row) => row.id);
    if (cleanupRecipeIds.length) {
      await database.recipeIngredient.deleteMany({ where: { recipeId: { in: cleanupRecipeIds } } });
      await database.recipeStep.deleteMany({ where: { recipeId: { in: cleanupRecipeIds } } });
      await database.recipeTag.deleteMany({ where: { recipeId: { in: cleanupRecipeIds } } });
      await database.recipeMealType.deleteMany({ where: { recipeId: { in: cleanupRecipeIds } } });
      await database.recipeMealRole.deleteMany({ where: { recipeId: { in: cleanupRecipeIds } } });
      await database.recipeTool.deleteMany({ where: { recipeId: { in: cleanupRecipeIds } } });
      await database.recipe.deleteMany({ where: { id: { in: cleanupRecipeIds } } });
    }
    await database.ingredient.deleteMany({ where: { name: { startsWith: prefix } } });

    await app.close();
    await database.$disconnect();
  });

  it('食材 selector 搜索能命中第 101+ 条，第一页不含该条', async () => {
    await database.ingredient.createMany({
      data: Array.from({ length: 120 }, (_, index) => ({
        name: `${prefix}食材-${String(index + 1).padStart(3, '0')}`,
        unit: 'GRAM' as const
      }))
    });
    const first = await app.inject({ method: 'GET', url: '/api/v1/ingredients?page=1&pageSize=20' });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json().data;
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.total).toBeGreaterThanOrEqual(120);
    expect(firstPage.items.some((item: { name: string }) => item.name === `${prefix}食材-001`)).toBe(false);

    const searched = await app.inject({
      method: 'GET',
      url: `/api/v1/ingredients?search=${encodeURIComponent(`${prefix}食材-001`)}&page=1&pageSize=20`
    });
    expect(searched.statusCode).toBe(200);
    const names = searched.json().data.items.map((item: { name: string }) => item.name);
    expect(names).toContain(`${prefix}食材-001`);

    const cleared = await app.inject({ method: 'GET', url: '/api/v1/ingredients?page=1&pageSize=20' });
    expect(cleared.json().data.items).toHaveLength(20);

    const historical = await database.ingredient.findFirst({ where: { name: `${prefix}食材-001` } });
    expect(historical).toBeTruthy();
    const byId = await app.inject({ method: 'GET', url: `/api/v1/ingredients/${historical!.id}` });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().data.name).toBe(`${prefix}食材-001`);
  });

  it('菜谱列表搜索能命中第 101+ 条', async () => {
    await database.recipe.createMany({
      data: Array.from({ length: 120 }, (_, index) => ({
        name: `${prefix}菜谱-${String(index + 1).padStart(3, '0')}`
      }))
    });
    const first = await app.inject({ method: 'GET', url: '/api/v1/recipes?page=1&pageSize=20' });
    expect(first.json().data.items).toHaveLength(20);
    const firstNames = first.json().data.items.map((item: { name: string }) => item.name);
    expect(firstNames).not.toContain(`${prefix}菜谱-001`);
    const searched = await app.inject({
      method: 'GET',
      url: `/api/v1/recipes?search=${encodeURIComponent(`${prefix}菜谱-001`)}&page=1&pageSize=20`
    });
    expect(searched.json().data.items.map((item: { name: string }) => item.name)).toContain(`${prefix}菜谱-001`);
  });

  it('Records 分页稳定、无重复无遗漏，筛选后 total 正确，非法 pageSize 400', async () => {
    const created = [];
    for (let index = 0; index < 45; index += 1) {
      created.push(
        await database.mealRecord.create({
          data: {
            recordDate: '2047-08-29',
            recordTime: '12:00',
            mealType: 'LUNCH',
            sourceType: 'CUSTOM',
            status: index < 5 ? 'DRAFT' : 'CONFIRMED',
            notes: `${prefix}记录-${String(index + 1).padStart(2, '0')}`,
            items: { create: [{ itemType: 'CUSTOM', customName: `${prefix}项目-${index + 1}`, sortOrder: 0 }] }
          }
        })
      );
    }
    const page1 = await app.inject({
      method: 'GET',
      url: '/api/v1/records?from=2047-08-29&to=2047-08-29&page=1&pageSize=20'
    });
    const page2 = await app.inject({
      method: 'GET',
      url: '/api/v1/records?from=2047-08-29&to=2047-08-29&page=2&pageSize=20'
    });
    const page3 = await app.inject({
      method: 'GET',
      url: '/api/v1/records?from=2047-08-29&to=2047-08-29&page=3&pageSize=20'
    });
    expect(page1.statusCode).toBe(200);
    const one = page1.json().data;
    const two = page2.json().data;
    const three = page3.json().data;
    expect(one.items).toHaveLength(20);
    expect(two.items).toHaveLength(20);
    expect(three.items).toHaveLength(5);
    expect(one.total).toBe(45);
    const ids = [...one.items, ...two.items, ...three.items].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(45);
    const sorted = [...one.items, ...two.items, ...three.items]
      .sort((left: { id: string }, right: { id: string }) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))
      .map((item: { id: string }) => item.id);
    expect(ids).toEqual(sorted);

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/records?from=2047-08-29&to=2047-08-29&status=DRAFT&page=1&pageSize=20'
    });
    expect(filtered.json().data.total).toBe(5);
    expect(filtered.json().data.items).toHaveLength(5);

    const invalid = await app.inject({ method: 'GET', url: '/api/v1/records?pageSize=abc' });
    expect(invalid.statusCode).toBe(400);
    expect(created).toHaveLength(45);
  });

  it('推荐缺料一次创建购物清单：全部成功、非法项回滚、已有项按 merge 合并', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/shopping-lists',
      payload: {
        name: `${prefix}推荐缺料成功`,
        items: [
          { ingredientName: `${prefix}番茄`, quantity: 1, unit: 'OTHER', sourceType: 'RECOMMENDATION' },
          { ingredientName: `${prefix}鸡蛋`, quantity: 1, unit: 'OTHER', sourceType: 'RECOMMENDATION' },
          { ingredientName: `${prefix}葱`, quantity: 1, unit: 'OTHER', sourceType: 'RECOMMENDATION' }
        ]
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.items).toHaveLength(3);

    const before = await database.shoppingList.count({ where: { name: `${prefix}推荐缺料失败` } });
    const failed = await app.inject({
      method: 'POST',
      url: '/api/v1/shopping-lists',
      payload: {
        name: `${prefix}推荐缺料失败`,
        items: [
          { ingredientName: `${prefix}土豆`, quantity: 1, unit: 'OTHER' },
          { ingredientName: '', quantity: 1, unit: 'OTHER' },
          { ingredientName: `${prefix}青椒`, quantity: 1, unit: 'OTHER' }
        ]
      }
    });
    expect(failed.statusCode).toBe(400);
    expect(await database.shoppingList.count({ where: { name: `${prefix}推荐缺料失败` } })).toBe(before);

    const existing = await createShoppingList(database, {
      name: `${prefix}已有清单`,
      items: [{ ingredientName: `${prefix}大米`, quantity: 1, unit: 'KILOGRAM' }]
    });
    const merged = await app.inject({
      method: 'POST',
      url: `/api/v1/shopping-lists/${existing.id}/items`,
      payload: { version: existing.version, ingredientName: `${prefix}大米`, quantity: 500, unit: 'GRAM' }
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().data.items).toHaveLength(1);
    expect(merged.json().data.items[0].quantity).toBe(1.5);
  });

  it('同一清单重复加入同一批缺料按 merge 合并，不产生垃圾项', async () => {
    let list = await createShoppingList(database, { name: `${prefix}重复点击`, items: [] });
    list = await addShoppingItem(database, list.id, list.version, {
      ingredientName: `${prefix}豆腐`,
      quantity: 1,
      unit: 'OTHER',
      sourceType: 'RECOMMENDATION'
    });
    list = await addShoppingItem(database, list.id, list.version, {
      ingredientName: `${prefix}豆腐`,
      quantity: 1,
      unit: 'OTHER',
      sourceType: 'RECOMMENDATION'
    });
    expect(list.items.filter((item) => item.ingredientNameSnapshot === `${prefix}豆腐`)).toHaveLength(1);
    expect(list.items[0]?.quantity).toBe(2);
  });

  it('回收站混合类型批量查询数不随 N 线性增长，restore 契约保持', async () => {
    const recipes = await Promise.all(
      Array.from({ length: 20 }, (_, index) => database.recipe.create({ data: { name: `${prefix}回收菜谱-${index}` } }))
    );
    const ingredients = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        database.ingredient.create({ data: { name: `${prefix}回收食材-${index}`, unit: 'GRAM' } })
      )
    );
    const tools = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        database.kitchenTool.create({ data: { name: `${prefix}回收工具-${index}` } })
      )
    );
    for (const recipe of recipes) await deleteRecipe(database, recipe.id, recipe.version);
    for (const ingredient of ingredients) await deleteIngredient(database, ingredient.id, ingredient.version);
    for (const tool of tools) await deleteTool(database, tool.id, tool.version);

    // 用 Prisma 6 $extends query hook 计数 delegate 调用：vi.spyOn 在 Prisma 6 的 Proxy delegate
    // 上不稳定（见历次失败根因），mockRestore 无法把 model[method] 恢复到原始实现。
    const calls: Array<{ model: string; operation: string }> = [];
    const observedDatabase = database.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            calls.push({ model, operation });
            return query(args);
          }
        }
      }
    });

    const listed = await listDeletedItems(observedDatabase as never);
    const perEntityFindUnique = calls.filter(
      (call) =>
        call.operation === 'findUnique' &&
        ['Recipe', 'Ingredient', 'KitchenTool', 'Store', 'MealPlan', 'MealRecord', 'ShoppingList'].includes(call.model)
    ).length;
    const bulkQueries = calls.filter(
      (call) =>
        call.operation === 'findMany' &&
        [
          'DeletedItem',
          'Recipe',
          'Ingredient',
          'KitchenTool',
          'Store',
          'MealPlan',
          'MealRecord',
          'ShoppingList'
        ].includes(call.model)
    ).length;
    const mixed = listed.filter((item) => item.name.startsWith(prefix) && item.name.includes('回收'));
    expect(mixed.length).toBeGreaterThanOrEqual(52);
    expect(perEntityFindUnique).toBe(0);
    // 可证上限：1 次 deletedItem.findMany + 至多 7 类实体各 1 次 findMany = 8。
    // 任何 per-item findUnique 回退都会先被 perEntityFindUnique === 0 抓住；超过 8 次 findMany
    // 说明列表查询退化为按类型多次查询，同样不通过。
    expect(bulkQueries).toBeLessThanOrEqual(8);
    expect(mixed.some((item) => item.entityType === 'Recipe')).toBe(true);
    expect(mixed.some((item) => item.entityType === 'Ingredient')).toBe(true);
    expect(mixed.some((item) => item.entityType === 'KitchenTool')).toBe(true);
    const recipeTrash = mixed.find((item) => item.entityType === 'Recipe');
    expect(recipeTrash).toBeTruthy();
    await restoreDeletedItem(database, recipeTrash!.id);
    expect((await database.recipe.findUniqueOrThrow({ where: { id: recipeTrash!.entityId } })).deletedAt).toBeNull();
  });
});
