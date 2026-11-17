import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedDevelopmentData } from '../src/database/seed.js';
import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { INGREDIENT_CATEGORIES, normalizeIngredientCategory } from '../src/modules/ingredients/categories.js';
import { registerIngredientRoutes } from '../src/modules/ingredients/routes.js';
import { registerInventoryRoutes } from '../src/modules/inventory/routes.js';
import { randomRecommendation } from '../src/modules/recommendations/service.js';
import { registerShoppingRoutes } from '../src/modules/shopping/routes.js';

/**
 * T-006B 后端逻辑收口（真实 HTTP + 真实 Prisma，无 mock）：
 * 7 类历史映射、种子批次、无批次存量自愈（消耗/聚合推荐）、编辑同步汇总批次、
 * 购物入库分类与到期日/位置汇总、pantry 推荐过期/不足/空配料判定、inventoryOnly 缺量单位 fail-closed。
 */

const database = createTestPrismaClient();
const runId = randomUUID().slice(0, 8);
const PREFIX = `t006b-${runId}`;
const offsetDate = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString('sv-SE');
};

let app: FastifyInstance;

const trackedIngredientIds: string[] = [];
const trackedRecipeIds: string[] = [];
const trackedListIds: string[] = [];
const trackedHistoryIds: string[] = [];

async function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as never }) });
  return { status: response.statusCode, body: response.json() as any };
}

async function createIngredientDirect(data: Record<string, unknown>): Promise<any> {
  const ingredient = await database.ingredient.create({
    data: { name: `${PREFIX}-食材`, unit: 'GRAM', quantity: 0, ...data } as never
  });
  trackedIngredientIds.push(ingredient.id);
  return ingredient;
}

async function createRecipeDirect(data: {
  name: string;
  mealType?: 'AFTERNOON_TEA' | 'SOUP';
  ingredients?: Array<Record<string, unknown>>;
}): Promise<any> {
  const recipe = await database.recipe.create({
    data: {
      name: data.name,
      ...(data.mealType ? { mealTypes: { create: { mealType: data.mealType } } } : {}),
      ...(data.ingredients ? { ingredients: { create: data.ingredients as never } } : {})
    }
  });
  trackedRecipeIds.push(recipe.id);
  return recipe;
}

async function createShoppingList(name: string, items: Array<Record<string, unknown>>) {
  const created = await database.shoppingList.create({
    data: { name, items: { create: items.map((item, index) => ({ sortOrder: index, ...item })) as never } }
  });
  trackedListIds.push(created.id);
  return database.shoppingList.findUniqueOrThrow({
    where: { id: created.id },
    include: { items: { orderBy: { sortOrder: 'asc' } } }
  });
}

describe('T-006B 食材/库存/推荐/购物 业务逻辑闭包', () => {
  beforeAll(async () => {
    await database.$connect();
    app = Fastify({ logger: false });
    registerErrorHandlers(app);
    await registerIngredientRoutes(app, database);
    await registerInventoryRoutes(app, database);
    await registerShoppingRoutes(app, database);
  });

  afterAll(async () => {
    await database.recommendationHistory.deleteMany({ where: { id: { in: trackedHistoryIds } } });
    if (trackedRecipeIds.length) {
      await database.recipeIngredient.deleteMany({ where: { recipeId: { in: trackedRecipeIds } } });
      await database.recipeStep.deleteMany({ where: { recipeId: { in: trackedRecipeIds } } });
      await database.recipeTag.deleteMany({ where: { recipeId: { in: trackedRecipeIds } } });
      await database.recipeMealType.deleteMany({ where: { recipeId: { in: trackedRecipeIds } } });
      await database.recipeMealRole.deleteMany({ where: { recipeId: { in: trackedRecipeIds } } });
      await database.recipeTool.deleteMany({ where: { recipeId: { in: trackedRecipeIds } } });
      await database.recipe.deleteMany({ where: { id: { in: trackedRecipeIds } } });
    }
    await database.shoppingListItem.deleteMany({ where: { shoppingListId: { in: trackedListIds } } });
    await database.shoppingCheckinOperation.deleteMany({ where: { shoppingListId: { in: trackedListIds } } });
    await database.shoppingList.deleteMany({ where: { id: { in: trackedListIds } } });
    if (trackedIngredientIds.length) {
      await database.inventoryLog.deleteMany({ where: { ingredientId: { in: trackedIngredientIds } } });
      await database.inventoryBatch.deleteMany({ where: { ingredientId: { in: trackedIngredientIds } } });
      await database.ingredient.deleteMany({ where: { id: { in: trackedIngredientIds } } });
    }
    await app.close();
    await database.$disconnect();
  });

  it('AC-分类：历史分类/空分类按 7 类归一，分类筛选计数之和等于全部总数', async () => {
    const legacy: Array<[string, string | null]> = [
      ['T006B蔬菜', '蔬菜'],
      ['T006B鸡蛋', '蛋奶'],
      ['T006B鲈鱼', '海鲜'],
      ['T006B面粉', '烘焙'],
      ['T006B苹果', '水果'],
      ['T006B什物', null],
      ['T006B空串', '  ']
    ];
    for (const [name, category] of legacy) {
      await createIngredientDirect({ name, category, unit: 'PIECE', quantity: 1 });
    }
    const search = encodeURIComponent('T006B');
    const all = await inject('GET', `/api/v1/ingredients?search=${search}&pageSize=100`);
    expect(all.status).toBe(200);
    expect(all.body.data.total).toBe(legacy.length);
    for (const item of all.body.data.items) expect(INGREDIENT_CATEGORIES).toContain(item.category);

    let sum = 0;
    for (const category of INGREDIENT_CATEGORIES) {
      const filtered = await inject(
        'GET',
        `/api/v1/ingredients?search=${search}&pageSize=100&category=${encodeURIComponent(category)}`
      );
      expect(filtered.status, category).toBe(200);
      for (const item of filtered.body.data.items) expect(item.category).toBe(category);
      sum += filtered.body.data.total;
    }
    expect(sum).toBe(all.body.data.total);
    // 旧分类名与新分类等价；「全部」不参与过滤
    const legacySame = await inject(
      'GET',
      `/api/v1/ingredients?search=${search}&pageSize=100&category=${encodeURIComponent('蛋奶')}`
    );
    expect(legacySame.body.data.total).toBe(1);
    expect(legacySame.body.data.items[0].category).toBe('蛋奶豆制');
    const allAlias = await inject('GET', `/api/v1/ingredients?search=${search}&pageSize=100&category=全部`);
    expect(allAlias.body.data.total).toBe(legacy.length);
    expect(normalizeIngredientCategory('水果', null)).toBe('其他');
    expect(normalizeIngredientCategory(null, '排骨')).toBe('肉禽');
  });

  it.each([
    ['鸡蛋', '蛋奶豆制'],
    ['鸭蛋', '蛋奶豆制'],
    ['牛奶', '蛋奶豆制'],
    ['羊奶', '蛋奶豆制'],
    ['鸡精', '调味'],
    ['豆瓣酱', '调味'],
    ['土豆', '蔬菜'],
    ['玉米', '蔬菜'],
    ['毛豆', '蔬菜'],
    ['牛油果', '其他'],
    ['鸡胸肉', '肉禽'],
    ['鲈鱼', '水产']
  ])('空分类食材 %s 归入 %s，具体食材词优先于歧义单字', (name, category) => {
    expect(normalizeIngredientCategory(null, name)).toBe(category);
  });

  it('跨单位消耗返回的数量与单位一致', async () => {
    const ingredient = await createIngredientDirect({ name: `${PREFIX}-公斤米`, quantity: 1, unit: 'KILOGRAM' });
    const response = await inject('POST', `/api/v1/ingredients/${ingredient.id}/consume`, {
      mode: 'QUANTITY',
      quantity: 250,
      unit: 'GRAM',
      ingredientVersion: ingredient.version
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ consumedQuantity: 250, consumedUnit: 'GRAM' });
    expect(response.body.data.ingredient.quantity).toBe(0.75);
  });

  it('AC-种子：12 条种子食材分类/位置/单位合理且有匹配活批次，菜谱带分类，重复执行幂等', async () => {
    await seedDevelopmentData(database);
    const ingredients = await database.ingredient.findMany({
      where: { id: { startsWith: 'dev-ingredient-' } },
      include: { inventoryBatches: { where: { deletedAt: null } } },
      orderBy: { id: 'asc' }
    });
    expect(ingredients).toHaveLength(12);
    for (const ingredient of ingredients) {
      expect(INGREDIENT_CATEGORIES, ingredient.name).toContain(ingredient.category as string);
      expect(ingredient.location?.trim(), ingredient.name).toBeTruthy();
      expect(ingredient.quantity, ingredient.name).toBeGreaterThan(0);
      const active = ingredient.inventoryBatches.filter((batch) => batch.quantity > 0);
      expect(active, ingredient.name).toHaveLength(1);
      expect(active[0].unit).toBe(ingredient.unit);
      expect(active[0].quantity).toBe(ingredient.quantity);
    }
    const recipes = await database.recipe.findMany({
      where: { id: { startsWith: 'dev-recipe-' } },
      select: { name: true, category: true }
    });
    expect(recipes).toHaveLength(6);
    for (const recipe of recipes) expect(recipe.category?.trim(), recipe.name).toBeTruthy();
    expect(new Set(recipes.map((recipe) => recipe.category)).size).toBeGreaterThan(1);

    const batchWhere = { ingredientId: { startsWith: 'dev-ingredient-' } };
    const batchCount = await database.inventoryBatch.count({ where: batchWhere });
    await seedDevelopmentData(database);
    expect(await database.inventoryBatch.count({ where: batchWhere })).toBe(batchCount);

    // 多批次、自定义位置/日期和已删除批次都必须经得起重复 seed。
    const original = ingredients[0];
    const originalBatch = original.inventoryBatches[0];
    let extraBatchId: string | undefined;
    try {
      await database.ingredient.update({
        where: { id: original.id },
        data: {
          name: '用户自定食材',
          quantity: 300,
          unit: 'GRAM',
          location: '自定柜',
          purchaseDate: '2026-10-01',
          expiryDate: '2026-12-01'
        }
      });
      await database.inventoryBatch.update({
        where: { id: originalBatch.id },
        data: { quantity: 100, deletedAt: new Date() }
      });
      const extraBatch = await database.inventoryBatch.create({
        data: { ingredientId: original.id, quantity: 300, unit: 'GRAM', location: '自定柜' }
      });
      extraBatchId = extraBatch.id;
      const beforeIngredient = await database.ingredient.findUniqueOrThrow({ where: { id: original.id } });
      const beforeBatches = await database.inventoryBatch.findMany({
        where: { ingredientId: original.id },
        orderBy: { id: 'asc' }
      });
      await seedDevelopmentData(database);
      expect(await database.ingredient.findUniqueOrThrow({ where: { id: original.id } })).toEqual(beforeIngredient);
      expect(
        await database.inventoryBatch.findMany({ where: { ingredientId: original.id }, orderBy: { id: 'asc' } })
      ).toEqual(beforeBatches);
    } finally {
      if (extraBatchId) await database.inventoryBatch.delete({ where: { id: extraBatchId } });
      await database.inventoryBatch.update({
        where: { id: originalBatch.id },
        data: { quantity: originalBatch.quantity, deletedAt: originalBatch.deletedAt }
      });
      await database.ingredient.update({
        where: { id: original.id },
        data: {
          name: original.name,
          quantity: original.quantity,
          unit: original.unit,
          location: original.location,
          purchaseDate: original.purchaseDate,
          expiryDate: original.expiryDate
        }
      });
    }
  });

  it('AC-自愈：quantity>0 无活批次的历史存量，QUANTITY/ALL 消耗均 200 且真实补建批次与日志', async () => {
    const ingredient = await createIngredientDirect({
      name: `${PREFIX}-历史无批次米`,
      quantity: 300,
      unit: 'GRAM',
      expiryDate: offsetDate(10),
      location: '储物柜'
    });
    const partial = await inject('POST', `/api/v1/ingredients/${ingredient.id}/consume`, {
      mode: 'QUANTITY',
      quantity: 100,
      unit: 'GRAM',
      ingredientVersion: ingredient.version
    });
    expect(partial.status, partial.body).toBe(200);
    expect(partial.body.data.ingredient.quantity).toBe(200);
    const healed = await database.inventoryBatch.findMany({ where: { ingredientId: ingredient.id } });
    expect(healed).toHaveLength(1);
    expect(healed[0]).toMatchObject({ quantity: 200, unit: 'GRAM', location: '储物柜', expiryDate: offsetDate(10) });
    const logs = await database.inventoryLog.findMany({
      where: { ingredientId: ingredient.id },
      orderBy: { createdAt: 'asc' }
    });
    expect(logs.map((log) => log.changeType)).toEqual(['ADJUST', 'MANUAL_DEDUCT']);

    const all = await inject('POST', `/api/v1/ingredients/${ingredient.id}/consume`, {
      mode: 'ALL',
      ingredientVersion: partial.body.data.ingredient.version
    });
    expect(all.status, all.body).toBe(200);
    expect(all.body.data.ingredient.quantity).toBe(0);
    const reloaded = await inject('GET', `/api/v1/ingredients/${ingredient.id}`);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.data.status).toBe('DEPLETED');
  });

  it('AC-编辑：PUT 数量/位置/到期日同步进批次（新增差额与扣减），汇总等于活批次之和', async () => {
    const created = await inject('POST', '/api/v1/ingredients', {
      name: `${PREFIX}-编辑同步肉`,
      unit: 'GRAM',
      category: '肉类',
      batches: [{ quantity: 400, unit: 'GRAM', expiryDate: '2027-01-01', location: '冷藏室' }]
    });
    expect(created.status, created.body).toBe(201);
    const dto = created.body.data;
    trackedIngredientIds.push(dto.id);
    expect(dto.category).toBe('肉禽');

    const reduced = await inject('PUT', `/api/v1/ingredients/${dto.id}`, {
      name: dto.name,
      unit: 'GRAM',
      quantity: 250,
      purchaseDate: '2026-12-01',
      expiryDate: '2027-02-02',
      location: '冷冻室',
      version: dto.version
    });
    expect(reduced.status, reduced.body).toBe(200);
    expect(reduced.body.data.quantity).toBe(250);
    expect(reduced.body.data.location).toBe('冷冻室');
    expect(reduced.body.data.expiryDate).toBe('2027-02-02');
    let batches = await database.inventoryBatch.findMany({ where: { ingredientId: dto.id } });
    expect(batches.reduce((total, batch) => total + batch.quantity, 0)).toBe(250);
    expect(batches[0]).toMatchObject({ quantity: 250, location: '冷冻室', expiryDate: '2027-02-02' });

    const increased = await inject('PUT', `/api/v1/ingredients/${dto.id}`, {
      name: dto.name,
      unit: 'GRAM',
      quantity: 1000,
      expiryDate: '2027-02-02',
      version: reduced.body.data.version
    });
    expect(increased.status, increased.body).toBe(200);
    batches = await database.inventoryBatch.findMany({ where: { ingredientId: dto.id } });
    expect(batches.reduce((total, batch) => total + batch.quantity, 0)).toBe(1000);
    expect(batches.some((batch) => batch.quantity === 750)).toBe(true);

    // 前端历史字段名 storageLocation 等价于 location，且无需批次参数即可保存
    const locationAlias = await inject('PUT', `/api/v1/ingredients/${dto.id}`, {
      name: dto.name,
      unit: 'GRAM',
      storageLocation: '阳台储物',
      version: increased.body.data.version
    });
    expect(locationAlias.status, locationAlias.body).toBe(200);
    expect(locationAlias.body.data.location).toBe('阳台储物');
    const representative = await database.inventoryBatch.findFirstOrThrow({
      where: { ingredientId: dto.id, location: '阳台储物' }
    });
    expect(representative.quantity).toBeGreaterThan(0);

    // 历史存量（quantity>0 但无任何批次）编辑：先补建等效批次，再按缺口/扣减同步
    const legacy = await createIngredientDirect({
      name: `${PREFIX}-编辑历史存量`,
      quantity: 120,
      unit: 'PIECE',
      location: '冷藏室'
    });
    const edited = await inject('PUT', `/api/v1/ingredients/${legacy.id}`, {
      name: legacy.name,
      unit: 'PIECE',
      quantity: 100,
      version: legacy.version
    });
    expect(edited.status, edited.body).toBe(200);
    expect(edited.body.data.quantity).toBe(100);
    const legacyBatches = await database.inventoryBatch.findMany({ where: { ingredientId: legacy.id } });
    expect(legacyBatches).toHaveLength(1);
    expect(legacyBatches[0]).toMatchObject({ quantity: 100, unit: 'PIECE' });
    const legacyLogs = await database.inventoryLog.findMany({
      where: { ingredientId: legacy.id },
      orderBy: { createdAt: 'asc' }
    });
    expect(legacyLogs.map((log) => log.changeType)).toEqual(['ADJUST', 'MANUAL_DEDUCT']);
  });

  it('多批次食材级编辑同步所有活批次，省略字段保留且显式清空生效', async () => {
    const created = await inject('POST', '/api/v1/ingredients', {
      name: `${PREFIX}-多批次编辑`,
      unit: 'GRAM',
      batches: [
        { quantity: 100, unit: 'GRAM', purchaseDate: '2026-10-01', expiryDate: '2027-01-01', location: '冷藏室' },
        { quantity: 200, unit: 'GRAM', purchaseDate: '2026-10-02', expiryDate: '2027-02-01', location: '冷冻室' }
      ]
    });
    expect(created.status).toBe(201);
    const item = created.body.data;
    trackedIngredientIds.push(item.id);
    const edited = await inject('PUT', `/api/v1/ingredients/${item.id}`, {
      name: item.name,
      unit: 'GRAM',
      expiryDate: '2027-03-01',
      version: item.version
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({
      quantity: 300,
      expiryDate: '2027-03-01',
      location: '冷藏室',
      purchaseDate: '2026-10-01'
    });
    const first = await database.inventoryBatch.findFirstOrThrow({ where: { ingredientId: item.id, quantity: 100 } });
    expect(first).toMatchObject({ expiryDate: '2027-03-01', location: '冷藏室', purchaseDate: '2026-10-01' });
    const increased = await inject('PUT', `/api/v1/ingredients/${item.id}`, {
      name: item.name,
      unit: 'GRAM',
      quantity: 400,
      version: edited.body.data.version
    });
    expect(increased.status).toBe(200);
    expect(increased.body.data).toMatchObject({
      quantity: 400,
      expiryDate: '2027-03-01',
      location: '冷藏室',
      purchaseDate: '2026-10-01'
    });
    const reduced = await inject('PUT', `/api/v1/ingredients/${item.id}`, {
      name: item.name,
      unit: 'GRAM',
      quantity: 50,
      version: increased.body.data.version
    });
    expect(reduced.status).toBe(200);
    const active = reduced.body.data.inventoryBatches.filter((batch: any) => batch.quantity > 0);
    expect(active).toHaveLength(1);
    expect(reduced.body.data.expiryDate).toBe(active[0].expiryDate);
    expect(reduced.body.data.location).toBe(active[0].location);
    const cleared = await inject('PUT', `/api/v1/ingredients/${item.id}`, {
      name: item.name,
      unit: 'GRAM',
      expiryDate: null,
      location: null,
      version: reduced.body.data.version
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ expiryDate: null, location: null });
    for (const batch of cleared.body.data.inventoryBatches.filter((batch: any) => batch.quantity > 0)) {
      expect(batch).toMatchObject({ expiryDate: null, location: null });
    }
  });

  it('历史批次元数据为空时只改名称不会清空食材日期位置', async () => {
    const item = await createIngredientDirect({
      name: `${PREFIX}-旧批次元数据`,
      quantity: 100,
      unit: 'GRAM',
      expiryDate: '2027-01-01',
      purchaseDate: '2026-10-01',
      location: '储物柜'
    });
    await database.inventoryBatch.create({ data: { ingredientId: item.id, quantity: 100, unit: 'GRAM' } });
    const edited = await inject('PUT', `/api/v1/ingredients/${item.id}`, {
      name: `${item.name}改`,
      unit: 'GRAM',
      version: item.version
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({
      expiryDate: '2027-01-01',
      purchaseDate: '2026-10-01',
      location: '储物柜'
    });
    const list = await createShoppingList(`${PREFIX}-保留元数据`, [
      {
        ingredientId: item.id,
        ingredientNameSnapshot: item.name,
        quantity: 50,
        unit: 'GRAM',
        completed: true,
        sourceType: 'MANUAL'
      }
    ]);
    const checkedIn = await inject('POST', `/api/v1/shopping-lists/${list.id}/check-in`, {
      version: list.version,
      operationId: `${PREFIX}-meta-op`,
      itemIds: [list.items[0].id]
    });
    expect(checkedIn.status).toBe(200);
    expect(await database.ingredient.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({
      quantity: 150,
      expiryDate: '2027-01-01',
      location: '储物柜'
    });
  });

  it('AC-入库：check-in 保留分类并在累加后重算汇总数量/最早到期日/位置', async () => {
    const ingredient = await createIngredientDirect({
      name: `${PREFIX}-入库米`,
      quantity: 100,
      unit: 'GRAM',
      location: '冷藏室',
      expiryDate: '2027-05-01',
      category: null
    });
    const list = await createShoppingList(`${PREFIX}-清单A`, [
      {
        ingredientId: ingredient.id,
        ingredientNameSnapshot: ingredient.name,
        quantity: 50,
        unit: 'GRAM',
        category: '主食',
        sourceType: 'MANUAL',
        completed: true
      }
    ]);
    const response = await inject('POST', `/api/v1/shopping-lists/${list.id}/check-in`, {
      version: list.version,
      operationId: `${PREFIX}-op-a`,
      itemIds: [list.items[0].id]
    });
    expect(response.status, response.body).toBe(200);
    const updated = await database.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } });
    expect(updated.quantity).toBe(150);
    expect(updated.category).toBe('主食粮油');
    expect(updated.expiryDate).toBe('2027-05-01');
    expect(updated.location).toBe('冷藏室');
    const batches = await database.inventoryBatch.findMany({ where: { ingredientId: ingredient.id } });
    expect(batches.reduce((total, batch) => total + batch.quantity, 0)).toBe(150);
    expect(batches).toHaveLength(2);

    const listB = await createShoppingList(`${PREFIX}-清单B`, [
      {
        ingredientNameSnapshot: `${PREFIX}-入库水果`,
        quantity: 3,
        unit: 'PIECE',
        category: '水果',
        sourceType: 'MANUAL',
        completed: true
      }
    ]);
    const created = await inject('POST', `/api/v1/shopping-lists/${listB.id}/check-in`, {
      version: listB.version,
      operationId: `${PREFIX}-op-b`,
      itemIds: [listB.items[0].id]
    });
    expect(created.status, created.body).toBe(200);
    const newIngredient = await database.ingredient.findFirstOrThrow({
      where: { name: `${PREFIX}-入库水果` }
    });
    trackedIngredientIds.push(newIngredient.id);
    expect(newIngredient.category).toBe('其他');
    expect(newIngredient.quantity).toBe(3);
  });

  it('AC-推荐：无批次存量按等效批次补齐齐备度且不写库；过期批次不得被自愈', async () => {
    const healable = await createIngredientDirect({
      name: `${PREFIX}-推荐存量土豆`,
      quantity: 500,
      unit: 'GRAM'
    });
    const healableRecipe = await createRecipeDirect({
      name: `${PREFIX}-推荐存量菜`,
      mealType: 'AFTERNOON_TEA',
      ingredients: [
        {
          ingredientId: healable.id,
          ingredientNameSnapshot: healable.name,
          quantity: 200,
          unit: 'GRAM'
        }
      ]
    });
    const expired = await createIngredientDirect({
      name: `${PREFIX}-推荐过期鱼`,
      quantity: 500,
      unit: 'GRAM',
      inventoryBatches: { create: { quantity: 500, unit: 'GRAM', expiryDate: offsetDate(-1) } }
    });
    const expiredRecipe = await createRecipeDirect({
      name: `${PREFIX}-推荐过期菜`,
      mealType: 'AFTERNOON_TEA',
      ingredients: [
        {
          ingredientId: expired.id,
          ingredientNameSnapshot: expired.name,
          quantity: 100,
          unit: 'GRAM'
        }
      ]
    });
    const emptyRecipe = await createRecipeDirect({
      name: `${PREFIX}-推荐空配料菜`,
      mealType: 'AFTERNOON_TEA',
      ingredients: [{ ingredientNameSnapshot: `${PREFIX}-盐少许`, amountText: '少许' }]
    });
    // 量不足：库存 50g < 需 200g，必须判缺料而不是按「有库存」算齐备
    const insufficient = await createIngredientDirect({
      name: `${PREFIX}-推荐不足葱`,
      quantity: 50,
      unit: 'GRAM'
    });
    const insufficientRecipe = await createRecipeDirect({
      name: `${PREFIX}-推荐不足菜`,
      mealType: 'AFTERNOON_TEA',
      ingredients: [
        {
          ingredientId: insufficient.id,
          ingredientNameSnapshot: insufficient.name,
          quantity: 200,
          unit: 'GRAM'
        }
      ]
    });
    // 汇总已过期且无任何批次：不得被等效自愈成可用库存
    const staleSummary = await createIngredientDirect({
      name: `${PREFIX}-推荐过期汇总菜`,
      quantity: 500,
      unit: 'GRAM',
      expiryDate: offsetDate(-2)
    });
    const staleSummaryRecipe = await createRecipeDirect({
      name: `${PREFIX}-推荐过期汇总菜谱`,
      mealType: 'AFTERNOON_TEA',
      ingredients: [
        {
          ingredientId: staleSummary.id,
          ingredientNameSnapshot: staleSummary.name,
          quantity: 100,
          unit: 'GRAM'
        }
      ]
    });

    const response = await inject('POST', '/api/v1/kitchen/recommend', { mode: 'ALLOW_PURCHASE', limit: 100 });
    expect(response.status, response.body).toBe(200);
    const items: any[] = response.body.data.items;
    const byId = (id: string) => items.find((item) => item.recipe.id === id);

    expect(byId(healableRecipe.id)).toMatchObject({
      completion: 100,
      inventoryCheckable: true,
      completionLabel: '100% 可直接做'
    });
    expect(byId(expiredRecipe.id)?.completion).toBe(0);
    expect(byId(expiredRecipe.id)?.missingIngredients).toHaveLength(1);
    expect(byId(emptyRecipe.id)).toMatchObject({
      completion: 0,
      inventoryCheckable: false,
      completionLabel: '未录入配料，无法核对库存'
    });
    expect(byId(insufficientRecipe.id)?.completion).toBe(0);
    expect(byId(insufficientRecipe.id)?.missingIngredients).toEqual([
      expect.objectContaining({ ingredientId: insufficient.id, reason: '库存不足', quantity: 150 })
    ]);
    expect(byId(staleSummaryRecipe.id)?.completion).toBe(0);
    expect(byId(staleSummaryRecipe.id)?.missingIngredients).toHaveLength(1);
    expect(byId(staleSummaryRecipe.id)?.completionLabel).not.toBe('100% 可直接做');

    // 读路径自愈只存在于内存：不产生任何批次
    expect(await database.inventoryBatch.count({ where: { ingredientId: healable.id } })).toBe(0);
    expect(await database.inventoryBatch.count({ where: { ingredientId: staleSummary.id } })).toBe(0);

    const onlyInventory = await inject('POST', '/api/v1/kitchen/recommend', {
      mode: 'ONLY_INVENTORY',
      limit: 100
    });
    const ids = (onlyInventory.body.data.items as any[]).map((item) => item.recipe.id);
    expect(ids).toContain(healableRecipe.id);
    expect(ids).not.toContain(expiredRecipe.id);
    expect(ids).not.toContain(emptyRecipe.id);
    expect(ids).not.toContain(insufficientRecipe.id);
    expect(ids).not.toContain(staleSummaryRecipe.id);
  });

  it('AC-随机推荐：inventoryOnly 对缺数量/单位的必需配料 fail-closed', async () => {
    const stocked = await createIngredientDirect({
      name: `${PREFIX}-随机存量豆腐`,
      quantity: 400,
      unit: 'GRAM'
    });
    const measure = async () => {
      const filtered = await randomRecommendation(
        database,
        { sourceTypes: ['RECIPE'], mealType: 'SOUP', inventoryOnly: true, repeatDays: 0 },
        () => 0
      );
      const unfiltered = await randomRecommendation(
        database,
        { sourceTypes: ['RECIPE'], mealType: 'SOUP', inventoryOnly: false, repeatDays: 0 },
        () => 0
      );
      trackedHistoryIds.push(filtered.historyId, unfiltered.historyId);
      const [filteredRow, unfilteredRow] = await Promise.all([
        database.recommendationHistory.findUniqueOrThrow({ where: { id: filtered.historyId } }),
        database.recommendationHistory.findUniqueOrThrow({ where: { id: unfiltered.historyId } })
      ]);
      return { filtered: filteredRow.candidateCount, unfiltered: unfilteredRow.candidateCount };
    };

    const baseline = await measure();
    // 只有过期批次（amountText/none 之外）的食材不得被等效自愈成可用库存
    const expired = await createIngredientDirect({
      name: `${PREFIX}-随机过期虾`,
      quantity: 500,
      unit: 'GRAM',
      inventoryBatches: { create: { quantity: 500, unit: 'GRAM', expiryDate: offsetDate(-3) } }
    });
    await createRecipeDirect({
      name: `${PREFIX}-随机过期菜`,
      mealType: 'SOUP',
      ingredients: [{ ingredientId: expired.id, ingredientNameSnapshot: expired.name, quantity: 100, unit: 'GRAM' }]
    });
    const expiredOnly = await measure();
    expect(expiredOnly.filtered).toBe(baseline.filtered);
    expect(expiredOnly.unfiltered).toBe(baseline.unfiltered + 1);
    // 缺单位：必需配料只有自由文本「适量」，无法证明库存齐备
    await createRecipeDirect({
      name: `${PREFIX}-随机缺单位菜`,
      mealType: 'SOUP',
      ingredients: [{ ingredientId: stocked.id, ingredientNameSnapshot: stocked.name, amountText: '适量' }]
    });
    const missingUnit = await measure();
    expect(missingUnit.filtered).toBe(expiredOnly.filtered);
    expect(missingUnit.unfiltered).toBe(expiredOnly.unfiltered + 1);

    // 缺数量：只有单位没有数量
    await createRecipeDirect({
      name: `${PREFIX}-随机缺数量菜`,
      mealType: 'SOUP',
      ingredients: [{ ingredientId: stocked.id, ingredientNameSnapshot: stocked.name, unit: 'GRAM' }]
    });
    const missingQuantity = await measure();
    expect(missingQuantity.filtered).toBe(missingUnit.filtered);
    expect(missingQuantity.unfiltered).toBe(missingUnit.unfiltered + 1);

    // 未关联库存食材：同样不能算齐备
    await createRecipeDirect({
      name: `${PREFIX}-随机未关联菜`,
      mealType: 'SOUP',
      ingredients: [{ ingredientNameSnapshot: `${PREFIX}-无关联豆`, quantity: 10, unit: 'GRAM' }]
    });
    const unlinked = await measure();
    expect(unlinked.filtered).toBe(missingQuantity.filtered);
    expect(unlinked.unfiltered).toBe(missingQuantity.unfiltered + 1);

    // 结构完整的可做菜谱才进入 inventoryOnly
    await createRecipeDirect({
      name: `${PREFIX}-随机可做菜`,
      mealType: 'SOUP',
      ingredients: [{ ingredientId: stocked.id, ingredientNameSnapshot: stocked.name, quantity: 100, unit: 'GRAM' }]
    });
    const complete = await measure();
    expect(complete.filtered).toBe(unlinked.filtered + 1);
    expect(complete.unfiltered).toBe(unlinked.unfiltered + 1);
  });
});
