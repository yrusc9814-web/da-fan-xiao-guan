import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerDashboardRoutes } from '../src/modules/dashboard/routes.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';

/**
 * T-007-B 首页忌口硬过滤回归（真实隔离 SQLite + 真实 HTTP，无 mock）。
 *
 * 固化的事实：
 * 1) 首页推荐对全部 active 食用者的 tabooText/allergyText/dislikesText 做硬过滤，
 *    分词口径与 recommendations/inventory 相同（shared/diner-rules 的 tokens + forbidden）。
 * 2) 菜谱名称、ingredientsText、notes、食材快照 ingredientNameSnapshot 都参与命中；大小写不敏感。
 * 3) 停用食用者不参与过滤；清空忌口后菜谱恢复。
 * 4) 先过滤再取 6 条：最早创建的 6 条全被过滤时，首页仍返回 6 条合格菜谱（禁止先 take 6）。
 *
 * 数据源：createTestPrismaClient 只读 TEST_DATABASE_URL（隔离 test*.db），不碰 data/app.db。
 */

const database = createTestPrismaClient();
let app: FastifyInstance;

const PREFIX = 't007b-dashboard-taboo-';
const createdRecipeIds: string[] = [];
const createdDinerIds: string[] = [];

// 动态基线：取库内当前最早 createdAt 再往前 1 天，保证本测试菜谱排在全库 createdAt asc 最前面；
// 这样「先 take 6 再过滤」的旧实现必然把它们取进来，从而能被本测试抓到。
let baseTime = 0;

async function createRecipe(input: {
  id: string;
  name: string;
  order: number;
  ingredientsText?: string | null;
  ingredients?: string[];
}): Promise<void> {
  const id = `${PREFIX}${input.id}`;
  await database.recipe.create({
    data: {
      id,
      name: input.name,
      ingredientsText: input.ingredientsText ?? null,
      createdAt: new Date(baseTime + input.order * 1000),
      ...(input.ingredients?.length
        ? {
            ingredients: {
              create: input.ingredients.map((snapshot, index) => ({
                ingredientNameSnapshot: snapshot,
                optional: false,
                sortOrder: index
              }))
            }
          }
        : {})
    }
  });
  createdRecipeIds.push(id);
}

async function createDiner(input: {
  key: string;
  active?: boolean;
  tabooText?: string | null;
  allergyText?: string | null;
  dislikesText?: string | null;
}): Promise<void> {
  const diner = await database.diner.create({
    data: {
      name: `${PREFIX}${input.key}`,
      active: input.active ?? true,
      tabooText: input.tabooText ?? null,
      allergyText: input.allergyText ?? null,
      dislikesText: input.dislikesText ?? null
    }
  });
  createdDinerIds.push(diner.id);
}

async function cleanup(): Promise<void> {
  if (createdRecipeIds.length) {
    await database.recipeIngredient.deleteMany({ where: { recipeId: { in: createdRecipeIds } } });
    await database.recipeTag.deleteMany({ where: { recipeId: { in: createdRecipeIds } } });
    await database.recipe.deleteMany({ where: { id: { in: createdRecipeIds } } });
    createdRecipeIds.length = 0;
  }
  if (createdDinerIds.length) {
    await database.diner.deleteMany({ where: { id: { in: createdDinerIds } } });
    createdDinerIds.length = 0;
  }
}

async function dashboardRecipeIds(): Promise<string[]> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
  expect(response.statusCode).toBe(200);
  return (response.json().data.recommendedRecipes as Array<{ id: string }>).map(({ id }) => id);
}

/** 只保留本测试自己的菜谱 id，避免同库其他用例的残留菜谱干扰顺序断言。 */
function own(ids: string[]): string[] {
  return ids.filter((id) => id.startsWith(PREFIX));
}

describe('T-007B 首页推荐按活跃食用者忌口硬过滤（隔离库）', () => {
  beforeAll(async () => {
    await database.$connect();
    // 动态基线：早于库内现存最早菜谱 1 天，保证本测试菜谱在 createdAt asc 中排最前。
    const oldest = await database.recipe.aggregate({ _min: { createdAt: true } });
    baseTime = (oldest._min.createdAt ?? new Date()).getTime() - 86_400_000;
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerDashboardRoutes(app, database);
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await database.$disconnect();
  });

  it('活跃食用者三字段（忌口/过敏/不喜欢）命中名称、食材快照与食材文本，且大小写不敏感', async () => {
    await createDiner({
      key: 'active',
      tabooText: '香菜、山药',
      allergyText: '花生',
      dislikesText: 'PEANUT'
    });
    // 前 4 条全部命中，分别验证快照、名称、文本、大小写四种入口
    await createRecipe({ id: 'hit-snapshot', name: 'T007B 家常小炒', order: 0, ingredients: ['香菜'] });
    await createRecipe({ id: 'hit-name', name: 'T007B 山药炖排骨', order: 1 });
    await createRecipe({ id: 'hit-text', name: 'T007B 凉拌菜', order: 2, ingredientsText: '主料：花生 50g' });
    await createRecipe({ id: 'hit-case', name: 'T007B peanut 酥', order: 3 });
    for (let index = 0; index < 6; index += 1) {
      await createRecipe({ id: `allowed-${index}`, name: `T007B 安全菜 ${index}`, order: 4 + index });
    }

    const ids = await dashboardRecipeIds();

    expect(ids).not.toContain(`${PREFIX}hit-snapshot`);
    expect(ids).not.toContain(`${PREFIX}hit-name`);
    expect(ids).not.toContain(`${PREFIX}hit-text`);
    expect(ids).not.toContain(`${PREFIX}hit-case`);
    // 首页前 6 条里，本测试的菜谱只剩 6 条合格项（同库其他用例的菜谱不参与本断言）
    expect(own(ids)).toEqual(Array.from({ length: 6 }, (_, index) => `${PREFIX}allowed-${index}`));
  });

  it('多成员同时生效：两个活跃食用者各自字段都会过滤', async () => {
    await createDiner({ key: 'member-a', tabooText: '香菜' });
    await createDiner({ key: 'member-b', allergyText: '花生' });
    await createRecipe({ id: 'member-hit-a', name: 'T007B 香菜拌面', order: 0 });
    await createRecipe({ id: 'member-hit-b', name: 'T007B 花生糖', order: 1 });
    await createRecipe({ id: 'member-ok', name: 'T007B 清炒时蔬', order: 2 });

    const ids = await dashboardRecipeIds();

    expect(ids).not.toContain(`${PREFIX}member-hit-a`);
    expect(ids).not.toContain(`${PREFIX}member-hit-b`);
    expect(ids).toContain(`${PREFIX}member-ok`);
  });

  it('停用食用者不参与过滤；清空忌口后菜谱恢复', async () => {
    await createDiner({ key: 'inactive', active: false, tabooText: '牛奶' });
    await createRecipe({ id: 'inactive-ok', name: 'T007B 牛奶布丁', order: 0 });
    await createRecipe({ id: 'inactive-filler', name: 'T007B 白灼菜心', order: 1 });

    const whileInactive = await dashboardRecipeIds();
    expect(whileInactive).toContain(`${PREFIX}inactive-ok`);

    const diner = await database.diner.findFirstOrThrow({ where: { name: `${PREFIX}inactive` } });
    await database.diner.update({
      where: { id: diner.id },
      data: { active: true, tabooText: '牛奶' }
    });
    const afterActivate = await dashboardRecipeIds();
    expect(afterActivate).not.toContain(`${PREFIX}inactive-ok`);

    await database.diner.update({ where: { id: diner.id }, data: { tabooText: null } });
    const afterClear = await dashboardRecipeIds();
    expect(afterClear).toContain(`${PREFIX}inactive-ok`);
  });

  it('禁止先 take 6：最早 6 条全被过滤时仍返回后续 6 条合格菜谱', async () => {
    await createDiner({ key: 'bulk', tabooText: '香菜' });
    for (let index = 0; index < 6; index += 1) {
      await createRecipe({ id: `blocked-${index}`, name: `T007B 香菜料理 ${index}`, order: index });
    }
    for (let index = 0; index < 6; index += 1) {
      await createRecipe({ id: `later-${index}`, name: `T007B 合格料理 ${index}`, order: 6 + index });
    }

    const ids = await dashboardRecipeIds();

    expect(ids).toHaveLength(6);
    expect(own(ids)).toEqual(Array.from({ length: 6 }, (_, index) => `${PREFIX}later-${index}`));
  });
});
