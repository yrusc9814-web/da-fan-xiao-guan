import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerCalendarRoutes } from '../src/modules/calendar/routes.js';
import { registerConsumptionRoutes } from '../src/modules/consumption/routes.js';
import { registerDashboardRoutes } from '../src/modules/dashboard/routes.js';
import { registerMealPlanRoutes } from '../src/modules/meal-plans/routes.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';
import { registerStatisticsRoutes } from '../src/modules/statistics/routes.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';

/**
 * T-006B 业务逻辑收口回归（真实 HTTP + 真实 SQLite）。
 *
 * 覆盖：
 * - 日历 / 即时用餐 recordDate 严格真实日历校验（拒绝 2026-02-31、平年 02-29、13 月，不 rollover）；
 * - 首页即将过期计数为全量匹配数，预览列表仍只取 5 条；
 * - 首页推荐菜谱携带真实 category；评分为 null 时不给假星级；真 0 分保留为 0；
 * - 删除关联已确认记录后计划回退 PLANNED（事务 + 版本递增），不误改其他计划；
 * - 更新计划日期/餐次撞唯一约束返回 409，省略 dinerCount 保留原值；
 * - 统计均价分母字段：takeoutPricedRecordCount / dineInPricedRecordCount，
 *   且 takeoutRecordCount / dineInRecordCount 仍为全部条数（「共 N 顿」语义不变）。
 *
 * 数据库：createTestPrismaClient 只读 TEST_DATABASE_URL（隔离 test*.db），绝不连接 data/app.db。
 * 测试库为多文件共享，因此聚合断言走「库内独立基线比对」，并显式跟踪本文件创建的 plan/record id。
 */

const database = createTestPrismaClient();
let app: FastifyInstance;

const PREFIX = 't006b-business-';
const createdPlanIds: string[] = [];
const createdRecordIds: string[] = [];
const createdRecipeIds: string[] = [];
const createdIngredientIds: string[] = [];

function businessDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function offsetBusinessDate(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return businessDate(date);
}

async function cleanup(): Promise<void> {
  const recordIds = createdRecordIds;
  if (recordIds.length) {
    await database.mealRecordDiner.deleteMany({ where: { mealRecordId: { in: recordIds } } });
    await database.mealRecordItem.deleteMany({ where: { mealRecordId: { in: recordIds } } });
    await database.consumptionOperation.deleteMany({ where: { mealRecordId: { in: recordIds } } });
    await database.inventoryLog.deleteMany({ where: { relatedRecordId: { in: recordIds } } });
    await database.deletedItem.deleteMany({ where: { entityType: 'MealRecord', entityId: { in: recordIds } } });
    await database.mealRecord.deleteMany({ where: { id: { in: recordIds } } });
  }
  if (createdPlanIds.length) {
    await database.mealPlanDiner.deleteMany({ where: { mealPlanId: { in: createdPlanIds } } });
    await database.mealPlanItem.deleteMany({ where: { mealPlanId: { in: createdPlanIds } } });
    await database.deletedItem.deleteMany({ where: { entityType: 'MealPlan', entityId: { in: createdPlanIds } } });
    await database.mealPlan.deleteMany({ where: { id: { in: createdPlanIds } } });
  }
  if (createdRecipeIds.length) {
    await database.recipeIngredient.deleteMany({ where: { recipeId: { in: createdRecipeIds } } });
    await database.recipe.deleteMany({ where: { id: { in: createdRecipeIds } } });
  }
  if (createdIngredientIds.length) {
    await database.inventoryBatch.deleteMany({ where: { ingredientId: { in: createdIngredientIds } } });
    await database.inventoryLog.deleteMany({ where: { ingredientId: { in: createdIngredientIds } } });
    await database.ingredient.deleteMany({ where: { id: { in: createdIngredientIds } } });
  }
  createdPlanIds.length = 0;
  createdRecordIds.length = 0;
  createdRecipeIds.length = 0;
  createdIngredientIds.length = 0;
}

async function getJson<T>(url: string): Promise<{ statusCode: number; data: T; payload: any }> {
  const response = await app.inject({ method: 'GET', url });
  return { statusCode: response.statusCode, data: response.json().data as T, payload: response.json() };
}

async function createPlan(
  label: string,
  planDate: string,
  mealType: 'BREAKFAST' | 'LUNCH' | 'DINNER',
  dinerCount = 1
): Promise<{ id: string; version: number; status: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/plans',
    payload: {
      planDate,
      mealType,
      dinerCount,
      items: [{ itemType: 'CUSTOM', customName: `T006B ${label}`, sortOrder: 0 }]
    }
  });
  expect(response.statusCode).toBe(201);
  const plan = response.json().data as { id: string; version: number; status: string };
  createdPlanIds.push(plan.id);
  return plan;
}

async function createRecipe(id: string, name: string, category: string | null, createdAt?: Date): Promise<void> {
  await database.recipe.create({ data: { id, name, category, ...(createdAt ? { createdAt } : {}) } });
  createdRecipeIds.push(id);
}

async function createRecord(input: {
  id: string;
  recordDate: string;
  sourceType: 'HOMEMADE' | 'DINE_IN' | 'TAKEOUT' | 'CUSTOM';
  cost?: number | null;
  rating?: number | null;
  notes?: string | null;
  recipeId?: string;
}): Promise<void> {
  await database.mealRecord.create({
    data: {
      id: input.id,
      recordDate: input.recordDate,
      mealType: 'LUNCH',
      sourceType: input.sourceType,
      status: 'CONFIRMED',
      cost: input.cost ?? null,
      rating: input.rating ?? null,
      notes: input.notes ?? null,
      ...(input.recipeId ? { items: { create: [{ itemType: 'RECIPE', recipeId: input.recipeId, sortOrder: 0 }] } } : {})
    }
  });
  createdRecordIds.push(input.id);
}

describe('T-006B 业务逻辑收口', () => {
  beforeAll(async () => {
    await database.$connect();
    await cleanup();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerCalendarRoutes(app, database);
    await registerConsumptionRoutes(app, database);
    await registerDashboardRoutes(app, database);
    await registerMealPlanRoutes(app, database);
    await registerMealRecordRoutes(app, database);
    await registerStatisticsRoutes(app, database);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await database.$disconnect();
  });

  it('普通计划和记录同样拒绝不存在的业务日期，且不落库', async () => {
    for (const date of ['2026-02-31', '2026-02-29', '2026-13-01']) {
      const plan = await app.inject({
        method: 'POST',
        url: '/api/v1/plans',
        payload: {
          planDate: date,
          mealType: 'LUNCH',
          dinerCount: 1,
          items: [{ itemType: 'CUSTOM', customName: '日期校验' }]
        }
      });
      const record = await app.inject({
        method: 'POST',
        url: '/api/v1/records',
        payload: {
          recordDate: date,
          mealType: 'LUNCH',
          sourceType: 'CUSTOM',
          items: [{ itemType: 'CUSTOM', customName: '日期校验' }]
        }
      });
      expect(plan.statusCode).toBe(400);
      expect(record.statusCode).toBe(400);
    }
  });

  describe('日历与即时用餐的严格真实日历校验', () => {
    it('日历拒绝不存在的日历日期且不 rollover（2026-02-31 / 平年 02-29 / 13 月 / 00 日 / 开始晚于结束）', async () => {
      for (const [start, end] of [
        ['2026-02-31', '2026-03-05'],
        ['2026-02-29', '2026-03-05'],
        ['2091-02-29', '2091-03-01'],
        ['2092-13-01', '2092-13-05'],
        ['2092-00-10', '2092-00-10'],
        ['2092-04-01', '2092-03-01']
      ] as const) {
        const response = await app.inject({ method: 'GET', url: `/api/v1/calendar?start=${start}&end=${end}` });
        expect(response.statusCode, `${start} ~ ${end} 必须 400`).toBe(400);
        expect(response.json().success).toBe(false);
      }
    });

    it('日历接受真实闰日并返回该日的计划与记录', async () => {
      const plan = await createPlan('calendar', '2092-02-29', 'LUNCH');
      const recordCreate = await app.inject({
        method: 'POST',
        url: '/api/v1/records',
        payload: {
          recordDate: '2092-02-29',
          mealType: 'DINNER',
          sourceType: 'HOMEMADE',
          status: 'CONFIRMED',
          notes: `${PREFIX}calendar-record`
        }
      });
      expect(recordCreate.statusCode).toBe(201);
      const recordId = recordCreate.json().data.id as string;
      createdRecordIds.push(recordId);

      const calendar = await getJson<{
        start: string;
        end: string;
        days: Array<{ date: string; hasPlans: boolean; hasRecords: boolean; plans: unknown[]; records: unknown[] }>;
      }>('/api/v1/calendar?start=2092-02-29&end=2092-03-01');

      expect(calendar.statusCode).toBe(200);
      expect(calendar.data.start).toBe('2092-02-29');
      const leapDay = calendar.data.days.find(({ date }) => date === '2092-02-29');
      expect(leapDay).toMatchObject({ hasPlans: true, hasRecords: true });
      expect(leapDay?.plans).toEqual([expect.objectContaining({ id: plan.id, planDate: '2092-02-29' })]);
      expect(leapDay?.records).toEqual([
        expect.objectContaining({ id: recordId, recordDate: '2092-02-29', mealType: 'DINNER', status: 'CONFIRMED' })
      ]);
    });

    it('即时用餐预览与确认都拒绝非法日期，且确认失败不落库', async () => {
      const recipeId = `${PREFIX}recipe-immediate`;
      await createRecipe(recipeId, 'T006B 即食校验菜谱', null);

      const previewStatuses: Array<[string, number]> = [];
      const confirmStatuses: Array<[string, number]> = [];
      for (const recordDate of ['2026-02-31', '2026-02-29', '2026-13-01', '2026-9-1', 'abc']) {
        const preview = await app.inject({
          method: 'POST',
          url: '/api/v1/consumption/preview-from-recipe',
          payload: { recipeId, mealType: 'LUNCH', sourceType: 'HOMEMADE', recordDate }
        });
        previewStatuses.push([recordDate, preview.statusCode]);

        const confirm = await app.inject({
          method: 'POST',
          url: '/api/v1/consumption/confirm-from-recipe',
          payload: {
            recipeId,
            mealType: 'LUNCH',
            sourceType: 'HOMEMADE',
            recordDate,
            previewToken: 'x'.repeat(64),
            operationId: `${PREFIX}op-invalid-${recordDate}`,
            notes: `${PREFIX}immediate-invalid`
          }
        });
        confirmStatuses.push([recordDate, confirm.statusCode]);
      }
      // 两处状态码先收集再统一断言：预览与确认各自独立具备校验，不因前者先失败而漏测后者。
      expect(previewStatuses).toEqual(
        ['2026-02-31', '2026-02-29', '2026-13-01', '2026-9-1', 'abc'].map((date) => [date, 400])
      );
      expect(confirmStatuses).toEqual(
        ['2026-02-31', '2026-02-29', '2026-13-01', '2026-9-1', 'abc'].map((date) => [date, 400])
      );
      // 非法日期在 service 之前被拒绝：既没有记录，也没有消费操作
      expect(await database.mealRecord.count({ where: { notes: `${PREFIX}immediate-invalid` } })).toBe(0);
      expect(await database.consumptionOperation.count({ where: { id: { startsWith: `${PREFIX}op-invalid-` } } })).toBe(
        0
      );
    });

    it('即时用餐省略 recordDate 时使用本地业务日并真实落库', async () => {
      const recipeId = `${PREFIX}recipe-immediate-default`;
      await createRecipe(recipeId, 'T006B 即食默认日期菜谱', null);
      const notes = `${PREFIX}immediate-default`;
      const preview = await app.inject({
        method: 'POST',
        url: '/api/v1/consumption/preview-from-recipe',
        payload: { recipeId, mealType: 'LUNCH', sourceType: 'HOMEMADE' }
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().data.items).toEqual([]);
      const previewToken = preview.json().data.previewToken as string;

      const confirm = await app.inject({
        method: 'POST',
        url: '/api/v1/consumption/confirm-from-recipe',
        payload: {
          recipeId,
          mealType: 'LUNCH',
          sourceType: 'HOMEMADE',
          previewToken,
          operationId: `${PREFIX}op-default`,
          notes
        }
      });
      expect(confirm.statusCode).toBe(200);
      const recordId = confirm.json().data.recordId as string;
      createdRecordIds.push(recordId);
      const persisted = await database.mealRecord.findUniqueOrThrow({ where: { id: recordId } });
      expect(persisted.recordDate).toBe(businessDate(new Date()));
      expect(persisted.status).toBe('CONFIRMED');
    });
  });

  describe('首页临期全量计数与评分语义', () => {
    it('expiringSoon 为全量匹配数，预览列表只取 5 条；tip 与真实数量一致', async () => {
      const dates = [0, 1, 2, 3].map((offset) => offsetBusinessDate(offset));
      for (let index = 0; index < 7; index += 1) {
        const id = `${PREFIX}ingredient-expiring-${index}`;
        await database.ingredient.create({
          data: {
            id,
            name: `T006B 临期食材 ${index}`,
            quantity: 1,
            unit: 'PIECE',
            expiryDate: dates[index % dates.length]
          }
        });
        createdIngredientIds.push(id);
      }
      // 窗口外（已过期 / 4 天后）不计入
      for (const [suffix, offset] of [
        ['past', -1],
        ['later', 4]
      ] as const) {
        const id = `${PREFIX}ingredient-expiring-${suffix}`;
        await database.ingredient.create({
          data: {
            id,
            name: `T006B 窗口外食材 ${suffix}`,
            quantity: 1,
            unit: 'PIECE',
            expiryDate: offsetBusinessDate(offset)
          }
        });
        createdIngredientIds.push(id);
      }

      const dashboard = await getJson<{
        inventory: {
          expiringSoon: number;
          expiringIngredients: Array<{ id: string; expiryDate: string | null }>;
        };
        tip: string;
      }>('/api/v1/dashboard');
      expect(dashboard.statusCode).toBe(200);

      // 独立基线：库内全部未删除食材中，到期日落在 [今天, 今天+3] 的条数
      const ingredients = await database.ingredient.findMany({ where: { deletedAt: null } });
      const start = offsetBusinessDate(0);
      const end = offsetBusinessDate(3);
      const expected = ingredients.filter(
        (ingredient) => ingredient.expiryDate && ingredient.expiryDate >= start && ingredient.expiryDate <= end
      ).length;

      expect(expected).toBeGreaterThanOrEqual(7);
      expect(dashboard.data.inventory.expiringSoon).toBe(expected);
      expect(dashboard.data.inventory.expiringIngredients).toHaveLength(5);
      for (const item of dashboard.data.inventory.expiringIngredients) {
        expect(item.expiryDate).not.toBeNull();
        expect(item.expiryDate! >= start && item.expiryDate! <= end).toBe(true);
      }
      expect(dashboard.data.tip).toContain('优先消耗即将到期的食材');
    });

    it('推荐菜谱携带真实 category；无评分时 rating 为 null，真 0 分保留 0', async () => {
      // 取库内当前最早 createdAt，再把本轮 6 条排到它之前：无论测试库里已有什么数据，
      // 都能确定性进入 dashboard 的 take 6，不依赖 1970 这类魔法值。
      const oldest = await database.recipe.aggregate({ _min: { createdAt: true } });
      const base = (oldest._min.createdAt ?? new Date()).getTime() - 86_400_000;
      const six = [
        { id: `${PREFIX}recipe-rated-zero`, category: '暖胃炖菜', rating: 0 },
        { id: `${PREFIX}recipe-unrated`, category: '清爽时蔬', rating: null },
        { id: `${PREFIX}recipe-filler-1`, category: '快手家常', rating: null },
        { id: `${PREFIX}recipe-filler-2`, category: '鲜美水产', rating: null },
        { id: `${PREFIX}recipe-filler-3`, category: '肉禽鲜香', rating: null },
        { id: `${PREFIX}recipe-filler-4`, category: '减脂轻食', rating: null }
      ];
      for (const [index, item] of six.entries()) {
        await createRecipe(item.id, `T006B 推荐 ${index}`, item.category, new Date(base + index * 1000));
      }
      await createRecord({
        id: `${PREFIX}record-rating-zero`,
        recordDate: offsetBusinessDate(-2),
        sourceType: 'HOMEMADE',
        rating: 0,
        recipeId: `${PREFIX}recipe-rated-zero`
      });

      const dashboard = await getJson<{
        recommendedRecipes: Array<{
          id: string;
          category: string | null;
          rating: number | null;
          imagePath: string | null;
        }>;
      }>('/api/v1/dashboard');
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.data.recommendedRecipes.map(({ id }) => id)).toEqual(six.map(({ id }) => id));

      const zero = dashboard.data.recommendedRecipes.find(({ id }) => id === `${PREFIX}recipe-rated-zero`);
      expect(zero).toMatchObject({ category: '暖胃炖菜', rating: 0, imagePath: null });
      const unrated = dashboard.data.recommendedRecipes.find(({ id }) => id === `${PREFIX}recipe-unrated`);
      expect(unrated).toMatchObject({ category: '清爽时蔬', rating: null });
      for (const recipe of dashboard.data.recommendedRecipes) {
        expect(recipe).toHaveProperty('category');
        expect(recipe.category === null || typeof recipe.category === 'string').toBe(true);
      }
    });
  });

  describe('删除关联已确认记录后计划回退', () => {
    it('删除未确认草稿后也可重新打卡且保留归档事实', async () => {
      const plan = await createPlan('delete-draft', '2092-08-03', 'LUNCH');
      const completed = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${plan.id}/complete`,
        payload: { version: plan.version }
      });
      expect(completed.statusCode).toBe(200);
      const oldRecord = completed.json().data.record;
      createdRecordIds.push(oldRecord.id);
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/records/${oldRecord.id}?version=${oldRecord.version}`
      });
      expect(deleted.statusCode).toBe(200);
      const archived = await database.mealRecord.findUniqueOrThrow({ where: { id: oldRecord.id } });
      expect(archived).toMatchObject({ status: 'DRAFT', sourceMealPlanId: null, relatedPlanId: plan.id });
      expect(archived.deletedAt).not.toBeNull();
      const reverted = await database.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
      const again = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${plan.id}/complete`,
        payload: { version: reverted.version }
      });
      expect(again.statusCode).toBe(200);
      const newRecord = again.json().data.record;
      createdRecordIds.push(newRecord.id);
      expect(newRecord.id).not.toBe(archived.id);
      expect(await database.mealRecord.findUniqueOrThrow({ where: { id: archived.id } })).toEqual(archived);
    });
    it('计划回退 PLANNED 并递增版本，其他已完成计划不受影响', async () => {
      const first = await createPlan('revert-1', '2092-08-01', 'LUNCH', 2);
      const second = await createPlan('revert-2', '2092-08-02', 'DINNER', 3);

      const completeFirst = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${first.id}/complete`,
        payload: { version: first.version }
      });
      expect(completeFirst.statusCode).toBe(200);
      const firstRecord = completeFirst.json().data.record as { id: string; version: number; status: string };
      createdRecordIds.push(firstRecord.id);
      expect(firstRecord.status).toBe('DRAFT');
      const confirmFirst = await app.inject({
        method: 'POST',
        url: `/api/v1/records/${firstRecord.id}/confirm`,
        payload: { version: firstRecord.version }
      });
      expect(confirmFirst.statusCode).toBe(200);
      const confirmedFirst = confirmFirst.json().data as { id: string; version: number; status: string };

      const completeSecond = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${second.id}/complete`,
        payload: { version: second.version }
      });
      expect(completeSecond.statusCode).toBe(200);
      const secondRecord = completeSecond.json().data.record as { id: string; version: number };
      createdRecordIds.push(secondRecord.id);
      const confirmSecond = await app.inject({
        method: 'POST',
        url: `/api/v1/records/${secondRecord.id}/confirm`,
        payload: { version: secondRecord.version }
      });
      expect(confirmSecond.statusCode).toBe(200);

      const planBeforeDelete = await getJson<{ id: string; status: string; version: number }>(
        `/api/v1/plans/${first.id}`
      );
      expect(planBeforeDelete.data.status).toBe('COMPLETED');

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/records/${confirmedFirst.id}?version=${confirmedFirst.version}`
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().data).toMatchObject({ id: confirmedFirst.id, revertedPlanId: first.id });

      const reverted = await getJson<{ status: string; completedAt: string | null; version: number }>(
        `/api/v1/plans/${first.id}`
      );
      expect(reverted.data.status).toBe('PLANNED');
      expect(reverted.data.completedAt).toBeNull();
      expect(reverted.data.version).toBe(planBeforeDelete.data.version + 1);

      // 记录本身已软删除，普通读取 404；归档行保留 CONFIRMED 原状态
      const readDeleted = await app.inject({ method: 'GET', url: `/api/v1/records/${confirmedFirst.id}` });
      expect(readDeleted.statusCode).toBe(404);
      const archived = await database.mealRecord.findUniqueOrThrow({ where: { id: confirmedFirst.id } });
      expect(archived.deletedAt).not.toBeNull();
      expect(archived.status).toBe('CONFIRMED');

      // 未关联被删记录的计划保持 COMPLETED
      const untouched = await getJson<{ status: string }>(`/api/v1/plans/${second.id}`);
      expect(untouched.data.status).toBe('COMPLETED');

      // 已删除的已确认记录保持归档，重新打卡创建新草稿，旧消费不会自动重放。
      expect(archived.sourceMealPlanId).toBeNull();
      expect(archived.relatedPlanId).toBe(first.id);
      const again = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${first.id}/complete`,
        payload: { version: reverted.data.version }
      });
      expect(again.statusCode).toBe(200);
      const newRecord = again.json().data.record;
      createdRecordIds.push(newRecord.id);
      expect(newRecord.id).not.toBe(archived.id);
      expect(newRecord.status).toBe('DRAFT');
      expect(await database.mealRecord.findUniqueOrThrow({ where: { id: archived.id } })).toEqual(archived);
      expect(await database.mealRecord.count({ where: { sourceMealPlanId: first.id } })).toBe(1);
    });
  });

  describe('计划更新：唯一键冲突 409 与 dinerCount 保留', () => {
    it('更新到已被占用的日期/餐次返回 409 且不写库', async () => {
      const occupied = await createPlan('conflict-a', '2092-09-01', 'LUNCH');
      const moving = await createPlan('conflict-b', '2092-09-02', 'LUNCH');
      const before = await getJson<{ planDate: string; mealType: string; version: number }>(
        `/api/v1/plans/${moving.id}`
      );

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${moving.id}`,
        payload: { version: before.data.version, planDate: '2092-09-01', mealType: 'LUNCH' }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatchObject({ code: 'CONFLICT', message: '该日期和餐次已存在计划' });

      const after = await getJson<{ planDate: string; mealType: string; version: number }>(
        `/api/v1/plans/${moving.id}`
      );
      expect(after.data).toEqual(before.data);
      const occupiedAfter = await getJson<{ planDate: string; mealType: string }>(`/api/v1/plans/${occupied.id}`);
      expect(occupiedAfter.data).toMatchObject({ planDate: '2092-09-01', mealType: 'LUNCH' });
    });

    it('软删除计划仍占用唯一键，更新撞上时同样 409', async () => {
      const softDeleted = await createPlan('soft-deleted', '2092-09-03', 'LUNCH');
      const remove = await app.inject({
        method: 'DELETE',
        url: `/api/v1/plans/${softDeleted.id}?version=${softDeleted.version}`
      });
      expect(remove.statusCode).toBe(200);
      const moving = await createPlan('soft-target', '2092-09-04', 'LUNCH');

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${moving.id}`,
        payload: { version: moving.version, planDate: '2092-09-03', mealType: 'LUNCH' }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFLICT');
    });

    it('省略 dinerCount 时保留原值，未改动的日期/餐次不触发冲突', async () => {
      const plan = await createPlan('keep-diners', '2092-09-05', 'DINNER', 3);
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${plan.id}`,
        payload: { version: plan.version, title: 'T006B 只改标题' }
      });
      expect(response.statusCode).toBe(200);
      const updated = response.json().data as { dinerCount: number; title: string; version: number };
      expect(updated).toMatchObject({ dinerCount: 3, title: 'T006B 只改标题', version: plan.version + 1 });

      const persisted = await database.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
      expect(persisted.dinerCount).toBe(3);

      // 同组合再次提交（自身占位）应成功，不被预检误判为冲突
      const same = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${plan.id}`,
        payload: { version: updated.version, planDate: '2092-09-05', mealType: 'DINNER' }
      });
      expect(same.statusCode).toBe(200);
      expect((same.json().data as { dinerCount: number }).dinerCount).toBe(3);
    });
  });

  describe('统计均价分母字段', () => {
    it('按渠道提供有价记录数，同时保留「共 N 顿」的全量条数', async () => {
      const range = { start: '2092-07-01', end: '2092-07-02' };
      const fixtures = [
        { id: `${PREFIX}record-stat-takeout-priced`, date: '2092-07-01', sourceType: 'TAKEOUT', cost: 60 },
        { id: `${PREFIX}record-stat-takeout-null`, date: '2092-07-01', sourceType: 'TAKEOUT', cost: null },
        { id: `${PREFIX}record-stat-dinein-zero`, date: '2092-07-02', sourceType: 'DINE_IN', cost: 0 },
        { id: `${PREFIX}record-stat-dinein-null`, date: '2092-07-02', sourceType: 'DINE_IN', cost: null },
        { id: `${PREFIX}record-stat-homemade-null`, date: '2092-07-02', sourceType: 'HOMEMADE', cost: null }
      ] as const;
      for (const fixture of fixtures) {
        await createRecord({
          id: fixture.id,
          recordDate: fixture.date,
          sourceType: fixture.sourceType,
          cost: fixture.cost
        });
      }

      const statistics = await getJson<{
        costSummary: {
          totalCost: number | null;
          takeoutCost: number | null;
          dineInCost: number | null;
          homemadeCost: number | null;
          pricedRecordCount: number;
          recordCount: number;
          takeoutRecordCount: number;
          dineInRecordCount: number;
          homemadeRecordCount: number;
          takeoutPricedRecordCount: number;
          dineInPricedRecordCount: number;
          homemadePricedRecordCount: number;
          takeoutPricedCount: number;
          dineInPricedCount: number;
        };
      }>(`/api/v1/statistics?start=${range.start}&end=${range.end}`);

      expect(statistics.statusCode).toBe(200);
      const cost = statistics.data.costSummary;
      expect(cost).toMatchObject({
        totalCost: 60,
        takeoutCost: 60,
        dineInCost: 0,
        homemadeCost: null,
        pricedRecordCount: 2,
        recordCount: 5,
        // 「共 N 顿」语义：仍是全部条数（含未填金额）
        takeoutRecordCount: 2,
        dineInRecordCount: 2,
        homemadeRecordCount: 1,
        // 均价分母：只有真实填了金额的记录（真 0 计入）
        takeoutPricedRecordCount: 1,
        dineInPricedRecordCount: 1,
        homemadePricedRecordCount: 0,
        // 前端当前读取的别名必须同值，否则均价会被静默隐藏
        takeoutPricedCount: 1,
        dineInPricedCount: 1
      });
      // 均价可由后端字段直接派生：外卖 60/1=60，堂食 0/1=0（不是 null）
      expect(cost.takeoutCost! / cost.takeoutPricedRecordCount).toBe(60);
      expect(cost.dineInCost! / cost.dineInPricedRecordCount).toBe(0);
      expect(cost.takeoutPricedCount).toBe(cost.takeoutPricedRecordCount);
      expect(cost.dineInPricedCount).toBe(cost.dineInPricedRecordCount);
      // 「共 N 顿」仍按全部记录数：分母变小不能把文案改小
      expect(cost.takeoutRecordCount).toBeGreaterThan(cost.takeoutPricedRecordCount);
    });
  });
});
