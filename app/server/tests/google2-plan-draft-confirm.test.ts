import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerCalendarRoutes } from '../src/modules/calendar/routes.js';
import { registerDashboardRoutes } from '../src/modules/dashboard/routes.js';
import { registerIngredientRoutes } from '../src/modules/ingredients/routes.js';
import { registerMealPlanRoutes } from '../src/modules/meal-plans/routes.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';
import { registerRecipeRoutes } from '../src/modules/recipes/routes.js';
import { registerStatisticsRoutes } from '../src/modules/statistics/routes.js';

/**
 * T-003-C 服务端真实路由契约：计划打卡 -> DRAFT 草稿 -> 排除未确认口径 -> 确认已用餐 -> CONFIRMED 纳入统计，
 * 且完整链路对 Ingredient / InventoryBatch / InventoryLog / ConsumptionOperation 零副作用。
 *
 * 数据隔离：使用官方测试库（TEST_DATABASE_URL，默认 data/test.db），只操作本测试自建的远期日期段
 * （2088-06-01..2088-06-30，仓库内既无计划也无记录）与当天动态选择的「无计划」餐次；所有 fixture 在 afterAll 精确清理，
 * 不整体清空任何表、不触碰其他套件已有数据。所有写入均走真实 HTTP 路由（Fastify inject），不 mock 业务 service。
 *
 * 顺序独立：每条用例的统计都用自身日期查询（2088-06-01/02/03/05 或当天），不依赖全段汇总，
 * 因此 shuffle 改变执行顺序时不会被其他用例遗留的 CONFIRMED 记录污染。
 */

const database = createTestPrismaClient();
const RANGE = { from: '2088-06-01', to: '2088-06-30' };
const INGREDIENT_PREFIX = 'T003C库存零副作用食材';
const RECIPE_PREFIX = 'T003C营养菜谱';

type Plan = { id: string; status: string; version: number; planDate: string };
type RecordDto = {
  id: string;
  status: string;
  version: number;
  confirmedAt: string | null;
  recordDate: string;
  calories: number | null;
  sourceMealPlanId: string | null;
  relatedPlanId: string | null;
  deletedAt: string | null;
};
type MealTypeValue = 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'AFTERNOON_TEA' | 'SOUP';
type CompleteData = { plan: Plan; record: RecordDto; idempotent: boolean };
type CalendarDay = {
  date: string;
  hasRecords: boolean;
  hasDrafts: boolean;
  records: Array<{ id: string; status: string }>;
};
type StatisticsData = {
  totalRecords: number;
  totalMeals: number;
  recordedDays: number;
  trend: Array<{ date: string; count: number }>;
  calorieTrend: Array<{ date: string; calories: number | null; recordedCaloriesCount: number }>;
};
type DashboardData = {
  todayRecords: Array<{ mealType: string; recorded: boolean }>;
  weeklyStats: Record<string, unknown>;
  calendarDays: Array<{ date: string; status: string }>;
};

let app: FastifyInstance;
const trackedPlanIds: string[] = [];

function buildApp(): FastifyInstance {
  const server = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
  registerErrorHandlers(server);
  void registerMealPlanRoutes(server, database);
  void registerMealRecordRoutes(server, database);
  void registerDashboardRoutes(server, database);
  void registerStatisticsRoutes(server, database);
  void registerCalendarRoutes(server, database);
  void registerIngredientRoutes(server, database);
  void registerRecipeRoutes(server, database);
  return server;
}

function businessDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function weekBounds(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: businessDate(start), end: businessDate(end) };
}

async function cleanupFixtures(): Promise<void> {
  const plans = await database.mealPlan.findMany({
    where: {
      OR: [
        { id: { in: trackedPlanIds.length ? trackedPlanIds : ['__none__'] } },
        { planDate: { gte: RANGE.from, lte: RANGE.to } }
      ]
    },
    select: { id: true }
  });
  const planIds = plans.map(({ id }) => id);
  const records = await database.mealRecord.findMany({
    where: {
      OR: [
        { sourceMealPlanId: { in: planIds.length ? planIds : ['__none__'] } },
        { recordDate: { gte: RANGE.from, lte: RANGE.to } }
      ]
    },
    select: { id: true }
  });
  const recordIds = records.map(({ id }) => id);
  const ingredients = await database.ingredient.findMany({
    where: { name: { startsWith: INGREDIENT_PREFIX } },
    select: { id: true }
  });
  const ingredientIds = ingredients.map(({ id }) => id);

  if (recordIds.length) {
    await database.mealRecordDiner.deleteMany({ where: { mealRecordId: { in: recordIds } } });
    await database.mealRecordItem.deleteMany({ where: { mealRecordId: { in: recordIds } } });
    await database.consumptionOperation.deleteMany({ where: { mealRecordId: { in: recordIds } } });
    await database.deletedItem.deleteMany({ where: { entityType: 'MealRecord', entityId: { in: recordIds } } });
    await database.inventoryLog.deleteMany({ where: { relatedRecordId: { in: recordIds } } });
    await database.mealRecord.deleteMany({ where: { id: { in: recordIds } } });
  }
  if (planIds.length) {
    await database.mealPlanDiner.deleteMany({ where: { mealPlanId: { in: planIds } } });
    await database.mealPlanItem.deleteMany({ where: { mealPlanId: { in: planIds } } });
    await database.deletedItem.deleteMany({ where: { entityType: 'MealPlan', entityId: { in: planIds } } });
    await database.inventoryLog.deleteMany({ where: { relatedPlanId: { in: planIds } } });
    await database.mealPlan.deleteMany({ where: { id: { in: planIds } } });
  }
  const recipes = await database.recipe.findMany({
    where: { name: { startsWith: RECIPE_PREFIX } },
    select: { id: true }
  });
  const recipeIds = recipes.map(({ id }) => id);
  if (recipeIds.length) {
    await database.recipeIngredient.deleteMany({ where: { recipeId: { in: recipeIds } } });
    await database.recipeStep.deleteMany({ where: { recipeId: { in: recipeIds } } });
    await database.recipeTag.deleteMany({ where: { recipeId: { in: recipeIds } } });
    await database.recipeMealType.deleteMany({ where: { recipeId: { in: recipeIds } } });
    await database.recipeMealRole.deleteMany({ where: { recipeId: { in: recipeIds } } });
    await database.recipeTool.deleteMany({ where: { recipeId: { in: recipeIds } } });
    await database.deletedItem.deleteMany({ where: { entityType: 'Recipe', entityId: { in: recipeIds } } });
    await database.recipe.deleteMany({ where: { id: { in: recipeIds } } });
  }
  if (ingredientIds.length) {
    await database.inventoryLog.deleteMany({ where: { ingredientId: { in: ingredientIds } } });
    await database.inventoryBatch.deleteMany({ where: { ingredientId: { in: ingredientIds } } });
    await database.recipeIngredient.deleteMany({ where: { ingredientId: { in: ingredientIds } } });
    await database.deletedItem.deleteMany({ where: { entityType: 'Ingredient', entityId: { in: ingredientIds } } });
    await database.ingredient.deleteMany({ where: { id: { in: ingredientIds } } });
  }
}

async function tableSnapshot(): Promise<{
  ingredients: unknown[];
  batches: unknown[];
  logs: unknown[];
  operations: unknown[];
}> {
  const rows = (table: string) =>
    database.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM "${table}" ORDER BY id`);
  const [ingredients, batches, logs, operations] = await Promise.all([
    rows('Ingredient'),
    rows('InventoryBatch'),
    rows('InventoryLog'),
    rows('ConsumptionOperation')
  ]);
  return { ingredients, batches, logs, operations };
}

async function createPlan(date: string, mealType: MealTypeValue, customName: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/plans',
    payload: { planDate: date, mealType, dinerCount: 1, items: [{ itemType: 'CUSTOM', customName }] }
  });
  expect(response.statusCode).toBe(201);
  const plan = response.json().data as Plan;
  trackedPlanIds.push(plan.id);
  return plan;
}

async function complete(plan: { id: string; version: number }) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/plans/${plan.id}/complete`,
    payload: { version: plan.version }
  });
  expect(response.statusCode).toBe(200);
  return response.json().data as CompleteData;
}

async function confirm(record: { id: string; version: number }) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/records/${record.id}/confirm`,
    payload: { version: record.version }
  });
}

async function confirmExpect(record: { id: string; version: number }, statusCode: number): Promise<RecordDto> {
  const response = await confirm(record);
  expect(response.statusCode).toBe(statusCode);
  return response.json().data as RecordDto;
}

async function records(query = ''): Promise<{ items: RecordDto[]; total: number }> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/records${query}` });
  expect(response.statusCode).toBe(200);
  return response.json().data as { items: RecordDto[]; total: number };
}

async function statistics(start: string, end: string): Promise<StatisticsData> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/statistics?start=${start}&end=${end}` });
  expect(response.statusCode).toBe(200);
  return response.json().data as StatisticsData;
}

/**
 * 当天可用餐次：优先标准三档，其次 schema 支持的额外档位（AFTERNOON_TEA / SOUP）。
 * 判定只看「该日期+餐次是否已存在 MealPlan 行（含软删除）」——MealPlan 有
 * @@unique([planDate, mealType])，软删除行仍占位，且 createPlan 遇到软删除行会复活并覆盖其 items；
 * 为不触碰其他套件的 fixture，这里直接跳过任何占位餐次。
 * 记录是否存在交给调用方用基线差值断言，不在此处依赖「当天已无记录」。
 */
async function pickMealTypeWithoutPlan(date: string): Promise<MealTypeValue> {
  const candidates: MealTypeValue[] = ['DINNER', 'LUNCH', 'BREAKFAST', 'AFTERNOON_TEA', 'SOUP'];
  for (const mealType of candidates) {
    const planTaken = await database.mealPlan.findUnique({
      where: { planDate_mealType: { planDate: date, mealType } }
    });
    if (!planTaken) return mealType;
  }
  throw new Error(
    `无法执行 H：${date} 的五个 MealType 均已有计划（含软删除占位），没有可创建计划的餐次；` +
      '不会删除其他套件的 fixture，请在本套件之外清理当天计划后再跑。'
  );
}

async function dashboard(): Promise<DashboardData> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
  expect(response.statusCode).toBe(200);
  return response.json().data as DashboardData;
}

async function calendar(start: string, end: string): Promise<{ days: CalendarDay[] }> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/calendar?start=${start}&end=${end}` });
  expect(response.statusCode).toBe(200);
  return response.json().data as { days: CalendarDay[] };
}

describe('Google2 计划打卡草稿 -> 确认已用餐 服务端真实路由契约', () => {
  beforeAll(async () => {
    await database.$connect();
    await cleanupFixtures();
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await cleanupFixtures();
    const tracked = trackedPlanIds.length ? trackedPlanIds : ['__none__'];
    // 清理证据：自建远期段与自建 fixture 全部归零（含 H 当天临时计划）
    expect(trackedPlanIds.length).toBeGreaterThan(0);
    expect(await database.mealPlan.count({ where: { id: { in: tracked } } })).toBe(0);
    expect(await database.mealRecord.count({ where: { sourceMealPlanId: { in: tracked } } })).toBe(0);
    expect(await database.mealPlan.count({ where: { planDate: { gte: RANGE.from, lte: RANGE.to } } })).toBe(0);
    expect(await database.mealRecord.count({ where: { recordDate: { gte: RANGE.from, lte: RANGE.to } } })).toBe(0);
    expect(await database.ingredient.count({ where: { name: { startsWith: INGREDIENT_PREFIX } } })).toBe(0);
    expect(await database.recipe.count({ where: { name: { startsWith: RECIPE_PREFIX } } })).toBe(0);
    await database.$disconnect();
  });

  it('A: complete 生成单条 DRAFT 草稿，records 可见而 statistics/calendar 均不纳入已确认口径', async () => {
    const plan = await createPlan('2088-06-01', 'LUNCH', 'T003C 草稿生成');
    expect(plan.status).toBe('PLANNED');

    const completed = await complete(plan);
    expect(completed.record.status).toBe('DRAFT');
    expect(completed.record.confirmedAt).toBeNull();
    expect(completed.record.sourceMealPlanId).toBe(plan.id);
    expect(completed.record.relatedPlanId).toBe(plan.id);
    expect(completed.record.recordDate).toBe('2088-06-01');
    expect(completed.idempotent).toBe(false);
    expect(await database.mealRecord.count({ where: { sourceMealPlanId: plan.id } })).toBe(1);

    // GET /records（无 status 参数，BentoService.records.reload() 所用接口）同时返回 DRAFT
    const all = await records('?from=2088-06-01&to=2088-06-01&pageSize=100');
    expect(all.items.map(({ id }) => id)).toContain(completed.record.id);
    expect(all.items.find(({ id }) => id === completed.record.id)?.status).toBe('DRAFT');

    // 月历使用的 GET /records?from&to&status=CONFIRMED 必须排除草稿
    const confirmedOnly = await records('?from=2088-06-01&to=2088-06-01&status=CONFIRMED&pageSize=100');
    expect(confirmedOnly.items.map(({ id }) => id)).not.toContain(completed.record.id);

    // 统计口径排除 DRAFT：只查本用例自身日期，避免其他用例（shuffle 任意顺序）已确认记录造成假失败
    const stats = await statistics('2088-06-01', '2088-06-01');
    expect(stats.totalRecords).toBe(0);
    expect(stats.totalMeals).toBe(0);
    expect(stats.recordedDays).toBe(0);
    expect(stats.trend).toEqual([]);
    expect(stats.calorieTrend.find(({ date }) => date === '2088-06-01')).toMatchObject({
      calories: null,
      recordedCaloriesCount: 0
    });

    // 月度日历视图（/calendar）区分草稿与已记录
    const month = await calendar(RANGE.from, RANGE.to);
    const day = month.days.find(({ date }) => date === '2088-06-01');
    expect(day?.hasDrafts).toBe(true);
    expect(day?.hasRecords).toBe(false);
  });

  it('B: confirm {version} 持久化 CONFIRMED/confirmedAt/version，幂等重复 confirm 与 complete 仍单条已确认并纳入列表/统计/日历口径', async () => {
    const plan = await createPlan('2088-06-02', 'DINNER', 'T003C 确认闭环');
    const completed = await complete(plan);
    const draft = completed.record;
    expect(draft.status).toBe('DRAFT');

    const confirmedResponse = await confirm(draft);
    expect(confirmedResponse.statusCode).toBe(200);
    const confirmed = confirmedResponse.json().data as RecordDto;
    expect(confirmed.id).toBe(draft.id);
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(new Date(confirmed.confirmedAt!).getTime()).not.toBeNaN();
    expect(confirmed.version).toBe(draft.version + 1);

    // 持久化：真实 GET 单条 + 库内落库
    const fetched = await app.inject({ method: 'GET', url: `/api/v1/records/${draft.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().data).toMatchObject({ status: 'CONFIRMED', version: draft.version + 1 });
    const row = await database.mealRecord.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.status).toBe('CONFIRMED');
    expect(row.confirmedAt).not.toBeNull();
    expect(row.version).toBe(draft.version + 1);

    // 幂等：再 confirm（仍带旧 version）返回当前记录，不重复写、不再涨版本
    const again = await confirm(draft);
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ id: draft.id, status: 'CONFIRMED', version: draft.version + 1 });
    const afterAgain = await database.mealRecord.findUniqueOrThrow({ where: { id: draft.id } });
    expect(afterAgain.version).toBe(draft.version + 1);

    // 幂等 complete：返回已确认记录，库内仍只有一条关联记录
    const planAgain = await database.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
    const completedAgain = await complete({ id: plan.id, version: planAgain.version });
    expect(completedAgain.idempotent).toBe(true);
    expect(completedAgain.record.id).toBe(draft.id);
    expect(completedAgain.record.status).toBe('CONFIRMED');
    expect(await database.mealRecord.count({ where: { sourceMealPlanId: plan.id } })).toBe(1);

    // 三查询纳入已确认记录
    const all = await records('?from=2088-06-02&to=2088-06-02&pageSize=100');
    expect(all.items.map(({ id }) => id)).toContain(draft.id);
    const confirmedOnly = await records('?from=2088-06-02&to=2088-06-02&status=CONFIRMED&pageSize=100');
    expect(confirmedOnly.items.map(({ id }) => id)).toContain(draft.id);
    const stats = await statistics('2088-06-02', '2088-06-02');
    expect(stats.totalRecords).toBe(1);
    expect(stats.totalMeals).toBe(1);
    expect(stats.recordedDays).toBe(1);
    expect(stats.trend).toEqual([{ date: '2088-06-02', count: 1 }]);
    const month = await calendar(RANGE.from, RANGE.to);
    const day = month.days.find(({ date }) => date === '2088-06-02');
    expect(day?.hasRecords).toBe(true);
    expect(day?.records.map(({ id }) => id)).toContain(draft.id);
  });

  it('C: 带真实菜谱营养与库存批次的完整链路，Ingredient/InventoryBatch/InventoryLog/ConsumptionOperation 前后全相等', async () => {
    const ingredientResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/ingredients',
      payload: {
        name: `${INGREDIENT_PREFIX}低脂鸡胸`,
        unit: 'GRAM',
        minStock: 100,
        batches: [
          { quantity: 600, unit: 'GRAM', purchaseDate: '2088-05-28', expiryDate: '2088-06-20', location: '冷藏' },
          { quantity: 400, unit: 'GRAM', purchaseDate: '2088-05-30', expiryDate: '2088-06-25', location: '冷冻' }
        ]
      }
    });
    expect(ingredientResponse.statusCode).toBe(201);
    const ingredient = ingredientResponse.json().data as { id: string; quantity: number };
    expect(ingredient.quantity).toBe(1000);

    const recipeResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/recipes',
      payload: {
        name: `${RECIPE_PREFIX}香煎鸡胸`,
        calories: 620,
        servings: 2,
        ingredients: [
          {
            ingredientId: ingredient.id,
            name: `${INGREDIENT_PREFIX}低脂鸡胸`,
            ingredientName: `${INGREDIENT_PREFIX}低脂鸡胸`,
            quantity: 200,
            unit: 'GRAM'
          }
        ],
        steps: [{ content: '双面煎至金黄' }]
      }
    });
    expect(recipeResponse.statusCode).toBe(201);
    const recipe = recipeResponse.json().data as { id: string; calories: number };
    expect(recipe.calories).toBe(620);

    const planResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      payload: {
        planDate: '2088-06-03',
        mealType: 'BREAKFAST',
        dinerCount: 2,
        items: [{ itemType: 'RECIPE', recipeId: recipe.id }]
      }
    });
    expect(planResponse.statusCode).toBe(201);
    const plan = planResponse.json().data as Plan;
    trackedPlanIds.push(plan.id);

    const before = await tableSnapshot();
    const ingredientBefore = await database.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } });
    const batchesBefore = await database.inventoryBatch.findMany({
      where: { ingredientId: ingredient.id },
      orderBy: { id: 'asc' }
    });

    const completed = await complete(plan);
    expect(completed.record.status).toBe('DRAFT');
    // 不锁定草稿 calories 的具体实现（是否回填来源热量不属于本用例契约），
    // 只验证「未确认不计入自身日期统计」，热量统计的精确口径由 E/H 覆盖。
    const statsDraft = await statistics('2088-06-03', '2088-06-03');
    expect(statsDraft.totalRecords).toBe(0);
    expect(statsDraft.totalMeals).toBe(0);
    expect(statsDraft.recordedDays).toBe(0);
    expect(statsDraft.trend).toEqual([]);
    expect(statsDraft.calorieTrend.find(({ date }) => date === '2088-06-03')).toMatchObject({
      calories: null,
      recordedCaloriesCount: 0
    });

    const confirmed = await confirmExpect(completed.record, 200);
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmedAt).not.toBeNull();
    const statsConfirmed = await statistics('2088-06-03', '2088-06-03');
    expect(statsConfirmed.totalRecords).toBe(1);
    expect(statsConfirmed.totalMeals).toBe(1);
    expect(statsConfirmed.recordedDays).toBe(1);
    expect(statsConfirmed.trend).toEqual([{ date: '2088-06-03', count: 1 }]);

    const after = await tableSnapshot();
    expect(after).toEqual(before);
    expect(await database.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).toEqual(ingredientBefore);
    expect(
      await database.inventoryBatch.findMany({ where: { ingredientId: ingredient.id }, orderBy: { id: 'asc' } })
    ).toEqual(batchesBefore);
    expect(await database.inventoryLog.count({ where: { relatedRecordId: confirmed.id } })).toBe(0);
    expect(await database.consumptionOperation.count({ where: { mealRecordId: confirmed.id } })).toBe(0);
    // 幂等 re-complete 也不产生库存副作用
    const planRow = await database.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
    await complete({ id: plan.id, version: planRow.version });
    expect(await tableSnapshot()).toEqual(before);
  });

  it('D: 已确认记录对应计划 uncomplete 返回 409 且计划/记录状态与库快照不变', async () => {
    const plan = await createPlan('2088-06-04', 'LUNCH', 'T003C 确认后撤销拦截');
    const completed = await complete(plan);
    const confirmed = await confirmExpect(completed.record, 200);

    const planRow = await database.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
    const recordRow = await database.mealRecord.findUniqueOrThrow({ where: { id: confirmed.id } });
    const inventoryBefore = await tableSnapshot();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/uncomplete`,
      payload: { version: planRow.version }
    });
    expect(response.statusCode).toBe(409);
    expect((response.json().error as { code: string }).code).toBe('CONFLICT');

    expect(await database.mealPlan.findUniqueOrThrow({ where: { id: plan.id } })).toEqual(planRow);
    expect(await database.mealRecord.findUniqueOrThrow({ where: { id: confirmed.id } })).toEqual(recordRow);
    expect(await tableSnapshot()).toEqual(inventoryBefore);
    expect(await database.deletedItem.count({ where: { entityType: 'MealRecord', entityId: confirmed.id } })).toBe(0);
  });

  it('E: DRAFT 经 PUT 编辑后仍为 DRAFT（不静默升级），计划 uncomplete 返回 409 且不改库', async () => {
    const plan = await createPlan('2088-06-05', 'DINNER', 'T003C 草稿编辑保护');
    const completed = await complete(plan);

    const edited = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${completed.record.id}`,
      payload: { version: completed.record.version, calories: 620, notes: 'T003C 真实营养热量' }
    });
    expect(edited.statusCode).toBe(200);
    const editedRecord = edited.json().data as RecordDto;
    expect(editedRecord.status).toBe('DRAFT');
    expect(editedRecord.confirmedAt).toBeNull();
    expect(editedRecord.version).toBe(completed.record.version + 1);
    expect(editedRecord.calories).toBe(620);
    expect((await database.mealRecord.findUniqueOrThrow({ where: { id: editedRecord.id } })).status).toBe('DRAFT');

    const planRow = await database.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
    const recordRow = await database.mealRecord.findUniqueOrThrow({ where: { id: editedRecord.id } });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/uncomplete`,
      payload: { version: planRow.version }
    });
    expect(response.statusCode).toBe(409);
    expect((response.json().error as { code: string }).code).toBe('CONFLICT');
    expect(await database.mealPlan.findUniqueOrThrow({ where: { id: plan.id } })).toEqual(planRow);
    expect(await database.mealRecord.findUniqueOrThrow({ where: { id: editedRecord.id } })).toEqual(recordRow);

    // 确认后统计按真实热量计入（DRAFT 期间不计）
    const statsBefore = await statistics('2088-06-05', '2088-06-05');
    expect(statsBefore.totalRecords).toBe(0);
    const confirmed = await confirmExpect(editedRecord, 200);
    expect(confirmed.status).toBe('CONFIRMED');
    const statsAfter = await statistics('2088-06-05', '2088-06-05');
    expect(statsAfter.totalRecords).toBe(1);
    expect(statsAfter.calorieTrend.find(({ date }) => date === '2088-06-05')?.calories).toBe(620);
  });

  it('F: 未编辑 DRAFT 撤销打卡后再次打卡复活同一记录 id，不产生重复记录', async () => {
    const plan = await createPlan('2088-06-06', 'LUNCH', 'T003C 复活同条草稿');
    const completed = await complete(plan);
    expect(completed.record.status).toBe('DRAFT');

    const undone = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/uncomplete`,
      payload: { version: completed.plan.version }
    });
    expect(undone.statusCode).toBe(200);
    const undoneData = undone.json().data as { plan: Plan; removedRecord: { id: string } | null; idempotent: boolean };
    expect(undoneData.plan.status).toBe('PLANNED');
    expect(undoneData.removedRecord?.id).toBe(completed.record.id);
    expect(undoneData.idempotent).toBe(false);
    expect(
      (await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } })).deletedAt
    ).not.toBeNull();

    const revived = await complete(undoneData.plan);
    expect(revived.idempotent).toBe(false);
    expect(revived.record.id).toBe(completed.record.id);
    expect(revived.record.status).toBe('DRAFT');
    expect((await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } })).deletedAt).toBeNull();
    expect(await database.mealRecord.count({ where: { sourceMealPlanId: plan.id } })).toBe(1);
  });

  it('G: 过期 version 的 confirm 返回 409 VERSION_CONFLICT 且记录与库存零变化', async () => {
    const plan = await createPlan('2088-06-07', 'DINNER', 'T003C 过期版本确认');
    const completed = await complete(plan);
    const staleVersion = completed.record.version;

    const edited = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${completed.record.id}`,
      payload: { version: staleVersion, notes: 'T003C 让版本前进' }
    });
    expect(edited.statusCode).toBe(200);
    expect((edited.json().data as RecordDto).version).toBe(staleVersion + 1);

    const recordBefore = await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } });
    const inventoryBefore = await tableSnapshot();

    const conflict = await confirm({ id: completed.record.id, version: staleVersion });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json().error as { code: string }).code).toBe('VERSION_CONFLICT');
    expect(await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } })).toEqual(recordBefore);
    expect(await tableSnapshot()).toEqual(inventoryBefore);

    // 正确版本可完成确认
    const confirmed = await confirmExpect({ id: completed.record.id, version: staleVersion + 1 }, 200);
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.version).toBe(staleVersion + 2);
  });

  it('H: 当天 DRAFT 不进入首页/统计已确认口径，确认后才计入（前后差值精确核对）', async () => {
    const today = businessDate(new Date());
    const week = weekBounds();
    // 只要求「当天该餐次没有计划」——MealPlan 有 @@unique([planDate, mealType])，同餐次无法再建计划是硬约束。
    // 不再要求「当天没有任何记录」：已有记录（其他套件或手工补录）不影响本用例，改由 dashboard/stats 基线差值断言。
    // 优先标准三档（首页 todayRecords 才有对应槽位）；三档都已有计划时回落到 schema 支持的 AFTERNOON_TEA/SOUP。
    const standardMealTypes: readonly string[] = ['BREAKFAST', 'LUNCH', 'DINNER'];
    const mealType = await pickMealTypeWithoutPlan(today);
    const dashboardSlotCovered = standardMealTypes.includes(mealType);
    const slotRecorded = (snapshot: DashboardData) =>
      snapshot.todayRecords.find((slot) => slot.mealType === mealType)?.recorded;

    const dashboardBefore = await dashboard();
    const calendarBefore = await calendar(week.start, week.end);
    const statsBefore = await statistics(today, today);
    const weeklyTotalBefore = dashboardBefore.weeklyStats.totalMeals as number;
    const todayCaloriesBefore = statsBefore.calorieTrend.find(({ date }) => date === today)?.calories ?? null;
    const todayWasRecorded = statsBefore.trend.some(({ date }) => date === today);
    const slotRecordedBefore = dashboardSlotCovered ? (slotRecorded(dashboardBefore) ?? false) : null;

    const planResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      payload: {
        planDate: today,
        mealType,
        dinerCount: 1,
        items: [{ itemType: 'CUSTOM', customName: 'T003C 当天草稿' }]
      }
    });
    expect(planResponse.statusCode).toBe(201);
    const plan = planResponse.json().data as Plan;
    trackedPlanIds.push(plan.id);

    const completed = await complete(plan);
    expect(completed.record.status).toBe('DRAFT');

    // DRAFT 前后：首页每周总餐数不变；该餐次槽位保持基线状态（原本已 recorded 也允许，差值证明草稿未新增）
    const dashboardDraft = await dashboard();
    expect(dashboardDraft.weeklyStats).toEqual(dashboardBefore.weeklyStats);
    expect(dashboardDraft.weeklyStats.totalMeals).toBe(weeklyTotalBefore);
    if (dashboardSlotCovered) expect(slotRecorded(dashboardDraft)).toBe(slotRecordedBefore);
    for (const day of dashboardDraft.calendarDays) {
      const before = dashboardBefore.calendarDays.find(({ date }) => date === day.date);
      if (!before) continue;
      if (before.status === 'recorded') expect(day.status).toBe('recorded');
      else expect(day.status).not.toBe('recorded');
    }

    const statsDraft = await statistics(today, today);
    expect(statsDraft.totalRecords).toBe(statsBefore.totalRecords);
    expect(statsDraft.totalMeals).toBe(statsBefore.totalMeals);
    expect(statsDraft.recordedDays).toBe(statsBefore.recordedDays);
    expect(statsDraft.trend).toEqual(statsBefore.trend);
    expect(statsDraft.calorieTrend.find(({ date }) => date === today)?.calories ?? null).toBe(todayCaloriesBefore);

    const calendarDraft = await calendar(week.start, week.end);
    const todayBefore = calendarBefore.days.find(({ date }) => date === today);
    const todayDraft = calendarDraft.days.find(({ date }) => date === today);
    expect(todayDraft?.hasDrafts).toBe(true);
    expect(todayDraft?.hasRecords).toBe(Boolean(todayBefore?.hasRecords));
    expect(todayDraft?.records.map(({ id }) => id)).toContain(completed.record.id);

    // 用户编辑补充真实热量后再确认：统计精确 +1 餐、+620 kcal
    const edited = await app.inject({
      method: 'PUT',
      url: `/api/v1/records/${completed.record.id}`,
      payload: { version: completed.record.version, calories: 620 }
    });
    expect(edited.statusCode).toBe(200);
    const confirmed = await confirmExpect(edited.json().data as RecordDto, 200);
    expect(confirmed.status).toBe('CONFIRMED');

    const dashboardConfirmed = await dashboard();
    // 额外档位不在首页三个槽位内，此时用每周总餐数差值证明确认已计入首页
    if (dashboardSlotCovered) expect(slotRecorded(dashboardConfirmed)).toBe(true);
    expect(dashboardConfirmed.weeklyStats.totalMeals).toBe(weeklyTotalBefore + 1);

    const statsConfirmed = await statistics(today, today);
    expect(statsConfirmed.totalRecords).toBe(statsBefore.totalRecords + 1);
    expect(statsConfirmed.totalMeals).toBe(statsBefore.totalMeals + 1);
    expect(statsConfirmed.recordedDays).toBe(statsBefore.recordedDays + (todayWasRecorded ? 0 : 1));
    const todayCaloriesAfter = statsConfirmed.calorieTrend.find(({ date }) => date === today)?.calories ?? null;
    expect(todayCaloriesAfter).toBe((todayCaloriesBefore ?? 0) + 620);

    const calendarConfirmed = await calendar(week.start, week.end);
    expect(calendarConfirmed.days.find(({ date }) => date === today)?.hasRecords).toBe(true);
  });
});
