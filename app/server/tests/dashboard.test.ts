import type { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { seedDevelopmentData } from '../src/database/seed.js';
import { createTestPrismaClient } from '../src/database/test-database.js';

function createDashboardDatabase(overrides: Record<string, unknown> = {}): PrismaClient {
  const database = {
    settings: { findUnique: vi.fn().mockResolvedValue(null) },
    recipe: { findMany: vi.fn().mockResolvedValue([]) },
    mealRecord: { findMany: vi.fn().mockResolvedValue([]) },
    mealPlan: { findMany: vi.fn().mockResolvedValue([]) },
    ingredient: { findMany: vi.fn().mockResolvedValue([]) },
    inventoryLog: { count: vi.fn().mockResolvedValue(0) },
    $disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };

  return database as unknown as PrismaClient;
}

describe('Dashboard 首页只读接口', () => {
  afterAll(() => vi.restoreAllMocks());

  it('空数据库返回稳定的空状态 DTO', async () => {
    const database = createDashboardDatabase();
    const app = await buildApp({ logger: false, database });
    const response = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
    const payload = response.json();

    await app.close();
    expect(response.statusCode).toBe(200);
    expect(payload.success).toBe(true);
    const weekQuery = (database.mealRecord.findMany as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    expect(weekQuery.where.recordDate).toMatchObject({ gte: expect.any(String), lte: expect.any(String) });
    expect(weekQuery.where.status).toBe('CONFIRMED');
    expect(payload.data).toMatchObject({
      branding: { appName: '搭饭小馆', subtitle: '让每一餐都更美好' },
      userNickname: null,
      recommendedRecipes: [],
      inventory: { totalIngredients: 0, expiringSoon: 0, insufficient: 0, expiringIngredients: [] },
      weeklyStats: { recordedDays: 0, totalMeals: 0, averageRating: null, consumedIngredientCount: 0 },
      calendarDays: expect.any(Array),
      todayRecords: expect.arrayContaining([
        expect.objectContaining({ mealType: 'BREAKFAST', recorded: false }),
        expect.objectContaining({ mealType: 'DINNER', recorded: false })
      ])
    });
  });

  it('成功 DTO 返回品牌、推荐、饮食、库存、统计和日历结构', async () => {
    const database = createDashboardDatabase({
      settings: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ appName: '搭饭小馆', subtitle: '让每一餐都更美好', userNickname: '厨房伙伴' })
      },
      recipe: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'recipe-1',
            name: '番茄炒蛋',
            imagePath: 'tomato-eggs.svg',
            cookingTimeMinutes: 15,
            tags: [{ tag: { name: '家常菜' } }],
            recordItems: [{ mealRecord: { rating: 4.6, deletedAt: null } }]
          }
        ])
      },
      mealRecord: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              mealType: 'BREAKFAST',
              recordTime: '08:00',
              sourceType: 'HOMEMADE',
              rating: 4.6,
              items: [{ customName: null, recipe: { name: '番茄炒蛋' }, store: null }]
            }
          ])
          .mockResolvedValueOnce([{ recordDate: '2026-08-06', rating: 4.6 }])
      },
      mealPlan: { findMany: vi.fn().mockResolvedValue([]) },
      ingredient: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'ingredient-1',
            name: '西兰花',
            quantity: 1,
            unit: 'PIECE',
            expiryDate: '2999-01-01',
            minStock: 2
          }
        ])
      },
      inventoryLog: { count: vi.fn().mockResolvedValue(2) }
    });
    const app = await buildApp({ logger: false, database });
    const response = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
    const payload = response.json();

    await app.close();
    expect(response.statusCode).toBe(200);
    expect(payload.data).toMatchObject({
      userNickname: '厨房伙伴',
      recommendedRecipes: [{ id: 'recipe-1', tags: ['家常菜'], rating: 4.6 }],
      weeklyStats: { totalMeals: 1, averageRating: 4.6, consumedIngredientCount: 2 },
      inventory: { totalIngredients: 1, insufficient: 1 }
    });
  });

  it('开发 Seed 重复执行不会创建重复记录', async () => {
    const database = createTestPrismaClient();
    await database.$connect();

    await seedDevelopmentData(database);
    const before = await Promise.all([
      database.recipe.count({ where: { id: { startsWith: 'dev-recipe-' } } }),
      database.ingredient.count({ where: { id: { startsWith: 'dev-ingredient-' } } }),
      database.mealRecord.count({ where: { id: { startsWith: 'dev-record-' } } })
    ]);
    await seedDevelopmentData(database);
    const after = await Promise.all([
      database.recipe.count({ where: { id: { startsWith: 'dev-recipe-' } } }),
      database.ingredient.count({ where: { id: { startsWith: 'dev-ingredient-' } } }),
      database.mealRecord.count({ where: { id: { startsWith: 'dev-record-' } } })
    ]);

    await database.$disconnect();
    expect(after).toEqual(before);
  });

  it('上传图片读取只允许 data/uploads 内的文件', async () => {
    const app = await buildApp({ logger: false, database: createDashboardDatabase() });
    const response = await app.inject({ method: 'GET', url: '/uploads/%2e%2e%2fapp.db' });

    await app.close();
    expect(response.statusCode).toBe(404);
  });
});
