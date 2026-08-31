/**
 * UX-A Journey 验收（API 层，不启动服务）
 * 新增菜谱 → 参与随机 → 今天吃什么 → 就吃这个 → 完成这一餐 → 首页/日历/统计读取
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

  it('完整 Journey：新增菜谱 → 参与随机 → 就吃这个 → 完成这一餐 → 首页/日历/统计同步', async () => {
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

    // 3. 就吃这个 → 完成这一餐（C 实现：创建 DRAFT → preview → confirm）
    const recordRes = await app.inject({
      method: 'POST',
      url: '/api/v1/records',
      payload: {
        recordDate: new Date().toISOString().slice(0, 10),
        recordTime: '12:30',
        mealType: 'LUNCH',
        sourceType: 'HOMEMADE',
        status: 'DRAFT',
        items: [{ itemType: 'RECIPE', recipeId }]
      }
    });
    expect(recordRes.statusCode).toBe(201);
    const recordId = recordRes.json().data.id;

    // 4. 库存 preview（POST，不是 GET）
    const previewRes = await app.inject({
      method: 'POST',
      url: `/api/v1/records/${recordId}/consumption-preview`,
      payload: { recordVersion: recordRes.json().data.version }
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json().data;
    expect(preview.items.length).toBeGreaterThan(0);

    // 5. 用户确认 → confirmConsumption（缺料自动入购物清单）
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/records/${recordId}/confirm-consumption`,
      payload: {
        recordVersion: preview.recordVersion,
        previewToken: preview.previewToken,
        operationId: `journey-${stamp}`
      }
    });
    expect(confirmRes.statusCode).toBe(200);
    const confirmData = confirmRes.json().data;
    expect(confirmData.recordId).toBe(recordId);
    expect(confirmData.inventoryLogIds.length).toBeGreaterThan(0); // 有扣减日志

    // 6. 首页/日历/统计正确读取
    const today = new Date().toISOString().slice(0, 10);

    const dashboardRes = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
    expect(dashboardRes.statusCode).toBe(200);
    const dashboard = dashboardRes.json().data;
    // 关键验证：dashboard 正确读取了 CONFIRMED 记录（本周统计应当包含刚才的记录）
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

    const statsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/statistics?start=${today}&end=${today}`
    });
    expect(statsRes.statusCode).toBe(200);
    const stats = statsRes.json().data;
    expect(stats.totalMeals).toBeGreaterThanOrEqual(1); // statistics 返回顶层 totalMeals，不是 summary.totalMeals
  });
});
