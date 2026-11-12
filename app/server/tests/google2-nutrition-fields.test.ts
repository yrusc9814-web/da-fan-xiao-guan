import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';
import { createRecord, getRecord, listRecords, updateRecord } from '../src/modules/meal-records/service.js';
import { registerRecipeRoutes } from '../src/modules/recipes/routes.js';
import { createRecipe, updateRecipe } from '../src/modules/recipes/service.js';
import { completePlan, createPlan } from '../src/modules/meal-plans/service.js';

const database = createTestPrismaClient();
let app: FastifyInstance;

const RECORD_DATE_FROM = '2061-03-01';
const RECORD_DATE_TO = '2061-03-31';
const RECIPE_PREFIX = 'G2营养字段测试';

async function cleanup(): Promise<void> {
  const records = await database.mealRecord.findMany({
    where: { recordDate: { gte: RECORD_DATE_FROM, lte: RECORD_DATE_TO } },
    select: { id: true }
  });
  const recordIds = records.map(({ id }) => id);
  await database.mealRecordDiner.deleteMany({ where: { mealRecordId: { in: recordIds } } });
  await database.mealRecordItem.deleteMany({ where: { mealRecordId: { in: recordIds } } });
  await database.mealRecord.deleteMany({ where: { id: { in: recordIds } } });

  const plans = await database.mealPlan.findMany({
    where: { planDate: { gte: RECORD_DATE_FROM, lte: RECORD_DATE_TO } },
    select: { id: true }
  });
  const planIds = plans.map(({ id }) => id);
  await database.mealPlanDiner.deleteMany({ where: { mealPlanId: { in: planIds } } });
  await database.mealPlanItem.deleteMany({ where: { mealPlanId: { in: planIds } } });
  await database.mealPlan.deleteMany({ where: { id: { in: planIds } } });

  const recipes = await database.recipe.findMany({
    where: { name: { startsWith: RECIPE_PREFIX } },
    select: { id: true }
  });
  const recipeIds = recipes.map(({ id }) => id);
  await database.recipeIngredient.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await database.recipeStep.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await database.recipeTag.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await database.recipeMealType.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await database.recipeMealRole.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await database.recipeTool.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await database.recipe.deleteMany({ where: { id: { in: recipeIds } } });
}

function baseRecordPayload(overrides: Record<string, unknown> = {}) {
  return {
    recordDate: '2061-03-10',
    mealType: 'LUNCH',
    sourceType: 'HOMEMADE',
    ...overrides
  };
}

async function countRecords(): Promise<number> {
  return database.mealRecord.count({ where: { recordDate: { gte: RECORD_DATE_FROM, lte: RECORD_DATE_TO } } });
}

describe('Google2 营养字段（MealRecord.satiety/calories/cost、Recipe.calories）', () => {
  beforeAll(async () => {
    await database.$connect();
    await cleanup();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerMealRecordRoutes(app, database);
    await registerRecipeRoutes(app, database);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await database.$disconnect();
  });

  describe('饮食记录 create', () => {
    it('每个正式饱腹档位（3/5/7/8/10）都能写入并在读取时保持真实值', async () => {
      for (const satiety of [3, 5, 7, 8, 10]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/records',
          payload: baseRecordPayload({ satiety, calories: 550, cost: 0 })
        });
        expect(response.statusCode).toBe(201);
        const created = response.json().data;
        expect(created.satiety).toBe(satiety);
        expect(created.calories).toBe(550);
        expect(created.cost).toBe(0);

        const read = await app.inject({ method: 'GET', url: `/api/v1/records/${created.id}` });
        expect(read.statusCode).toBe(200);
        expect(read.json().data).toMatchObject({ satiety, calories: 550, cost: 0 });
      }
    });

    it('省略三个字段时落库为 null，不写入任何默认值', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/v1/records', payload: baseRecordPayload() });
      expect(response.statusCode).toBe(201);
      const created = response.json().data;
      expect(created.satiety).toBeNull();
      expect(created.calories).toBeNull();
      expect(created.cost).toBeNull();

      // 直接查库，确认不是响应层伪装
      const row = await database.mealRecord.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.satiety).toBeNull();
      expect(row.calories).toBeNull();
      expect(row.cost).toBeNull();
    });

    it('显式 null 与省略语义一致，都是 null；0 作为真实数值被保留', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/records',
        payload: baseRecordPayload({ satiety: null, calories: 0, cost: 0 })
      });
      expect(response.statusCode).toBe(201);
      // 0 是合法输入值，不得被当作“未填写”丢弃
      expect(response.json().data).toMatchObject({ satiety: null, calories: 0, cost: 0 });
    });

    it.each([
      ['非法饱腹档位 4（旧 demo 值不属正式契约）', { satiety: 4 }],
      ['饱腹档位 0', { satiety: 0 }],
      ['饱腹档位 6', { satiety: 6 }],
      ['负数饱腹', { satiety: -8 }],
      ['小数饱腹', { satiety: 8.5 }],
      ['字符串饱腹 "8"', { satiety: '8' }],
      ['布尔饱腹 true', { satiety: true }],
      ['负数热量', { calories: -1 }],
      ['小数热量', { calories: 550.5 }],
      ['字符串热量 "550"', { calories: '550' }],
      ['布尔热量', { calories: true }],
      ['负数消费', { cost: -1 }],
      ['小数消费', { cost: 12.5 }],
      ['字符串消费 "0"', { cost: '0' }],
      ['布尔消费', { cost: false }],
      ['消费超出 9999 上限', { cost: 10000 }]
    ])('%s 返回 400 且不产生任何写入', async (_label, override) => {
      const before = await countRecords();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/records',
        payload: baseRecordPayload(override)
      });
      expect(response.statusCode).toBe(400);
      expect((await countRecords()) - before).toBe(0);
    });

    it('服务层同样拒绝非法值（不仅 route schema 拦，绕过 HTTP 也不能落库）', async () => {
      await expect(
        createRecord(database, {
          recordDate: '2061-03-11',
          mealType: 'LUNCH',
          sourceType: 'HOMEMADE',
          satiety: 4
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        createRecord(database, {
          recordDate: '2061-03-11',
          mealType: 'LUNCH',
          sourceType: 'HOMEMADE',
          calories: 1.5
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        createRecord(database, {
          recordDate: '2061-03-11',
          mealType: 'LUNCH',
          sourceType: 'HOMEMADE',
          cost: 10000
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        createRecord(database, {
          recordDate: '2061-03-11',
          mealType: 'LUNCH',
          sourceType: 'HOMEMADE',
          cost: '0' as unknown as number
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      // 非有限数（Infinity / NaN）同样必须拒绝，不得被当成 0 落库
      await expect(
        createRecord(database, {
          recordDate: '2061-03-11',
          mealType: 'LUNCH',
          sourceType: 'HOMEMADE',
          calories: Number.POSITIVE_INFINITY
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        createRecord(database, {
          recordDate: '2061-03-11',
          mealType: 'LUNCH',
          sourceType: 'HOMEMADE',
          cost: Number.NaN
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        createRecord(database, {
          recordDate: '2061-03-11',
          mealType: 'LUNCH',
          sourceType: 'HOMEMADE',
          satiety: Number.POSITIVE_INFINITY
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await database.mealRecord.count({ where: { recordDate: '2061-03-11' } })).toBe(0);
    });
  });

  describe('饮食记录 update / 清空 / 保留', () => {
    it('可写入、可 set null 清空、omit 时保留旧值，且版本正确递增', async () => {
      const record = await createRecord(database, {
        recordDate: '2061-03-12',
        mealType: 'DINNER',
        sourceType: 'TAKEOUT',
        satiety: 8,
        calories: 700,
        cost: 35
      });
      expect(record.version).toBe(1);

      // 1) 改值
      const updated = await app.inject({
        method: 'PUT',
        url: `/api/v1/records/${record.id}`,
        payload: { version: record.version, satiety: 10, calories: 900, cost: 9999 }
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().data).toMatchObject({ satiety: 10, calories: 900, cost: 9999 });

      // 2) omit：三字段都不传，必须保留旧值而不是被清成 null
      const omitted = await app.inject({
        method: 'PUT',
        url: `/api/v1/records/${record.id}`,
        payload: { version: updated.json().data.version, notes: '只改备注' }
      });
      expect(omitted.statusCode).toBe(200);
      expect(omitted.json().data).toMatchObject({ satiety: 10, calories: 900, cost: 9999, notes: '只改备注' });

      // 3) 显式 null：清空
      const cleared = await app.inject({
        method: 'PUT',
        url: `/api/v1/records/${record.id}`,
        payload: { version: omitted.json().data.version, satiety: null, calories: null, cost: null }
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().data).toMatchObject({ satiety: null, calories: null, cost: null });

      // 4) 刷新持久化：重新 GET + 直接查库
      const read = await app.inject({ method: 'GET', url: `/api/v1/records/${record.id}` });
      expect(read.json().data).toMatchObject({ satiety: null, calories: null, cost: null });
      const row = await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.satiety).toBeNull();
      expect(row.calories).toBeNull();
      expect(row.cost).toBeNull();
      expect(row.notes).toBe('只改备注');
    });

    it('update 传入非法值时返回 400，且不改变既有值/版本', async () => {
      const record = await createRecord(database, {
        recordDate: '2061-03-13',
        mealType: 'BREAKFAST',
        sourceType: 'HOMEMADE',
        satiety: 5,
        calories: 300,
        cost: 12
      });

      for (const override of [
        { satiety: 4 },
        { satiety: '7' },
        { calories: -5 },
        { calories: 1.25 },
        { cost: 10000 }
      ]) {
        const response = await app.inject({
          method: 'PUT',
          url: `/api/v1/records/${record.id}`,
          payload: { version: record.version, ...override }
        });
        expect(response.statusCode).toBe(400);
      }

      const row = await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } });
      expect(row).toMatchObject({ satiety: 5, calories: 300, cost: 12, version: 1 });
    });

    it('服务层 update 同样校验（不能只靠 route schema）', async () => {
      const record = await createRecord(database, {
        recordDate: '2061-03-13',
        mealType: 'BREAKFAST',
        sourceType: 'HOMEMADE',
        satiety: 3
      });
      await expect(updateRecord(database, record.id, record.version, { satiety: 4 })).rejects.toMatchObject({
        statusCode: 400
      });
      await expect(updateRecord(database, record.id, record.version, { cost: -1 })).rejects.toMatchObject({
        statusCode: 400
      });
      const row = await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } });
      expect(row).toMatchObject({ satiety: 3, version: 1 });
    });
  });

  describe('饮食记录 read / list', () => {
    it('列表接口返回真实营养字段，而不是省略或默认值', async () => {
      const record = await createRecord(database, {
        recordDate: '2061-03-14',
        mealType: 'LUNCH',
        sourceType: 'DINE_IN',
        satiety: 7,
        calories: 620,
        cost: 88
      });
      const listed = await listRecords(database, { from: '2061-03-14', to: '2061-03-14' });
      const found = listed.items.find((item) => item.id === record.id);
      expect(found).toBeTruthy();
      expect(found).toMatchObject({ satiety: 7, calories: 620, cost: 88 });

      const response = await app.inject({ method: 'GET', url: '/api/v1/records?from=2061-03-14&to=2061-03-14' });
      expect(response.statusCode).toBe(200);
      const fromApi = response.json().data.items.find((item: { id: string }) => item.id === record.id);
      expect(fromApi).toMatchObject({ satiety: 7, calories: 620, cost: 88 });
    });

    it('旧记录（未写营养字段）保持 null，刷新后依然为 null', async () => {
      const legacy = await createRecord(database, {
        recordDate: '2061-03-15',
        mealType: 'SOUP',
        sourceType: 'HOMEMADE'
      });
      const first = await getRecord(database, legacy.id);
      const second = await getRecord(database, legacy.id);
      for (const row of [first, second]) {
        expect(row.satiety).toBeNull();
        expect(row.calories).toBeNull();
        expect(row.cost).toBeNull();
      }
    });

    it('计划完成生成的记录不带营养字段（null），且 planId/日期语义不受影响', async () => {
      const plan = await createPlan(database, {
        planDate: '2061-03-16',
        mealType: 'DINNER',
        dinerCount: 1,
        items: [{ itemType: 'CUSTOM', customName: `${RECIPE_PREFIX}计划餐`, mealRole: 'MAIN' }]
      });
      const completed = await completePlan(database, plan.id, plan.version);

      expect(completed.record).toMatchObject({ satiety: null, calories: null, cost: null });
      const row = await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } });
      expect(row).toMatchObject({
        satiety: null,
        calories: null,
        cost: null,
        sourceMealPlanId: plan.id,
        recordDate: '2061-03-16',
        mealType: 'DINNER'
      });

      // 幂等重放不得因为新字段被破坏
      const again = await completePlan(database, plan.id, completed.plan.version);
      expect(again.idempotent).toBe(true);
      expect(again.record.id).toBe(completed.record.id);
    });
  });

  describe('菜谱 calories 上下界', () => {
    it.each([50, 320, 2000])('create calories=%i 成功并可读回', async (calories) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/recipes',
        payload: { name: `${RECIPE_PREFIX}边界${calories}`, calories }
      });
      expect(response.statusCode).toBe(201);
      const created = response.json().data;
      expect(created.calories).toBe(calories);

      const read = await app.inject({ method: 'GET', url: `/api/v1/recipes/${created.id}` });
      expect(read.json().data.calories).toBe(calories);
    });

    it.each([
      ['下界以下 49', 49],
      ['上界以上 2001', 2001],
      ['零热量 0', 0],
      ['负数', -320],
      ['小数', 320.5],
      ['字符串 "320"', '320'],
      ['布尔', true]
    ])('create calories %s 返回 400 且不落库', async (_label, calories) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/recipes',
        payload: { name: `${RECIPE_PREFIX}非法${String(calories)}`, calories }
      });
      expect(response.statusCode).toBe(400);
      expect(await database.recipe.count({ where: { name: `${RECIPE_PREFIX}非法${String(calories)}` } })).toBe(0);
    });

    it('服务层 createRecipe 同样校验上下界', async () => {
      await expect(createRecipe(database, { name: `${RECIPE_PREFIX}服务层49`, calories: 49 })).rejects.toMatchObject({
        statusCode: 400
      });
      await expect(
        createRecipe(database, { name: `${RECIPE_PREFIX}服务层2001`, calories: 2001 })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('旧菜谱（未写 calories）保持 null，不写入默认热量', async () => {
      const legacy = await createRecipe(database, { name: `${RECIPE_PREFIX}旧菜谱` });
      expect(legacy.calories).toBeNull();
      const read = await app.inject({ method: 'GET', url: `/api/v1/recipes/${legacy.id}` });
      expect(read.json().data.calories).toBeNull();
    });

    it('update 可写入、可 null 清空，非法值 400 且不改变原值', async () => {
      const created = await createRecipe(database, { name: `${RECIPE_PREFIX}更新`, calories: 400 });

      const invalid = await app.inject({
        method: 'PUT',
        url: `/api/v1/recipes/${created.id}`,
        payload: { name: created.name, version: created.version, calories: 49 }
      });
      expect(invalid.statusCode).toBe(400);
      const untouched = await database.recipe.findUniqueOrThrow({ where: { id: created.id } });
      expect(untouched).toMatchObject({ calories: 400, version: 1 });

      const updated = await app.inject({
        method: 'PUT',
        url: `/api/v1/recipes/${created.id}`,
        payload: { name: created.name, version: created.version, calories: 2000 }
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().data.calories).toBe(2000);

      const cleared = await app.inject({
        method: 'PUT',
        url: `/api/v1/recipes/${created.id}`,
        payload: { name: created.name, version: updated.json().data.version, calories: null }
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().data.calories).toBeNull();
    });

    it('服务层 updateRecipe 也校验热量范围', async () => {
      const created = await createRecipe(database, { name: `${RECIPE_PREFIX}服务层更新`, calories: 500 });
      await expect(
        updateRecipe(database, created.id, created.version, { name: created.name, calories: 2001 })
      ).rejects.toMatchObject({ statusCode: 400 });
      const row = await database.recipe.findUniqueOrThrow({ where: { id: created.id } });
      expect(row).toMatchObject({ calories: 500, version: 1 });
    });
  });
});
