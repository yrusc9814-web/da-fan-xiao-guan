import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerRecipeRoutes } from '../src/modules/recipes/routes.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';

/**
 * Google2 recipeDetail「🍳 打卡」正式接口契约（真实 HTTP + 真实 Prisma，无 mock）。
 *
 * UI 事实来源：app/client/index.html index 3361
 *   `BentoService.recipes.cookCheckin(BentoModal.currentPayload)`
 *   legacy 语义 index 4325–4360（原实现为前端 localStorage 伪记录 + 硬编码扣库存 250g）。
 *
 * → POST /api/v1/recipes/:id/cook-checkin
 *   仅创建真实 CONFIRMED 饮食记录；响应 inventoryDeducted=false 声明未扣库。
 *   本轮明确不实现“打卡后的库存确认流程”：不得调用 preview/confirm、不得伪造用户同意。
 *
 * 覆盖：真实 recipe-item title 非空且 GET 一致、删除/不存在菜谱拒绝、自然幂等不重复、
 * 不暗扣库（批次/日志零变化）、invalid input 快速失败、nutrition 缺失保持 null 不造值。
 */

const database = createTestPrismaClient();
let app: FastifyInstance;

const createdRecipeIds: string[] = [];
const createdRecordIds: string[] = [];
const createdIngredientIds: string[] = [];

async function inject(
  method: 'POST' | 'GET' | 'DELETE',
  url: string,
  payload?: unknown
): Promise<{ statusCode: number; body: any }> {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  });
  return { statusCode: response.statusCode, body: response.json() };
}

async function createRecipe(payload: Record<string, unknown>): Promise<any> {
  const { statusCode, body } = await inject('POST', '/api/v1/recipes', payload);
  expect(statusCode).toBe(201);
  createdRecipeIds.push(body.data.id);
  return body.data;
}

async function cookCheckin(recipeId: string, payload: Record<string, unknown>) {
  return inject('POST', `/api/v1/recipes/${recipeId}/cook-checkin`, payload);
}

function trackRecord(record: any): any {
  if (record?.id) createdRecordIds.push(record.id);
  return record;
}

describe('Google2 烹饪打卡 cook-checkin（真实记录、不扣库）', () => {
  beforeAll(async () => {
    await database.$connect();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerRecipeRoutes(app, database);
    await registerMealRecordRoutes(app, database);
  });

  afterAll(async () => {
    if (createdRecordIds.length) {
      await database.mealRecordDiner.deleteMany({ where: { mealRecordId: { in: createdRecordIds } } });
      await database.mealRecordItem.deleteMany({ where: { mealRecordId: { in: createdRecordIds } } });
      await database.mealRecord.deleteMany({ where: { id: { in: createdRecordIds } } });
    }
    if (createdRecipeIds.length) {
      await database.recipeIngredient.deleteMany({ where: { recipeId: { in: createdRecipeIds } } });
      await database.recipeStep.deleteMany({ where: { recipeId: { in: createdRecipeIds } } });
      await database.recipe.deleteMany({ where: { id: { in: createdRecipeIds } } });
    }
    if (createdIngredientIds.length) {
      await database.inventoryLog.deleteMany({ where: { ingredientId: { in: createdIngredientIds } } });
      await database.inventoryBatch.deleteMany({ where: { ingredientId: { in: createdIngredientIds } } });
      await database.ingredient.deleteMany({ where: { id: { in: createdIngredientIds } } });
    }
    await app.close();
    await database.$disconnect();
  });

  it('创建真实 CONFIRMED 记录：recipe-item title 立即非空，GET 一致，响应声明未扣库', async () => {
    const recipe = await createRecipe({
      name: '打卡契约·番茄牛腩',
      calories: 420,
      cookingTimeMinutes: 45,
      ingredients: [{ name: '牛腩', quantity: 500, unit: 'GRAM' }],
      steps: [{ content: '炖煮至软烂' }]
    });

    const created = await cookCheckin(recipe.id, {
      recordDate: '2026-10-02',
      mealType: 'LUNCH',
      recordTime: '12:30',
      notes: '亲手做的晚饭'
    });
    expect(created.statusCode).toBe(201);
    const data = created.body.data;
    trackRecord(data.record);

    expect(data.repeated).toBe(false);
    expect(data.inventoryDeducted).toBe(false);
    expect(data.inventoryDeductionPrompt).toContain('/api/v1/consumption/preview-from-recipe');
    expect(data.recipe).toEqual({ id: recipe.id, name: '打卡契约·番茄牛腩', calories: 420 });

    const record = data.record;
    expect(record.status).toBe('CONFIRMED');
    expect(record.sourceType).toBe('HOMEMADE');
    expect(record.recordDate).toBe('2026-10-02');
    expect(record.mealType).toBe('LUNCH');
    expect(record.recordTime).toBe('12:30');
    expect(record.notes).toBe('亲手做的晚饭');
    expect(record.confirmedAt).not.toBeNull();
    // 记录源 recipe 关系真实存在，title 立即非空
    expect(record.items).toHaveLength(1);
    expect(record.items[0].itemType).toBe('RECIPE');
    expect(record.items[0].recipeId).toBe(recipe.id);
    expect(record.items[0].recipe.name).toBe('打卡契约·番茄牛腩');
    expect(record.items[0].recipe.name.trim().length).toBeGreaterThan(0);
    // 热量取菜谱真实值；rating/satiety/cost 未提供 → null，绝不伪造
    expect(record.calories).toBe(420);
    expect(record.rating).toBeNull();
    expect(record.satiety).toBeNull();
    expect(record.cost).toBeNull();

    // GET 一致
    const got = await inject('GET', `/api/v1/records/${record.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.body.data.items[0].recipe.name).toBe('打卡契约·番茄牛腩');
    expect(got.body.data.recordDate).toBe('2026-10-02');
    expect(got.body.data.mealType).toBe('LUNCH');
    expect(got.body.data.calories).toBe(420);
    expect(got.body.data.satiety).toBeNull();
    expect(got.body.data.cost).toBeNull();
    expect(got.body.data.version).toBe(record.version);

    // 该记录真实出现在列表接口
    const list = await inject('GET', '/api/v1/records?from=2026-10-02&to=2026-10-02&pageSize=100');
    expect(list.statusCode).toBe(200);
    const listed = list.body.data.items.find((item: any) => item.id === record.id);
    expect(listed).toBeDefined();
    expect(listed.items[0].recipe.name).toBe('打卡契约·番茄牛腩');
  });

  it('自然幂等：同（菜谱, 日期, 餐次）重复打卡不重复建记录，返回既有记录 repeated=true', async () => {
    const recipe = await createRecipe({ name: '打卡契约·幂等菜谱', calories: 300 });
    const payload = { recordDate: '2026-10-03', mealType: 'DINNER' };

    const first = await cookCheckin(recipe.id, payload);
    expect(first.statusCode).toBe(201);
    trackRecord(first.body.data.record);

    const second = await cookCheckin(recipe.id, payload);
    expect(second.statusCode).toBe(200);
    const data = second.body.data;
    expect(data.repeated).toBe(true);
    expect(data.inventoryDeducted).toBe(false);
    expect(data.record.id).toBe(first.body.data.record.id);

    const rows = await database.mealRecord.findMany({
      where: { recordDate: '2026-10-03', deletedAt: null },
      include: { items: true }
    });
    const matching = rows.filter((row) => row.items.some((item) => item.recipeId === recipe.id));
    expect(matching).toHaveLength(1);

    // 不同餐次/不同日期各自真实成记录
    const otherSlot = await cookCheckin(recipe.id, { recordDate: '2026-10-03', mealType: 'BREAKFAST' });
    expect(otherSlot.statusCode).toBe(201);
    trackRecord(otherSlot.body.data.record);
    expect(otherSlot.body.data.record.id).not.toBe(first.body.data.record.id);
  });

  it('不暗扣库：打卡前后库存批次数量/版本与 InventoryLog 数量完全不变', async () => {
    const ingredient = await database.ingredient.create({
      data: {
        name: '打卡契约·库存牛肉',
        unit: 'GRAM',
        quantity: 500,
        inventoryBatches: { create: { quantity: 500, unit: 'GRAM' } }
      },
      include: { inventoryBatches: true }
    });
    createdIngredientIds.push(ingredient.id);
    const recipe = await createRecipe({
      name: '打卡契约·不扣库',
      calories: 500,
      ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: 250, unit: 'GRAM' }]
    });

    const batchBefore = await database.inventoryBatch.findMany({ where: { ingredientId: ingredient.id } });
    const logCountBefore = await database.inventoryLog.count({ where: { ingredientId: ingredient.id } });

    const created = await cookCheckin(recipe.id, { recordDate: '2026-10-04', mealType: 'SOUP' });
    expect(created.statusCode).toBe(201);
    trackRecord(created.body.data.record);
    expect(created.body.data.inventoryDeducted).toBe(false);

    const batchAfter = await database.inventoryBatch.findMany({ where: { ingredientId: ingredient.id } });
    expect(batchAfter.map((b) => [b.id, b.quantity, b.version])).toEqual(
      batchBefore.map((b) => [b.id, b.quantity, b.version])
    );
    expect(await database.inventoryLog.count({ where: { ingredientId: ingredient.id } })).toBe(logCountBefore);

    const ingredientAfter = await database.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } });
    expect(ingredientAfter.quantity).toBe(500);
    expect(ingredientAfter.version).toBe(ingredient.version);

    // 打卡记录自身不挂任何库存日志（relatedRecordId 为空）
    expect(await database.inventoryLog.count({ where: { relatedRecordId: created.body.data.record.id } })).toBe(0);
  });

  it('nutrition 缺失不造值：无热量菜谱回落 null，显式真实输入原样落库', async () => {
    const plain = await createRecipe({ name: '打卡契约·无营养字段' });
    const created = await cookCheckin(plain.id, { recordDate: '2026-10-05', mealType: 'AFTERNOON_TEA' });
    expect(created.statusCode).toBe(201);
    trackRecord(created.body.data.record);
    expect(created.body.data.record.calories).toBeNull();
    expect(created.body.data.record.rating).toBeNull();
    expect(created.body.data.record.satiety).toBeNull();
    expect(created.body.data.record.cost).toBeNull();

    const rich = await createRecipe({ name: '打卡契约·真实营养', calories: 350 });
    const withValues = await cookCheckin(rich.id, {
      recordDate: '2026-10-05',
      mealType: 'DINNER',
      calories: 380,
      rating: 4.5,
      satiety: 8,
      cost: 26
    });
    expect(withValues.statusCode).toBe(201);
    trackRecord(withValues.body.data.record);
    expect(withValues.body.data.record.calories).toBe(380);
    expect(withValues.body.data.record.rating).toBe(4.5);
    expect(withValues.body.data.record.satiety).toBe(8);
    expect(withValues.body.data.record.cost).toBe(26);
  });

  it('已删除 / 不存在菜谱一律 404，且不产生任何记录', async () => {
    const before = await database.mealRecord.count();

    const missing = await cookCheckin('not-a-real-recipe-id', { recordDate: '2026-10-06', mealType: 'LUNCH' });
    expect(missing.statusCode).toBe(404);
    expect(missing.body.error.message).toContain('菜谱不存在');

    const recipe = await createRecipe({ name: '打卡契约·待删菜谱', calories: 200 });
    const deleted = await inject('DELETE', `/api/v1/recipes/${recipe.id}?version=${recipe.version}`);
    expect(deleted.statusCode).toBe(200);

    const afterDelete = await cookCheckin(recipe.id, { recordDate: '2026-10-06', mealType: 'LUNCH' });
    expect(afterDelete.statusCode).toBe(404);
    expect(afterDelete.body.error.message).toContain('菜谱不存在');

    expect(await database.mealRecord.count()).toBe(before);
  });

  it('invalid input 快速失败：坏日期/缺餐次/伪饱腹值/越界项全部 400 且零写入', async () => {
    const recipe = await createRecipe({ name: '打卡契约·非法输入', calories: 250 });
    const before = await database.mealRecord.count();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['坏日期格式', { recordDate: '2026/10/07', mealType: 'LUNCH' }],
      ['缺日期', { mealType: 'LUNCH' }],
      ['缺餐次', { recordDate: '2026-10-07' }],
      ['非法餐次', { recordDate: '2026-10-07', mealType: 'NIGHT' }],
      ['伪饱腹值 4', { recordDate: '2026-10-07', mealType: 'LUNCH', satiety: 4 }],
      ['热量为负', { recordDate: '2026-10-07', mealType: 'LUNCH', calories: -1 }],
      ['评分越界', { recordDate: '2026-10-07', mealType: 'LUNCH', rating: 6 }],
      ['消费越界', { recordDate: '2026-10-07', mealType: 'LUNCH', cost: 10000 }],
      ['含库存扣减字段', { recordDate: '2026-10-07', mealType: 'LUNCH', deductions: [{ batchId: 'x' }] }]
    ];
    for (const [label, payload] of cases) {
      const response = await cookCheckin(recipe.id, payload);
      expect(response.statusCode, label).toBe(400);
      expect(response.body.error.code, label).toBe('VALIDATION_ERROR');
    }
    expect(await database.mealRecord.count()).toBe(before);
  });

  it('打卡与库存消耗互不调用：打卡接口不暴露/不接受任何 confirm 语义', async () => {
    const recipe = await createRecipe({ name: '打卡契约·边界', calories: 180 });
    const created = await cookCheckin(recipe.id, {
      recordDate: '2026-10-08',
      mealType: 'LUNCH',
      previewToken: 'forged-token',
      operationId: 'forged-op'
    });
    // 多传的 previewToken/operationId 被 additionalProperties:false 直接拒绝，而不是静默忽略
    expect(created.statusCode).toBe(400);
    expect(created.body.error.code).toBe('VALIDATION_ERROR');

    const ok = await cookCheckin(recipe.id, { recordDate: '2026-10-08', mealType: 'LUNCH' });
    expect(ok.statusCode).toBe(201);
    trackRecord(ok.body.data.record);
    // 记录保持 CONFIRMED 状态且没有任何 ConsumptionOperation 关联（不触发确认消费流程）
    expect(await database.consumptionOperation.count({ where: { mealRecordId: ok.body.data.record.id } })).toBe(0);
  });
});
