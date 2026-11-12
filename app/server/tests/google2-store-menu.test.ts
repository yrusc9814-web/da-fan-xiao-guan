import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerStoreRoutes } from '../src/modules/stores/routes.js';

/**
 * Google 2.0 正式店铺菜单（StoreMenuItem）端到端契约。
 *
 * 事实来源：`谷歌2.0版本/index.html`
 *   #modalStoreForm → #formStoreMenuList → .store-dish-row
 *   （.store-dish-name / .store-dish-price[min=1 max=999] / .store-dish-sig）
 *   提交时按 DOM 顺序收集 { name, price, icon, isSignature, desc }；
 *   详情页 storeDetailMenuList 消费 { icon, name, isSignature, desc, price } 且依赖数组顺序。
 *
 * 本测试只走真实 HTTP 路由 + 真实 Prisma 持久化，不做任何 mock。
 */

const database = createTestPrismaClient();
let app: FastifyInstance;

const createdStoreIds: string[] = [];

async function inject(
  method: 'POST' | 'PUT' | 'GET' | 'DELETE',
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

async function createStore(payload: Record<string, unknown>): Promise<any> {
  const { statusCode, body } = await inject('POST', '/api/v1/stores', payload);
  expect(statusCode).toBe(201);
  createdStoreIds.push(body.data.id);
  return body.data;
}

async function menuRowsOf(storeId: string): Promise<Array<Record<string, unknown>>> {
  return database.storeMenuItem.findMany({
    where: { storeId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
  });
}

describe('Google2 店铺招牌菜单 API（真实持久化）', () => {
  beforeAll(async () => {
    await database.$connect();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerStoreRoutes(app, database);
  });

  afterAll(async () => {
    if (createdStoreIds.length) {
      await database.storeMenuItem.deleteMany({ where: { storeId: { in: createdStoreIds } } });
      await database.storeMealType.deleteMany({ where: { storeId: { in: createdStoreIds } } });
      await database.store.deleteMany({ where: { id: { in: createdStoreIds } } });
    }
    await app.close();
    await database.$disconnect();
  });

  it('create 完整保存全部菜单字段，并返回带 cuid id 的有序数组', async () => {
    const created = await createStore({
      name: '菜单契约店·完整',
      cuisine: '日式料理',
      averageCost: 35,
      menuItems: [
        { name: '招牌照烧鸡排便当', price: 32, icon: '🍱', isSignature: true, desc: '外脆里嫩，配溏心蛋' },
        { name: '温泉蛋肥牛丼饭', price: 36, icon: '🥩', isSignature: false },
        { name: '日式土豆泥沙拉', price: null, icon: '🥗', isSignature: false, desc: '手工碾碎红皮土豆' }
      ]
    });

    expect(created.menuItems).toHaveLength(3);
    expect(created.menuItems.map((item: any) => item.name)).toEqual([
      '招牌照烧鸡排便当',
      '温泉蛋肥牛丼饭',
      '日式土豆泥沙拉'
    ]);
    expect(created.menuItems.map((item: any) => item.sortOrder)).toEqual([0, 1, 2]);
    expect(created.menuItems[0]).toMatchObject({
      storeId: created.id,
      name: '招牌照烧鸡排便当',
      price: 32,
      icon: '🍱',
      isSignature: true,
      desc: '外脆里嫩，配溏心蛋',
      sortOrder: 0
    });
    // 未填写的字段保持为 null / false，绝不臆造默认值
    expect(created.menuItems[1]).toMatchObject({ price: 36, icon: '🥩', isSignature: false, desc: null });
    expect(created.menuItems[2]).toMatchObject({
      price: null,
      icon: '🥗',
      isSignature: false,
      desc: '手工碾碎红皮土豆'
    });
    for (const item of created.menuItems) {
      expect(typeof item.id).toBe('string');
      expect(item.id.length).toBeGreaterThan(0);
      expect(typeof item.createdAt).toBe('string');
      expect(typeof item.updatedAt).toBe('string');
    }

    const rows = await menuRowsOf(created.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [row.name, row.price, row.icon, row.isSignature, row.desc, row.sortOrder])).toEqual([
      ['招牌照烧鸡排便当', 32, '🍱', true, '外脆里嫩，配溏心蛋', 0],
      ['温泉蛋肥牛丼饭', 36, '🥩', false, null, 1],
      ['日式土豆泥沙拉', null, '🥗', false, '手工碾碎红皮土豆', 2]
    ]);
  });

  it('create 省略 menuItems 时菜单为空数组，父字段照常保存', async () => {
    const created = await createStore({
      name: '菜单契约店·无菜单',
      recommendedDishes: '雪菜黄鱼煨面、苏式焖肉小笼',
      rating: 4.8,
      mealTypes: ['LUNCH', 'DINNER'],
      favorite: true
    });
    expect(created.menuItems).toEqual([]);
    expect(created.recommendedDishes).toBe('雪菜黄鱼煨面、苏式焖肉小笼');
    expect(created.rating).toBe(4.8);
    expect(created.mealTypes).toEqual(['DINNER', 'LUNCH']);
    expect(await menuRowsOf(created.id)).toHaveLength(0);
  });

  it('list 与 detail 都返回按 sortOrder 升序的 menuItems，且顺序与数组下标一致', async () => {
    const created = await createStore({
      name: '菜单契约店·排序',
      menuItems: [
        { name: '第一道', price: 10, isSignature: true, desc: '一' },
        { name: '第二道', price: 20, isSignature: false, desc: '二' },
        { name: '第三道', price: 30, isSignature: true, desc: '三' }
      ]
    });

    const detail = await inject('GET', `/api/v1/stores/${created.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.data.menuItems.map((item: any) => item.name)).toEqual(['第一道', '第二道', '第三道']);
    expect(detail.body.data.menuItems.map((item: any) => item.sortOrder)).toEqual([0, 1, 2]);

    const list = await inject('GET', '/api/v1/stores?pageSize=100&sortBy=updatedAt&sortOrder=desc');
    expect(list.statusCode).toBe(200);
    const listed = list.body.data.items.find((store: any) => store.id === created.id);
    expect(listed).toBeDefined();
    expect(listed.menuItems.map((item: any) => item.name)).toEqual(['第一道', '第二道', '第三道']);

    const candidates = await inject('GET', '/api/v1/stores/candidates');
    expect(candidates.statusCode).toBe(200);
    const candidate = candidates.body.data.find((store: any) => store.id === created.id);
    expect(candidate).toBeDefined();
    expect(candidate.menuItems.map((item: any) => item.name)).toEqual(['第一道', '第二道', '第三道']);
  });

  it('update + 新建 Prisma client 仍能读到同一份菜单（真实落库而非进程内缓存）', async () => {
    const created = await createStore({
      name: '菜单契约店·持久化',
      menuItems: [{ name: '初始菜', price: 12, icon: '🍜', isSignature: true, desc: '初始' }]
    });

    const updated = await inject('PUT', `/api/v1/stores/${created.id}`, {
      version: created.version,
      menuItems: [
        { name: '改名后的甲', price: 21, icon: '🍱', isSignature: true, desc: '甲' },
        { name: '新增的乙', price: 22, icon: '🍲', isSignature: false, desc: '乙' }
      ]
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body.data.menuItems.map((item: any) => item.name)).toEqual(['改名后的甲', '新增的乙']);

    const freshClient = createTestPrismaClient();
    try {
      const rows = await freshClient.storeMenuItem.findMany({
        where: { storeId: created.id },
        orderBy: { sortOrder: 'asc' }
      });
      expect(rows.map((row) => [row.name, row.price, row.icon, row.isSignature, row.desc])).toEqual([
        ['改名后的甲', 21, '🍱', true, '甲'],
        ['新增的乙', 22, '🍲', false, '乙']
      ]);
    } finally {
      await freshClient.$disconnect();
    }

    const detail = await inject('GET', `/api/v1/stores/${created.id}`);
    expect(detail.body.data.menuItems.map((item: any) => item.name)).toEqual(['改名后的甲', '新增的乙']);
  });

  it('显式 sortOrder 生效（非数组下标时仍按 sortOrder 升序返回）', async () => {
    const created = await createStore({
      name: '菜单契约店·显式排序',
      menuItems: [
        { name: '排后', price: 20, sortOrder: 5, isSignature: false },
        { name: '排前', price: 10, sortOrder: 1, isSignature: true }
      ]
    });

    const detail = await inject('GET', `/api/v1/stores/${created.id}`);
    expect(detail.body.data.menuItems.map((item: any) => item.name)).toEqual(['排前', '排后']);
    expect(detail.body.data.menuItems.map((item: any) => item.sortOrder)).toEqual([1, 5]);

    const rows = await menuRowsOf(created.id);
    expect(rows.map((row) => [row.name, row.sortOrder])).toEqual([
      ['排前', 1],
      ['排后', 5]
    ]);
  });

  it('接受前端真实菜单行形状：多余的前端合成 id 被剥离，服务端返回真实 cuid', async () => {
    // Google 2.0 前端提交时每行自带 `id: m-${storeId}-${i}`（UI 合成值），不是后端主键。
    const created = await createStore({
      name: '菜单契约店·前端形状',
      menuItems: [
        { id: 'm-store-1-0', name: '招牌特色便当', price: 36, icon: '🍱', isSignature: true, desc: '进店招牌推荐' },
        { id: 'm-store-1-1', name: '温泉蛋厚切肥牛饭', price: 42, icon: '🍱', isSignature: true, desc: '进店招牌推荐' }
      ]
    });

    expect(created.menuItems.map((item: any) => item.name)).toEqual(['招牌特色便当', '温泉蛋厚切肥牛饭']);
    for (const item of created.menuItems) {
      expect(item.id).not.toMatch(/^m-/);
    }

    const rows = await menuRowsOf(created.id);
    expect(rows.map((row) => row.id)).toEqual(created.menuItems.map((item: any) => item.id));
    expect(rows.every((row) => typeof row.id === 'string' && row.id.length > 0)).toBe(true);
  });

  it('update 省略 menuItems 时原菜单整组保持，但父字段正常更新且版本前进', async () => {
    const created = await createStore({
      name: '菜单契约店·保留',
      menuItems: [
        { name: '保留甲', price: 11, icon: '🍱', isSignature: true, desc: '甲' },
        { name: '保留乙', price: 12, icon: '🥗', isSignature: false, desc: '乙' }
      ]
    });
    const before = await menuRowsOf(created.id);

    const updated = await inject('PUT', `/api/v1/stores/${created.id}`, {
      version: created.version,
      notes: '只改备注',
      rating: 4.2
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body.data.version).toBe(created.version + 1);
    expect(updated.body.data.notes).toBe('只改备注');
    expect(updated.body.data.rating).toBe(4.2);
    expect(updated.body.data.menuItems.map((item: any) => item.name)).toEqual(['保留甲', '保留乙']);

    const after = await menuRowsOf(created.id);
    expect(after.map((row) => [row.id, row.name, row.price, row.isSignature, row.desc, row.sortOrder])).toEqual(
      before.map((row) => [row.id, row.name, row.price, row.isSignature, row.desc, row.sortOrder])
    );
  });

  it('update 传 menuItems: [] 时清空整组菜单，不影响父字段', async () => {
    const created = await createStore({
      name: '菜单契约店·清空',
      notes: '清空前备注',
      menuItems: [{ name: '待清空', price: 15, icon: '🍱', isSignature: true, desc: '待清空' }]
    });

    const cleared = await inject('PUT', `/api/v1/stores/${created.id}`, {
      version: created.version,
      menuItems: []
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body.data.menuItems).toEqual([]);
    expect(cleared.body.data.notes).toBe('清空前备注');
    expect(await menuRowsOf(created.id)).toHaveLength(0);
  });

  it('非法菜单价格 / 空名称 / 非法排序整请求失败，父字段与菜单都不被改动', async () => {
    const created = await createStore({
      name: '菜单契约店·非法',
      notes: '原始备注',
      menuItems: [{ name: '原始菜', price: 18, icon: '🍱', isSignature: true, desc: '原始' }]
    });
    const before = await menuRowsOf(created.id);

    const invalidPayloads: Array<[string, Record<string, unknown>]> = [
      [
        '价格为 0（前端 input min=1）',
        { name: '菜单契约店·非法', notes: '被拒绝', menuItems: [{ name: '甲', price: 0 }] }
      ],
      ['价格为负数', { name: '菜单契约店·非法', notes: '被拒绝', menuItems: [{ name: '甲', price: -5 }] }],
      ['价格为小数', { name: '菜单契约店·非法', notes: '被拒绝', menuItems: [{ name: '甲', price: 12.5 }] }],
      ['价格为字符串', { name: '菜单契约店·非法', notes: '被拒绝', menuItems: [{ name: '甲', price: '36' }] }],
      ['价格超上限 1000', { name: '菜单契约店·非法', notes: '被拒绝', menuItems: [{ name: '甲', price: 1000 }] }],
      ['菜名为空白', { name: '菜单契约店·非法', notes: '被拒绝', menuItems: [{ name: '   ' }] }],
      ['菜名缺失', { name: '菜单契约店·非法', notes: '被拒绝', menuItems: [{ price: 9 }] }],
      ['菜名超长 101', { name: '菜单契约店·非法', notes: '被拒绝', menuItems: [{ name: 'x'.repeat(101) }] }],
      ['招牌标记非布尔', { name: '菜单契约店·非法', notes: '被拒绝', menuItems: [{ name: '甲', isSignature: 'yes' }] }],
      ['排序为负数', { name: '菜单契约店·非法', notes: '被拒绝', menuItems: [{ name: '甲', sortOrder: -1 }] }],
      ['排序为小数', { name: '菜单契约店·非法', notes: '被拒绝', menuItems: [{ name: '甲', sortOrder: 1.5 }] }],
      ['菜单不是数组', { name: '菜单契约店·非法', notes: '被拒绝', menuItems: 'not-an-array' }],
      ['菜单为 null', { name: '菜单契约店·非法', notes: '被拒绝', menuItems: null }],
      [
        '第二道菜非法（不得部分写入）',
        {
          name: '菜单契约店·非法',
          notes: '被拒绝',
          menuItems: [
            { name: '合法甲', price: 10 },
            { name: '非法乙', price: 'x' }
          ]
        }
      ],
      [
        '菜单超过 100 道',
        {
          name: '菜单契约店·非法',
          notes: '被拒绝',
          menuItems: Array.from({ length: 101 }, (_v, i) => ({ name: `菜${i}`, price: 10 }))
        }
      ]
    ];

    for (const [label, payload] of invalidPayloads) {
      const response = await inject('PUT', `/api/v1/stores/${created.id}`, { version: created.version, ...payload });
      expect(response.statusCode, label).toBe(400);
      expect(response.body.error.code, label).toBe('VALIDATION_ERROR');
    }

    const storeRow = await database.store.findUniqueOrThrow({ where: { id: created.id } });
    expect(storeRow.notes).toBe('原始备注');
    expect(storeRow.name).toBe('菜单契约店·非法');
    expect(storeRow.version).toBe(created.version);
    const after = await menuRowsOf(created.id);
    expect(after.map((row) => [row.id, row.name, row.price, row.isSignature, row.desc, row.sortOrder])).toEqual(
      before.map((row) => [row.id, row.name, row.price, row.isSignature, row.desc, row.sortOrder])
    );
  });

  it('过期版本更新菜单时父字段与菜单全部回滚（事务全有或全无）', async () => {
    const created = await createStore({
      name: '菜单契约店·乐观锁',
      notes: '第一次备注',
      menuItems: [{ name: '初版菜', price: 20, icon: '🍱', isSignature: false, desc: '初版' }]
    });

    const first = await inject('PUT', `/api/v1/stores/${created.id}`, {
      version: created.version,
      notes: '第二次备注',
      menuItems: [{ name: '第二次菜', price: 25, icon: '🍲', isSignature: true, desc: '第二次' }]
    });
    expect(first.statusCode).toBe(200);
    expect(first.body.data.version).toBe(created.version + 1);

    const stale = await inject('PUT', `/api/v1/stores/${created.id}`, {
      version: created.version,
      name: '过期改名',
      notes: '过期备注',
      menuItems: [{ name: '过期菜', price: 99, icon: '❌', isSignature: true, desc: '过期' }]
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    const storeRow = await database.store.findUniqueOrThrow({ where: { id: created.id } });
    expect(storeRow.name).toBe('菜单契约店·乐观锁');
    expect(storeRow.notes).toBe('第二次备注');
    expect(storeRow.version).toBe(created.version + 1);

    const rows = await menuRowsOf(created.id);
    expect(rows.map((row) => [row.name, row.price, row.icon, row.isSignature, row.desc])).toEqual([
      ['第二次菜', 25, '🍲', true, '第二次']
    ]);

    // 再次携带正确版本仍可正常整组替换
    const retry = await inject('PUT', `/api/v1/stores/${created.id}`, {
      version: created.version + 1,
      menuItems: [{ name: '重试菜', price: 30, icon: '🍜', isSignature: false, desc: '重试' }]
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.body.data.menuItems.map((item: any) => item.name)).toEqual(['重试菜']);
  });

  it('软删除店铺后菜单不可通过任何 API 读取，但已有菜单行不被级联删除', async () => {
    const created = await createStore({
      name: '菜单契约店·软删除',
      menuItems: [{ name: '删除前菜', price: 40, icon: '🍱', isSignature: true, desc: '删除前' }]
    });

    const deleted = await inject('DELETE', `/api/v1/stores/${created.id}`, { version: created.version });
    expect(deleted.statusCode).toBe(200);

    const detail = await inject('GET', `/api/v1/stores/${created.id}`);
    expect(detail.statusCode).toBe(404);

    const list = await inject('GET', '/api/v1/stores?pageSize=100');
    expect(list.body.data.items.map((store: any) => store.id)).not.toContain(created.id);

    const candidates = await inject('GET', '/api/v1/stores/candidates');
    expect(candidates.body.data.map((store: any) => store.id)).not.toContain(created.id);

    const update = await inject('PUT', `/api/v1/stores/${created.id}`, {
      version: created.version + 1,
      menuItems: [{ name: '复活菜', price: 50 }]
    });
    expect(update.statusCode).toBe(404);

    const rows = await menuRowsOf(created.id);
    expect(rows.map((row) => row.name)).toEqual(['删除前菜']);
  });

  it('菜单读写不改动店铺既有推荐菜 / 评分 / 餐次等字段', async () => {
    const created = await createStore({
      name: '菜单契约店·共存',
      cuisine: '粤式烧味',
      averageCost: 48,
      rating: 4.6,
      recommendedDishes: '烧鹅拼盘、蜜汁叉烧',
      avoidDishes: '肥肉',
      tagsText: '广式,烧味',
      notes: '老字号',
      supportsDineIn: true,
      supportsTakeout: false,
      favorite: true,
      mealTypes: ['DINNER'],
      menuItems: [{ name: '烧鹅拼盘', price: 58, icon: '🍗', isSignature: true, desc: '皮脆肉嫩' }]
    });

    const updated = await inject('PUT', `/api/v1/stores/${created.id}`, {
      version: created.version,
      menuItems: [
        { name: '烧鹅拼盘', price: 58, icon: '🍗', isSignature: true, desc: '皮脆肉嫩' },
        { name: '蜜汁叉烧饭', price: 38, icon: '🍚', isSignature: false, desc: '半肥瘦' }
      ]
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body.data).toMatchObject({
      cuisine: '粤式烧味',
      averageCost: 48,
      rating: 4.6,
      recommendedDishes: '烧鹅拼盘、蜜汁叉烧',
      avoidDishes: '肥肉',
      tagsText: '广式,烧味',
      notes: '老字号',
      supportsDineIn: true,
      supportsTakeout: false,
      favorite: true,
      mealTypes: ['DINNER']
    });
    expect(updated.body.data.menuItems).toHaveLength(2);

    const detail = await inject('GET', `/api/v1/stores/${created.id}`);
    expect(detail.body.data).toMatchObject({
      rating: 4.6,
      recommendedDishes: '烧鹅拼盘、蜜汁叉烧',
      favorite: true,
      mealTypes: ['DINNER']
    });
  });
});
