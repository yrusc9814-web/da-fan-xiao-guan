import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createTestPrismaClient } from '../src/database/test-database.js';

const database = createTestPrismaClient();
let app: Awaited<ReturnType<typeof buildApp>>;

interface Injected {
  statusCode: number;
  json: () => {
    success: boolean;
    data: Record<string, unknown> | null;
    error: { code: string; message: string; details?: Record<string, unknown> } | null;
  };
}

// Promise.allSettled 里的 inject 若被 reject（例如连接层异常）直接抛出，避免把失败吞成 0 个 200
function unwrap(results: PromiseSettledResult<Injected>[]): Injected[] {
  return results.map((entry) => {
    if (entry.status === 'rejected') throw entry.reason;
    return entry.value;
  });
}

describe('乐观锁并发收口（Settings / Recipe Favorite）', () => {
  beforeAll(async () => {
    await database.$connect();
    app = await buildApp({ database, logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Settings', () => {
    it('两个客户端携带相同 version 并发写：恰好一个 200、一个 409，最终版本只前进一次', async () => {
      const settings = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data as Record<
        string,
        unknown
      >;
      const initialVersion = settings.version as number;

      const responses = unwrap(
        await Promise.allSettled([
          app.inject({
            method: 'PUT',
            url: '/api/v1/settings',
            payload: { version: initialVersion, appName: '客户端A', subtitle: 'A 的副标题' }
          }),
          app.inject({
            method: 'PUT',
            url: '/api/v1/settings',
            payload: { version: initialVersion, appName: '客户端B', subtitle: 'B 的副标题' }
          })
        ])
      );

      const successes = responses.filter((response) => response.statusCode === 200);
      const conflicts = responses.filter((response) => response.statusCode === 409);
      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(1);

      const conflictBody = conflicts[0]!.json();
      expect(conflictBody.error?.code).toBe('VERSION_CONFLICT');
      expect(conflictBody.error?.details).toMatchObject({
        entity: 'Settings',
        id: '1',
        expectedVersion: initialVersion,
        actualVersion: initialVersion + 1
      });

      const final = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data as Record<
        string,
        unknown
      >;
      expect(final.version).toBe(initialVersion + 1);

      // 无丢失更新：最终内容必须与胜者的写入完全一致
      const winner = successes[0]!.json().data as Record<string, unknown>;
      expect(final.appName).toBe(winner.appName);
      expect(final.subtitle).toBe(winner.subtitle);
    });

    it('增量字段语义保持：只传 appName 时其它字段不被清空', async () => {
      const before = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data as Record<
        string,
        unknown
      >;
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        payload: { version: before.version as number, appName: '增量更新' }
      });
      expect(response.statusCode).toBe(200);
      const after = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data as Record<
        string,
        unknown
      >;
      expect(after.version).toBe((before.version as number) + 1);
      expect(after.appName).toBe('增量更新');
      expect(after.subtitle).toBe(before.subtitle);
      expect(after.defaultRepeatDays).toBe(before.defaultRepeatDays);
      expect(after.autoBackupEnabled).toBe(before.autoBackupEnabled);
      expect(after.autoDeductInventory).toBe(before.autoDeductInventory);
      expect(after.onboardingCompleted).toBe(before.onboardingCompleted);
    });

    it('陈旧 version 仍然 409（非并发维度）', async () => {
      const settings = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data as Record<
        string,
        unknown
      >;
      const first = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        payload: { version: settings.version as number, appName: '第一个客户端' }
      });
      expect(first.statusCode).toBe(200);
      const stale = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        payload: { version: settings.version as number, appName: '陈旧客户端' }
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error?.code).toBe('VERSION_CONFLICT');
      expect(stale.json().error?.details).toMatchObject({
        entity: 'Settings',
        expectedVersion: settings.version,
        actualVersion: (settings.version as number) + 1
      });
    });

    it('singleton 行不存在时 version=1 仍可首次写入（保留补建语义）', async () => {
      await database.settings.deleteMany();
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        payload: { version: 1, appName: '首次启动' }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({ appName: '首次启动', version: 2 });
    });
  });

  describe('Recipe Favorite', () => {
    it('favorite=true 与 favorite=false 相同 version 并发：恰好一个 200、一个 409，无丢失更新', async () => {
      const recipe = await database.recipe.create({ data: { name: '并发收藏菜谱' } });

      const responses = unwrap(
        await Promise.allSettled([
          app.inject({
            method: 'POST',
            url: `/api/v1/recipes/${recipe.id}/favorite`,
            payload: { version: recipe.version, favorite: true }
          }),
          app.inject({
            method: 'POST',
            url: `/api/v1/recipes/${recipe.id}/favorite`,
            payload: { version: recipe.version, favorite: false }
          })
        ])
      );

      const successes = responses.filter((response) => response.statusCode === 200);
      const conflicts = responses.filter((response) => response.statusCode === 409);
      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(1);

      const conflictBody = conflicts[0]!.json();
      expect(conflictBody.error?.code).toBe('VERSION_CONFLICT');
      expect(conflictBody.error?.details).toMatchObject({
        entity: 'Recipe',
        id: recipe.id,
        expectedVersion: recipe.version,
        actualVersion: recipe.version + 1
      });

      const final = await database.recipe.findUniqueOrThrow({ where: { id: recipe.id } });
      expect(final.version).toBe(recipe.version + 1);
      // 无丢失更新：最终 favorite 必须是胜者写入的值，而不是后到者的值
      const winner = successes[0]!.json().data as Record<string, unknown>;
      expect(final.favorite).toBe(winner.favorite as boolean);
    });

    it('不存在的菜谱返回 404（与 409 区分）', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/recipes/no-such-recipe/favorite',
        payload: { version: 1, favorite: true }
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error?.message).toBe('菜谱不存在');
    });

    it('已软删除的菜谱返回 404', async () => {
      const recipe = await database.recipe.create({ data: { name: '已删除菜谱' } });
      await database.recipe.update({ where: { id: recipe.id }, data: { deletedAt: new Date() } });
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/recipes/${recipe.id}/favorite`,
        payload: { version: recipe.version, favorite: true }
      });
      expect(response.statusCode).toBe(404);
    });

    it('陈旧 version 仍然 409（非并发维度）', async () => {
      const recipe = await database.recipe.create({ data: { name: '陈旧版本菜谱' } });
      const first = await app.inject({
        method: 'POST',
        url: `/api/v1/recipes/${recipe.id}/favorite`,
        payload: { version: recipe.version, favorite: true }
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().data).toMatchObject({ favorite: true, version: recipe.version + 1 });
      const stale = await app.inject({
        method: 'POST',
        url: `/api/v1/recipes/${recipe.id}/favorite`,
        payload: { version: recipe.version, favorite: false }
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error?.code).toBe('VERSION_CONFLICT');
      const final = await database.recipe.findUniqueOrThrow({ where: { id: recipe.id } });
      expect(final.favorite).toBe(true);
    });
  });
});
