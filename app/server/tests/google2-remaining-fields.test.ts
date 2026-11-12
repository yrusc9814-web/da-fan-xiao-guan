import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerMealPlanRoutes } from '../src/modules/meal-plans/routes.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';
import { registerToolRoutes } from '../src/modules/tools/routes.js';

// Google2 第二轮剩余字段（计划 time/title/subtext/icon、厨房工具 icon）：
// - 真实保存 / 读回；null/空串=未填写，绝不注入 12:30 / 🍱 / 🍲 等默认值；
// - 更新省略保留旧值、显式 null 清空；
// - 严格 HH:MM、限长快速失败；
// - 未知字段 fail-closed；乐观锁、category/status/quantity/auth 语义不弱化。
const database = createTestPrismaClient();

const PLAN_FROM = '2044-04-01';
const PLAN_TO = '2044-04-30';
const TOOL_PREFIX = 'G2剩余字段工具';

async function cleanup(): Promise<void> {
  const records = await database.mealRecord.findMany({
    where: { recordDate: { gte: PLAN_FROM, lte: PLAN_TO } },
    select: { id: true }
  });
  const recordIds = records.map(({ id }) => id);
  await database.mealRecordDiner.deleteMany({ where: { mealRecordId: { in: recordIds } } });
  await database.mealRecordItem.deleteMany({ where: { mealRecordId: { in: recordIds } } });
  await database.mealRecord.deleteMany({ where: { id: { in: recordIds } } });
  const plans = await database.mealPlan.findMany({
    where: { planDate: { gte: PLAN_FROM, lte: PLAN_TO } },
    select: { id: true }
  });
  const planIds = plans.map(({ id }) => id);
  await database.mealPlanDiner.deleteMany({ where: { mealPlanId: { in: planIds } } });
  await database.mealPlanItem.deleteMany({ where: { mealPlanId: { in: planIds } } });
  await database.deletedItem.deleteMany({ where: { entityType: 'MealPlan', entityId: { in: planIds } } });
  await database.mealPlan.deleteMany({ where: { id: { in: planIds } } });
  await database.kitchenTool.deleteMany({ where: { name: { startsWith: TOOL_PREFIX } } });
}

const planBody = (overrides: Record<string, unknown> = {}) => ({
  planDate: '2044-04-10',
  mealType: 'DINNER',
  dinerCount: 1,
  items: [{ itemType: 'CUSTOM', customName: '剩余字段测试餐', sortOrder: 0 }],
  ...overrides
});

describe('Google2 剩余字段：计划 time/title/subtext/icon + 工具 icon', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await database.$connect();
    await cleanup();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerMealPlanRoutes(app, database);
    await registerMealRecordRoutes(app, database);
    await registerToolRoutes(app, database);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await database.$disconnect();
  });

  describe('MealPlan time/title/subtext/icon', () => {
    it('create 真实保存四个字段：响应、GET、DB 三处一致（不造假）', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/plans',
        payload: planBody({
          time: '18:30',
          title: '红烧肉配米饭',
          subtext: '自烹营养餐 · 预估 620 kcal',
          icon: '🍖'
        })
      });
      expect(response.statusCode).toBe(201);
      const created = response.json().data;
      expect(created).toMatchObject({
        time: '18:30',
        title: '红烧肉配米饭',
        subtext: '自烹营养餐 · 预估 620 kcal',
        icon: '🍖'
      });

      const read = await app.inject({ method: 'GET', url: `/api/v1/plans/${created.id}` });
      expect(read.json().data).toMatchObject({ time: '18:30', title: '红烧肉配米饭', icon: '🍖' });

      const row = await database.mealPlan.findUniqueOrThrow({ where: { id: created.id } });
      expect(row).toMatchObject({ time: '18:30', title: '红烧肉配米饭', icon: '🍖' });

      const list = await app.inject({ method: 'GET', url: `/api/v1/plans?from=${PLAN_FROM}&to=${PLAN_TO}` });
      const listed = (list.json().data as Array<{ id: string }>).find((plan) => plan.id === created.id);
      expect(listed).toMatchObject({ time: '18:30', title: '红烧肉配米饭', icon: '🍖' });
    });

    it('省略与空串都落 null：没有 12:30 / 默认标题 / 默认图标', async () => {
      const omitted = await app.inject({
        method: 'POST',
        url: '/api/v1/plans',
        payload: planBody({ planDate: '2044-04-11', mealType: 'BREAKFAST' })
      });
      expect(omitted.statusCode).toBe(201);
      expect(omitted.json().data).toMatchObject({ time: null, title: null, subtext: null, icon: null });

      const emptyStrings = await app.inject({
        method: 'POST',
        url: '/api/v1/plans',
        payload: planBody({
          planDate: '2044-04-12',
          mealType: 'LUNCH',
          time: '',
          title: '   ',
          subtext: '',
          icon: ''
        })
      });
      expect(emptyStrings.statusCode).toBe(201);
      const created = emptyStrings.json().data;
      expect(created).toMatchObject({ time: null, title: null, subtext: null, icon: null });

      const row = await database.mealPlan.findUniqueOrThrow({ where: { id: created.id } });
      expect(row).toMatchObject({ time: null, title: null, subtext: null, icon: null });
    });

    it.each([
      ['25:00 越界小时', { time: '25:00' }],
      ['9:30 非两位小时', { time: '9:30' }],
      ['18:60 越界分钟', { time: '18:60' }],
      ['纯文本时间', { time: '晚上六点' }],
      ['数字时间', { time: 1830 }],
      ['标题超 200 字', { title: '长'.repeat(201) }],
      ['副文案超 200 字', { subtext: '长'.repeat(201) }],
      ['图标超 20 字', { icon: '🍲'.repeat(21) }],
      ['图标非字符串', { icon: 123 }]
    ])('%s 返回 400 且不落库', async (_label, override) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/plans',
        payload: planBody({ planDate: '2044-04-13', mealType: 'SOUP', ...override })
      });
      expect(response.statusCode).toBe(400);
      expect(await database.mealPlan.count({ where: { planDate: '2044-04-13', mealType: 'SOUP' } })).toBe(0);
    });

    it('update：省略保留、显式 null 清空、新值覆盖，version 递增且冲突 409', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/plans',
        payload: planBody({ planDate: '2044-04-14', time: '12:30', title: '原标题', subtext: '原副文案', icon: '🍱' })
      });
      expect(created.statusCode).toBe(201);
      const plan = created.json().data;

      // 1) 省略四个字段 → 全部保留
      const omitted = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${plan.id}`,
        payload: { version: plan.version, notes: '只改备注' }
      });
      expect(omitted.statusCode).toBe(200);
      expect(omitted.json().data).toMatchObject({
        time: '12:30',
        title: '原标题',
        subtext: '原副文案',
        icon: '🍱',
        notes: '只改备注'
      });

      // 2) 覆盖为新值
      const updated = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${plan.id}`,
        payload: {
          version: omitted.json().data.version,
          time: '07:05',
          title: '新标题',
          subtext: '新副文案',
          icon: '🥘'
        }
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().data).toMatchObject({ time: '07:05', title: '新标题', subtext: '新副文案', icon: '🥘' });

      // 3) 过期 version → 409 VERSION_CONFLICT，且值不变
      const stale = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${plan.id}`,
        payload: { version: plan.version, time: '23:59' }
      });
      expect(stale.statusCode).toBe(409);
      expect((stale.json().error as { code: string }).code).toBe('VERSION_CONFLICT');

      // 4) 显式 null 清空四个字段
      const cleared = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${plan.id}`,
        payload: {
          version: updated.json().data.version,
          time: null,
          title: null,
          subtext: null,
          icon: null
        }
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().data).toMatchObject({ time: null, title: null, subtext: null, icon: null });

      const row = await database.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
      expect(row).toMatchObject({ time: null, title: null, subtext: null, icon: null, notes: '只改备注' });
    });

    it('完成 → 撤销：计划四个字段契约完整保留，uncomplete 乐观锁不弱化', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/plans',
        payload: planBody({
          planDate: '2044-04-15',
          time: '19:00',
          title: '撤销契约标题',
          subtext: '副文案',
          icon: '🍜'
        })
      });
      expect(created.statusCode).toBe(201);
      const plan = created.json().data;

      const completed = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${plan.id}/complete`,
        payload: { version: plan.version }
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json().data.plan).toMatchObject({ time: '19:00', title: '撤销契约标题', icon: '🍜' });
      expect(completed.json().data.record).toMatchObject({ photos: null, imagePath: null });

      const afterComplete = await database.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
      // 过期 version 撤销 → 409
      const stale = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${plan.id}/uncomplete`,
        payload: { version: plan.version }
      });
      expect(stale.statusCode).toBe(409);

      const undone = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${plan.id}/uncomplete`,
        payload: { version: afterComplete.version }
      });
      expect(undone.statusCode).toBe(200);
      expect(undone.json().data.plan).toMatchObject({
        time: '19:00',
        title: '撤销契约标题',
        subtext: '副文案',
        icon: '🍜'
      });
      expect(undone.json().data.plan.completedAt).toBeNull();
    });
  });

  describe('KitchenTool icon', () => {
    it('create/update/get/list 真实保存与读回 icon，省略不覆盖旧值，显式 null 清空', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/tools',
        payload: { name: `${TOOL_PREFIX}炒锅`, icon: '🍳', category: '锅具', quantity: 1, status: 'AVAILABLE' }
      });
      expect(created.statusCode).toBe(201);
      const tool = created.json().data;
      expect(tool).toMatchObject({ icon: '🍳', category: '锅具', quantity: 1, status: 'AVAILABLE' });
      expect(tool).not.toHaveProperty('photos');

      const row = await database.kitchenTool.findUniqueOrThrow({ where: { id: tool.id } });
      expect(row.icon).toBe('🍳');

      // 更新省略 icon → 保留旧值（用户已选图标不被静默清空）
      const omitted = await app.inject({
        method: 'PUT',
        url: `/api/v1/tools/${tool.id}`,
        payload: {
          version: tool.version,
          name: `${TOOL_PREFIX}炒锅`,
          category: '锅具',
          quantity: 2,
          status: 'AVAILABLE'
        }
      });
      expect(omitted.statusCode).toBe(200);
      expect(omitted.json().data).toMatchObject({ icon: '🍳', quantity: 2, version: 2 });

      // 换图标
      const updated = await app.inject({
        method: 'PUT',
        url: `/api/v1/tools/${tool.id}`,
        payload: {
          version: omitted.json().data.version,
          name: `${TOOL_PREFIX}炒锅`,
          icon: '🥘',
          category: '锅具',
          quantity: 2,
          status: 'AVAILABLE'
        }
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().data.icon).toBe('🥘');

      // 显式 null → 清空；旧值不默认成 🍲
      const cleared = await app.inject({
        method: 'PUT',
        url: `/api/v1/tools/${tool.id}`,
        payload: { version: updated.json().data.version, name: `${TOOL_PREFIX}炒锅`, icon: null }
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().data.icon).toBeNull();

      const listed = await app.inject({ method: 'GET', url: '/api/v1/tools' });
      const fromList = (listed.json().data as Array<{ id: string; icon: string | null }>).find((x) => x.id === tool.id);
      expect(fromList?.icon).toBeNull();

      const fetched = await app.inject({ method: 'GET', url: `/api/v1/tools/${tool.id}` });
      expect(fetched.json().data.icon).toBeNull();
    });

    it('创建未填 icon 时落 null（DB 与响应一致，不冒充图片路径）', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/tools',
        payload: { name: `${TOOL_PREFIX}无图标`, quantity: 1 }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().data.icon).toBeNull();
      const row = await database.kitchenTool.findUniqueOrThrow({ where: { id: created.json().data.id } });
      expect(row.icon).toBeNull();
    });

    it.each([
      ['图标超 20 字', { icon: '🍲'.repeat(21) }],
      ['图标是数字', { icon: 42 }]
    ])('%s 返回 400 且不落库', async (_label, override) => {
      const name = `${TOOL_PREFIX}非法${_label}`;
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/tools',
        payload: { name, quantity: 1, ...override }
      });
      expect(response.statusCode).toBe(400);
      expect(await database.kitchenTool.count({ where: { name } })).toBe(0);
    });

    it('未知字段 fail-closed（POST/PUT 都不静默剥离），version 与 quantity 校验不弱化', async () => {
      const unknown = await app.inject({
        method: 'POST',
        url: '/api/v1/tools',
        payload: { name: `${TOOL_PREFIX}未知字段`, quantity: 1, fakeField: 'x' }
      });
      expect(unknown.statusCode).toBe(400);
      expect(await database.kitchenTool.count({ where: { name: `${TOOL_PREFIX}未知字段` } })).toBe(0);

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/tools',
        payload: { name: `${TOOL_PREFIX}校验`, icon: '🍳', quantity: 1 }
      });
      const tool = created.json().data;

      const unknownPut = await app.inject({
        method: 'PUT',
        url: `/api/v1/tools/${tool.id}`,
        payload: { version: tool.version, name: `${TOOL_PREFIX}校验`, icon: '🍳', quantity: 1, extra: true }
      });
      expect(unknownPut.statusCode).toBe(400);

      const stringVersion = await app.inject({
        method: 'PUT',
        url: `/api/v1/tools/${tool.id}`,
        payload: { version: '1', name: `${TOOL_PREFIX}校验`, quantity: 1 }
      });
      expect(stringVersion.statusCode).toBe(400);

      const badQuantity = await app.inject({
        method: 'PUT',
        url: `/api/v1/tools/${tool.id}`,
        payload: { version: tool.version, name: `${TOOL_PREFIX}校验`, icon: '🍳', quantity: -1 }
      });
      expect(badQuantity.statusCode).toBe(400);

      const conflict = await app.inject({
        method: 'PUT',
        url: `/api/v1/tools/${tool.id}`,
        payload: { version: tool.version + 5, name: `${TOOL_PREFIX}校验`, icon: '🍳', quantity: 1 }
      });
      expect(conflict.statusCode).toBe(409);

      const row = await database.kitchenTool.findUniqueOrThrow({ where: { id: tool.id } });
      expect(row).toMatchObject({ icon: '🍳', quantity: 1, version: 1 });
    });
  });
});
