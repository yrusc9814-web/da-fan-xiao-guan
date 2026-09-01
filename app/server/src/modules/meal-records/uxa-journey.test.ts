/**
 * UX-A Journey 验收（API 层，不启动服务）
 * 新增菜谱 → 参与随机 → 今天吃什么 → 就吃这个 → 即时用餐预览 → 确认 → 首页/日历/统计读取
 *
 * 核心变更：即时用餐不再先建 DRAFT 记录，而是通过 consumption/preview-from-recipe
 * 在服务端内存计算预览，点确认时直接创建 CONFIRMED 记录，消灭幽灵 DRAFT。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { createTestPrismaClient } from '../../database/test-database.js';
import { registerErrorHandlers } from '../../plugins/error-handler.js';
import { registerRecipeRoutes } from '../recipes/routes.js';
import { registerMealRecordRoutes } from '../meal-records/routes.js';
import { registerConsumptionRoutes } from '../consumption/routes.js';
import { registerDashboardRoutes } from '../dashboard/routes.js';
import { registerCalendarRoutes } from '../calendar/routes.js';
import { registerStatisticsRoutes } from '../statistics/routes.js';
import { registerRecommendationRoutes } from '../recommendations/routes.js';

const database = createTestPrismaClient();
const app = Fastify({ logger: false });

describe('UX-A 核心 Journey 验收', () => {
  beforeAll(async () => {
    await database.$connect();
    registerErrorHandlers(app);
    await registerRecipeRoutes(app, database);
    await registerRecommendationRoutes(app, database);
    await registerMealRecordRoutes(app, database);
    await registerConsumptionRoutes(app, database);
    await registerDashboardRoutes(app, database);
    await registerCalendarRoutes(app, database);
    await registerStatisticsRoutes(app, database);
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it('完整 Journey：新增菜谱 → 参与随机 → 就吃这个 → 即时用餐预览+确认 → 首页/日历/统计同步', async () => {
    const stamp = Date.now();
    // 1. 新增自己的菜，让它参与随机
    const tomato = await database.ingredient.create({
      data: {
        name: `Journey番茄-${stamp}`,
        unit: 'GRAM',
        quantity: 500,
        inventoryBatches: { create: { quantity: 500, unit: 'GRAM' } }
      }
    });

    const recipeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/recipes',
      payload: {
        name: `Journey番茄炒蛋-${stamp}`,
        servings: 2,
        enabledForRecommendation: true,
        mealTypes: ['LUNCH'],
        ingredients: [{ ingredientId: tomato.id, name: tomato.name, quantity: 200, unit: 'GRAM', isPrimary: true }]
      }
    });
    expect(recipeRes.statusCode).toBe(201);
    const recipeId = recipeRes.json().data.id;

    // 2. 今天吃什么：候选池包含这道菜（A 实现）
    const recRes = await app.inject({
      method: 'POST',
      url: '/api/v1/recommendations/random',
      payload: { mealType: 'LUNCH' }
    });
    expect(recRes.statusCode).toBe(200);

    // 3. 就吃这个 → 即时用餐预览（不创建任何记录）
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/preview-from-recipe',
      payload: {
        recipeId,
        mealType: 'LUNCH',
        sourceType: 'HOMEMADE',
        recordDate: new Date().toISOString().slice(0, 10),
        recordTime: '12:30'
      }
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json().data;
    expect(preview.previewToken).toBeTruthy();
    expect(preview.items.length).toBeGreaterThan(0);
    expect(preview.recipeId).toBe(recipeId);

    // 验证：此时该菜谱没有产生任何 DRAFT 记录（即时用餐不预创建）
    const myDraftsBefore = await database.mealRecord.count({
      where: { status: 'DRAFT', items: { some: { recipeId } } }
    });
    expect(myDraftsBefore).toBe(0);

    // 4. 用户确认 → 原子创建确认记录并扣减库存
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/confirm-from-recipe',
      payload: {
        recipeId,
        mealType: 'LUNCH',
        sourceType: 'HOMEMADE',
        recordDate: new Date().toISOString().slice(0, 10),
        recordTime: '12:30',
        previewToken: preview.previewToken,
        operationId: `journey-${stamp}`
      }
    });
    expect(confirmRes.statusCode).toBe(200);
    const confirmData = confirmRes.json().data;
    expect(confirmData.recordId).toBeTruthy();
    expect(confirmData.inventoryLogIds.length).toBeGreaterThan(0); // 有扣减日志

    // 验证：记录是 CONFIRMED，不是 DRAFT
    const record = await database.mealRecord.findUniqueOrThrow({ where: { id: confirmData.recordId } });
    expect(record.status).toBe('CONFIRMED');
    expect(record.confirmedAt).not.toBeNull();

    // 验证：确认后该菜谱没有任何 DRAFT 记录
    const myDraftsAfter = await database.mealRecord.count({
      where: { status: 'DRAFT', items: { some: { recipeId } } }
    });
    expect(myDraftsAfter).toBe(0);

    // 5. 首页/日历/统计正确读取
    const today = new Date().toISOString().slice(0, 10);

    const dashboardRes = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
    expect(dashboardRes.statusCode).toBe(200);
    const dashboard = dashboardRes.json().data;
    expect(dashboard).toHaveProperty('todayRecords');
    expect(dashboard).toHaveProperty('weeklyStats');
    expect(dashboard.weeklyStats.totalMeals).toBeGreaterThanOrEqual(1);
    expect(dashboard.weeklyStats.recordedDays).toBeGreaterThanOrEqual(1);

    const calendarRes = await app.inject({
      method: 'GET',
      url: `/api/v1/calendar?start=${today}&end=${today}`
    });
    expect(calendarRes.statusCode).toBe(200);
    const calendar = calendarRes.json().data;
    const todayEntry = calendar.days.find((d: { date: string }) => d.date === today);
    expect(todayEntry?.hasRecords).toBe(true);
    expect(todayEntry?.hasDrafts).toBe(false); // 无 DRAFT，不污染日历

    const statsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/statistics?start=${today}&end=${today}`
    });
    expect(statsRes.statusCode).toBe(200);
    const stats = statsRes.json().data;
    expect(stats.totalMeals).toBeGreaterThanOrEqual(1);
  });

  it('取消即时用餐：预览后不确认，数据库无 DRAFT 残留', async () => {
    const stamp = Date.now();
    const ingredient = await database.ingredient.create({
      data: {
        name: `取消测试-${stamp}`,
        unit: 'GRAM',
        quantity: 100,
        inventoryBatches: { create: { quantity: 100, unit: 'GRAM' } }
      }
    });
    const recipeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/recipes',
      payload: {
        name: `取消测试菜谱-${stamp}`,
        servings: 1,
        ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: 50, unit: 'GRAM' }]
      }
    });
    expect(recipeRes.statusCode).toBe(201);
    const recipeId = recipeRes.json().data.id;

    // 预览
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/preview-from-recipe',
      payload: { recipeId, mealType: 'LUNCH', sourceType: 'HOMEMADE' }
    });
    expect(previewRes.statusCode).toBe(200);

    // 模拟用户取消：不调用 confirm，直接验证没有该菜谱的 DRAFT 残留
    const draftCount = await database.mealRecord.count({
      where: { status: 'DRAFT', items: { some: { recipeId } } }
    });
    expect(draftCount).toBe(0);

    // 确认记录列表里也没有这条菜谱的记录
    const recordCount = await database.mealRecord.count({
      where: { items: { some: { recipeId } } }
    });
    expect(recordCount).toBe(0);
  });
});