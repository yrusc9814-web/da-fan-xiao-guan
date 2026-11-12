import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerDinerRoutes } from '../src/modules/diners/routes.js';
import { registerSettingsRoutes } from '../src/modules/settings/routes.js';
import { loadForbiddenWords, tokens } from '../src/shared/diner-rules.js';

/**
 * VAN-35 忌口能力核对（只读契约取证，隔离库）。
 *
 * 事实来源：冻结入口 `app/client/index.html`（L3009-3015）「食用者忌口偏好」行只有
 * 「修改 →」按钮，无任何编辑控件、无 diner 选择器、原版（谷歌2.0版本/index.html L3004-3007）
 * 该按钮 onclick 仅为演示 toast，全站无对应编辑 Modal。
 *
 * 本测试固化两条后端事实：
 * 1) settings 单例没有也不接受忌口字段：PUT /settings 携带 tabooText 被静默忽略（不是 400），
 *    GET /settings 的 DTO 也不含任何忌口/过敏字段——settings 不是忌口的存储位置。
 * 2) 忌口的真实存储位置是 Diner（tabooText/allergyText），经真实 HTTP CRUD 可持久化读回，
 *    且 loadForbiddenWords 会把 active 食用者的 tabooText 分词并入推荐硬过滤词表。
 *
 * 即：后端存储能力已存在（在 Diner），当前缺口是冻结 UI 无编辑控件 + 无目标 diner 选择，
 * 不是数据库缺字段。本测试不做任何写死数据或 mock，全部真实 HTTP + 真实 SQLite。
 */

const database = createTestPrismaClient();
let app: FastifyInstance;

const DINER_PREFIX = 'van35-taboo-';
const createdDinerIds: string[] = [];

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

describe('Google2 忌口能力：settings 不接受、Diner 才是真实存储（隔离库）', () => {
  beforeAll(async () => {
    await database.$connect();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerDinerRoutes(app, database);
    await registerSettingsRoutes(app, database);
  });

  afterAll(async () => {
    if (createdDinerIds.length) {
      await database.diner.deleteMany({ where: { id: { in: createdDinerIds } } });
    }
    await app.close();
    await database.$disconnect();
  });

  it('A：PUT /settings 携带 tabooText 被静默忽略，GET /settings DTO 无任何忌口字段', async () => {
    const before = (await inject('GET', '/api/v1/settings')).body.data;
    expect(before).not.toHaveProperty('tabooText');
    expect(before).not.toHaveProperty('allergyText');
    expect(before).not.toHaveProperty('dietary');
    expect(before).not.toHaveProperty('preferences');

    const put = await inject('PUT', '/api/v1/settings', {
      version: before.version,
      userNickname: before.userNickname,
      tabooText: '不吃香菜',
      allergyText: '花生'
    });
    // 静默忽略（200）而非 400：schema 未声明 additionalProperties:false，未知字段被丢弃——
    // 这是「把忌口写进 settings」此路不通时必须暴露的风险事实，不允许被当成保存成功。
    expect(put.statusCode).toBe(200);
    expect(put.body.data).not.toHaveProperty('tabooText');
    expect(put.body.data).not.toHaveProperty('allergyText');

    const row = await database.settings.findUniqueOrThrow({ where: { id: 1 } });
    expect(Object.keys(row)).not.toContain('tabooText');

    const after = (await inject('GET', '/api/v1/settings')).body.data;
    expect(after).not.toHaveProperty('tabooText');
  });

  it('B：Diner.tabooText 真实持久化读回，且进入推荐硬过滤词表（真实 HTTP）', async () => {
    const created = await inject('POST', '/api/v1/diners', {
      name: `${DINER_PREFIX}甲`,
      tabooText: '香菜、山药',
      allergyText: '花生'
    });
    expect(created.statusCode).toBe(201);
    createdDinerIds.push(created.body.data.id);
    expect(created.body.data).toMatchObject({ tabooText: '香菜、山药', allergyText: '花生' });

    const detail = await inject('GET', `/api/v1/diners/${created.body.data.id}`);
    expect(detail.body.data).toMatchObject({ tabooText: '香菜、山药' });

    const update = await inject('PUT', `/api/v1/diners/${created.body.data.id}`, {
      tabooText: '不吃香菜',
      version: created.body.data.version
    });
    expect(update.statusCode).toBe(200);
    expect(update.body.data.tabooText).toBe('不吃香菜');
    expect(update.body.data).toMatchObject({ version: created.body.data.version + 1 });

    const words = await loadForbiddenWords(database, [created.body.data.id]);
    expect(words).toEqual(expect.arrayContaining(['不吃香菜', '花生']));
    expect(words).toEqual(expect.arrayContaining(tokens(update.body.data.tabooText)));
  });

  it('C：忌口清空语义为 NULL（不写空串假数据），停用食用者不再参与硬过滤', async () => {
    const created = await inject('POST', '/api/v1/diners', { name: `${DINER_PREFIX}乙`, tabooText: '香菜' });
    createdDinerIds.push(created.body.data.id);

    const cleared = await inject('PUT', `/api/v1/diners/${created.body.data.id}`, {
      tabooText: '',
      version: created.body.data.version
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body.data.tabooText).toBeNull();

    await inject('DELETE', `/api/v1/diners/${created.body.data.id}`, { version: cleared.body.data.version });
    const words = await loadForbiddenWords(database, [created.body.data.id]);
    expect(words).toEqual([]);
  });
});
