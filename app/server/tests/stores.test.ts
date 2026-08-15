import Fastify, { type FastifyInstance } from 'fastify';
import { MealType, RecordItemType, RecordSourceType } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerStoreRoutes } from '../src/modules/stores/routes.js';
import { listStoreCandidates } from '../src/modules/stores/service.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';

const database = createTestPrismaClient();
let app: FastifyInstance;

describe('店铺与觅食 API', () => {
  beforeAll(async () => {
    await database.$connect();
    app = Fastify({ logger: false });
    registerErrorHandlers(app);
    await registerStoreRoutes(app, database);
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it('创建完整店铺并映射餐次，支持到店/外卖、搜索、筛选和分页', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/stores',
      payload: {
        name: '节点B川味小馆',
        storeType: '餐馆',
        cuisine: '川菜',
        averageCost: 68,
        supportsDineIn: true,
        supportsTakeout: true,
        rating: 4.7,
        recommendedDishes: '水煮鱼',
        tagsText: '辣,下饭',
        favorite: true,
        mealTypes: [MealType.LUNCH, MealType.DINNER]
      }
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().data;
    expect(created.mealTypes).toEqual([MealType.DINNER, MealType.LUNCH]);
    expect(created.version).toBe(1);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/stores?mode=TAKEOUT&search=%E6%B0%B4%E7%85%AE%E9%B1%BC&cuisine=%E5%B7%9D%E8%8F%9C&minRating=4&favorite=true&mealTypes=DINNER&page=1&pageSize=10&sortBy=rating&sortOrder=desc'
    });
    expect(listResponse.statusCode).toBe(200);
    const page = listResponse.json().data;
    expect(page.items.map((store: { id: string }) => store.id)).toContain(created.id);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(10);
  });

  it('详情返回最近食用日期、历史次数和相关记录', async () => {
    const store = await database.store.create({ data: { name: '节点B历史店' } });
    await database.mealRecord.create({
      data: {
        recordDate: '2026-08-09',
        mealType: MealType.DINNER,
        sourceType: RecordSourceType.DINE_IN,
        items: { create: { itemType: RecordItemType.STORE, storeId: store.id } }
      }
    });
    await database.mealRecord.create({
      data: {
        recordDate: '2026-08-10',
        mealType: MealType.LUNCH,
        sourceType: RecordSourceType.TAKEOUT,
        items: { create: { itemType: RecordItemType.STORE, storeId: store.id } }
      }
    });

    const response = await app.inject({ method: 'GET', url: `/api/v1/stores/${store.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ lastEatenDate: '2026-08-10', historyCount: 2 });
    expect(response.json().data.relatedRecords).toHaveLength(2);
  });

  it('收藏和更新使用乐观锁，旧版本返回 409', async () => {
    const store = await database.store.create({ data: { name: '节点B收藏店' } });
    const favorite = await app.inject({
      method: 'POST',
      url: `/api/v1/stores/${store.id}/favorite`,
      payload: { favorite: true, version: 1 }
    });
    expect(favorite.statusCode).toBe(200);
    expect(favorite.json().data).toMatchObject({ favorite: true, version: 2 });

    const conflict = await app.inject({
      method: 'PUT',
      url: `/api/v1/stores/${store.id}`,
      payload: { name: '被过期更新', version: 1 }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('VERSION_CONFLICT');
    expect(conflict.json().error.details.actualVersion).toBe(2);
  });

  it('删除店铺为软删除并写入 30 天恢复记录', async () => {
    const store = await database.store.create({ data: { name: '节点B软删除店' } });
    const response = await app.inject({ method: 'DELETE', url: `/api/v1/stores/${store.id}`, payload: { version: 1 } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.version).toBe(2);

    const persisted = await database.store.findUniqueOrThrow({ where: { id: store.id } });
    const deletedItem = await database.deletedItem.findFirstOrThrow({
      where: { entityType: 'Store', entityId: store.id }
    });
    expect(persisted.deletedAt).not.toBeNull();
    expect(Math.round((deletedItem.expiresAt!.getTime() - deletedItem.deletedAt.getTime()) / 86_400_000)).toBe(30);
    expect((await app.inject({ method: 'GET', url: `/api/v1/stores/${store.id}` })).statusCode).toBe(404);
  });

  it('推荐候选执行获取方式、餐次、忌口和重复周期硬过滤', async () => {
    // 该断言依赖「系统当前日期 - repeatDays」与固定 recordDate='2026-08-11' 的先后关系：
    // recordDate 必须落在重复周期内（>= since）才会被硬过滤排除。若不固定系统时间，
    // 运行日在 2026-08-15 之后 since 会越过 2026-08-11，recent 错误进入候选而失败。
    // 用 Vitest fake timers 固定系统时间（仅伪造 Date，不干扰 Prisma 的定时器），结束即恢复。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-12T12:00:00Z'));
    try {
      const diner = await database.diner.create({ data: { name: '节点B过敏用户', allergyText: '花生' } });
      const eligible = await database.store.create({
        data: {
          name: '节点B清淡粥店',
          cuisine: '粤菜',
          supportsTakeout: true,
          favorite: true,
          rating: 4.5,
          mealTypes: { create: { mealType: MealType.BREAKFAST } }
        }
      });
      await database.store.create({
        data: {
          name: '节点B花生面店',
          recommendedDishes: '花生拌面',
          supportsTakeout: true,
          mealTypes: { create: { mealType: MealType.BREAKFAST } }
        }
      });
      const recent = await database.store.create({
        data: {
          name: '节点B最近吃过店',
          supportsTakeout: true,
          mealTypes: { create: { mealType: MealType.BREAKFAST } }
        }
      });
      await database.mealRecord.create({
        data: {
          recordDate: '2026-08-11',
          mealType: MealType.BREAKFAST,
          sourceType: RecordSourceType.TAKEOUT,
          items: { create: { itemType: RecordItemType.STORE, storeId: recent.id } }
        }
      });

      const candidates = await listStoreCandidates(database, {
        acquisitionModes: ['TAKEOUT'],
        mealTypes: [MealType.BREAKFAST],
        dinerIds: [diner.id],
        repeatDays: 3,
        wantedKeywords: ['粤菜']
      });
      expect(candidates.map((candidate) => candidate.id)).toContain(eligible.id);
      expect(candidates.map((candidate) => candidate.id)).not.toContain(recent.id);
      expect(candidates.some((candidate) => candidate.name === '节点B花生面店')).toBe(false);
      expect(candidates.find((candidate) => candidate.id === eligible.id)?.reasons).toContain('已收藏');
    } finally {
      vi.useRealTimers();
    }
  });

  it('拒绝非法评分和人均消费', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/stores',
      payload: { name: '节点B非法店', rating: 6, averageCost: -1 }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});
