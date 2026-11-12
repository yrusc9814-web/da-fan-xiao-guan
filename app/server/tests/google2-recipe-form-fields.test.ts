import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerRecipeRoutes } from '../src/modules/recipes/routes.js';
import { createRecipe } from '../src/modules/recipes/service.js';

/**
 * Google 2.0 正式菜谱录入字段端到端契约（真实 Fastify 路由 + 真实 Prisma 持久化，无 mock）。
 *
 * 事实来源：`谷歌2.0版本/index.html`
 *   * #formRecipeCategory（select）→ 提交 category；它与 tags 是两个独立维度，互不反写；
 *   * #formRecipeIngList .recipe-ing-amount 是自由文本（"300g" / "半个" / "适量" / "2汤匙"），
 *     RecipeIngredient.quantity + unit 承载不了该原文，必须逐行原样保留（amountText）；
 *   * #formRecipeStepList 的 .recipe-step-title / .recipe-step-desc / .recipe-step-timer(min=0 max=180)
 *     是三段独立输入：content=desc、title 独立、timerMinutes 0..180（0 是真实值，null 才是未填写）。
 *
 * 语义边界：new 字段一律 nullable，省略/显式 null 都落 NULL，不写入任何推测性默认值；
 * 老 scalar 的 PUT 全量替换契约保持不变（omit → null），仅 category 例外为 omit → 保留原值。
 */

const database = createTestPrismaClient();
let app: FastifyInstance;

const RECIPE_PREFIX = 'G2菜谱字段测试';
const TAG_NAME = 'G2菜谱字段标签';
const INGREDIENT_PREFIX = 'G2菜谱字段测试·';
const createdRecipeIds: string[] = [];

async function cleanup(): Promise<void> {
  const recipes = await database.recipe.findMany({
    where: { name: { startsWith: RECIPE_PREFIX } },
    select: { id: true }
  });
  const recipeIds = [...new Set([...recipes.map(({ id }) => id), ...createdRecipeIds])];
  await database.recipeIngredient.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await database.recipeStep.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await database.recipeTag.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await database.recipeMealType.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await database.recipeMealRole.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await database.recipeTool.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await database.recipe.deleteMany({ where: { id: { in: recipeIds } } });
  await database.ingredient.deleteMany({ where: { name: { startsWith: INGREDIENT_PREFIX } } });
  const tag = await database.tag.findFirst({ where: { name: TAG_NAME } });
  if (tag) {
    await database.recipeTag.deleteMany({ where: { tagId: tag.id } });
    await database.tag.delete({ where: { id: tag.id } });
  }
}

async function inject(
  method: 'GET' | 'POST' | 'PUT',
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

async function createRecipeViaApi(payload: Record<string, unknown>): Promise<any> {
  const { statusCode, body } = await inject('POST', '/api/v1/recipes', payload);
  expect(statusCode).toBe(201);
  createdRecipeIds.push(body.data.id);
  return body.data;
}

async function countByName(name: string): Promise<number> {
  return database.recipe.count({ where: { name } });
}

function ingredientTuple(row: {
  amountText: string | null;
  quantity: number | null;
  unit: string | null;
  ingredientId: string | null;
  ingredientNameSnapshot: string;
  optional: boolean;
  isPrimary: boolean;
  sortOrder: number;
}) {
  return [
    row.ingredientNameSnapshot,
    row.amountText,
    row.quantity,
    row.unit,
    row.ingredientId,
    row.optional,
    row.isPrimary,
    row.sortOrder
  ];
}

describe('Google2 菜谱正式字段（category / amountText / step title+timer）', () => {
  beforeAll(async () => {
    await database.$connect();
    await cleanup();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerRecipeRoutes(app, database);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await database.$disconnect();
  });

  describe('create：自由用量原文逐行保留、步骤三段独立、category 与 tags 独立', () => {
    it('多行食材（半个/适量/2汤匙 + 真实 quantity/unit + ingredientId 关联）与步骤三段字段全部无损落库', async () => {
      const ingredient = await database.ingredient.create({ data: { name: `${INGREDIENT_PREFIX}洋葱` } });
      const created = await createRecipeViaApi({
        name: `${RECIPE_PREFIX}创建`,
        category: '暖胃炖菜',
        cookingTimeMinutes: 55,
        ingredients: [
          {
            ingredientId: ingredient.id,
            name: '优质紫皮洋葱',
            quantity: 0.5,
            unit: 'PIECE',
            amountText: '半个',
            optional: false,
            isPrimary: true
          },
          { name: '八角生姜', amountText: '适量', optional: true },
          { name: '蒸鱼豉油', quantity: 2, unit: 'OTHER', amountText: '2汤匙' }
        ],
        steps: [
          {
            content: '牛腩切块冷水焯水，撇净浮沫',
            title: '牛腩切块冷水焯水',
            timerMinutes: 5,
            imagePath: 'uploads/step-1.jpg'
          },
          { content: '热锅煸炒番茄出红油', title: '热锅煸炒番茄出红油', timerMinutes: 0 },
          { content: '出锅前撒葱花点缀' }
        ]
      });

      expect(created.category).toBe('暖胃炖菜');
      expect(created.ingredients.map(ingredientTuple)).toEqual([
        ['优质紫皮洋葱', '半个', 0.5, 'PIECE', ingredient.id, false, true, 0],
        ['八角生姜', '适量', null, null, null, true, false, 1],
        ['蒸鱼豉油', '2汤匙', 2, 'OTHER', null, false, false, 2]
      ]);
      // 计时 0 是真实值，不得被当成"未填写"丢弃；省略的 title/timer 是真正的 null
      expect(
        created.steps.map((step: any) => [step.stepNo, step.title, step.content, step.timerMinutes, step.imagePath])
      ).toEqual([
        [1, '牛腩切块冷水焯水', '牛腩切块冷水焯水，撇净浮沫', 5, 'uploads/step-1.jpg'],
        [2, '热锅煸炒番茄出红油', '热锅煸炒番茄出红油', 0, null],
        [3, null, '出锅前撒葱花点缀', null, null]
      ]);

      // 直接查库确认不是响应层伪装；自由用量原文不改变 quantity/unit 的既有数值语义
      const rows = await database.recipeIngredient.findMany({
        where: { recipeId: created.id },
        orderBy: { sortOrder: 'asc' }
      });
      expect(rows.map(ingredientTuple)).toEqual([
        ['优质紫皮洋葱', '半个', 0.5, 'PIECE', ingredient.id, false, true, 0],
        ['八角生姜', '适量', null, null, null, true, false, 1],
        ['蒸鱼豉油', '2汤匙', 2, 'OTHER', null, false, false, 2]
      ]);
      const steps = await database.recipeStep.findMany({ where: { recipeId: created.id }, orderBy: { stepNo: 'asc' } });
      expect(steps.map((step) => [step.title, step.timerMinutes, step.imagePath])).toEqual([
        ['牛腩切块冷水焯水', 5, 'uploads/step-1.jpg'],
        ['热锅煸炒番茄出红油', 0, null],
        [null, null, null]
      ]);
    });

    it('category 不写入 tags、不清除 tags，两者可同时存在', async () => {
      const created = await createRecipeViaApi({
        name: `${RECIPE_PREFIX}分类独立`,
        category: '粤式烧味',
        tags: [TAG_NAME]
      });
      const tagNamesOf = (recipe: any) => recipe.tags.map((item: { tag: { name: string } }) => item.tag.name);
      expect(created.category).toBe('粤式烧味');
      // 既有契约：tags 是关系数组（{tag:{...}}），category 不得篡改它
      expect(tagNamesOf(created)).toEqual([TAG_NAME]);
      // category 绝不自动建档成 GENERAL tag
      expect(await database.tag.findFirst({ where: { name: '粤式烧味' } })).toBeNull();

      const detail = await inject('GET', `/api/v1/recipes/${created.id}`);
      expect(detail.body.data.category).toBe('粤式烧味');
      expect(tagNamesOf(detail.body.data)).toEqual([TAG_NAME]);
      const row = await database.recipe.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.category).toBe('粤式烧味');
    });

    it('legacy body（不含新字段）落库为新字段全 null，不做任何默认填充', async () => {
      const created = await createRecipeViaApi({
        name: `${RECIPE_PREFIX}旧请求`,
        ingredients: [{ name: '牛腩', quantity: 500, unit: 'GRAM' }],
        steps: [{ content: '按老客户端格式提交' }]
      });
      expect(created.category).toBeNull();
      expect(created.ingredients[0]).toMatchObject({ amountText: null, quantity: 500, unit: 'GRAM' });
      expect(created.steps[0]).toMatchObject({ title: null, timerMinutes: null });

      const row = await database.recipe.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.category).toBeNull();
    });
  });

  describe('读取：fresh Prisma + GET detail/list 均返回新字段', () => {
    it('新建 Prisma client 读同一测试库，GET detail 与 list 都返回新字段', async () => {
      const created = await createRecipeViaApi({
        name: `${RECIPE_PREFIX}往返`,
        category: '快手家常',
        ingredients: [{ name: '香葱', amountText: '1把' }],
        steps: [{ content: '翻炒出锅', title: '大火快炒', timerMinutes: 3 }]
      });

      const fresh = createTestPrismaClient();
      try {
        const freshRow = await fresh.recipe.findUniqueOrThrow({
          where: { id: created.id },
          include: { ingredients: true, steps: true }
        });
        expect(freshRow.category).toBe('快手家常');
        expect(freshRow.ingredients[0].amountText).toBe('1把');
        expect([freshRow.steps[0].title, freshRow.steps[0].timerMinutes]).toEqual(['大火快炒', 3]);
      } finally {
        await fresh.$disconnect();
      }

      const detail = await inject('GET', `/api/v1/recipes/${created.id}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.body.data).toMatchObject({ category: '快手家常' });
      expect(detail.body.data.ingredients[0]).toMatchObject({ amountText: '1把' });
      expect(detail.body.data.steps[0]).toMatchObject({ title: '大火快炒', timerMinutes: 3 });

      const list = await inject('GET', `/api/v1/recipes?search=${encodeURIComponent(`${RECIPE_PREFIX}往返`)}`);
      expect(list.statusCode).toBe(200);
      const listed = list.body.data.items.find((item: any) => item.id === created.id);
      expect(listed).toBeTruthy();
      expect(listed.category).toBe('快手家常');
      expect(listed.ingredients[0].amountText).toBe('1把');
      expect(listed.steps[0].title).toBe('大火快炒');
    });

    it('list/detail 对 legacy 菜谱也返回显式的 null 新字段', async () => {
      const created = await createRecipeViaApi({
        name: `${RECIPE_PREFIX}旧菜谱读取`,
        ingredients: [{ name: '牛腩' }],
        steps: [{ content: '老数据步骤' }]
      });

      const detail = await inject('GET', `/api/v1/recipes/${created.id}`);
      expect(detail.body.data.category).toBeNull();
      expect(detail.body.data.ingredients[0].amountText).toBeNull();
      expect(detail.body.data.steps[0]).toMatchObject({ title: null, timerMinutes: null });

      const list = await inject('GET', `/api/v1/recipes?search=${encodeURIComponent(`${RECIPE_PREFIX}旧菜谱读取`)}`);
      const listed = list.body.data.items.find((item: any) => item.id === created.id);
      expect(listed.category).toBeNull();
      expect(listed.ingredients[0].amountText).toBeNull();
      expect(listed.steps[0]).toMatchObject({ title: null, timerMinutes: null });
    });
  });

  describe('update：改值 / 改顺序 / null 清空 / category omit 保留', () => {
    it('关系数组整体替换：新字段可改值、可置 null、顺序随数组下标重排', async () => {
      const created = await createRecipeViaApi({
        name: `${RECIPE_PREFIX}更新`,
        category: '清爽时蔬',
        ingredients: [
          { name: '甲', amountText: '半个', quantity: 0.5, unit: 'PIECE' },
          { name: '乙', amountText: '适量' }
        ],
        steps: [
          { content: '第一步内容', title: '第一步', timerMinutes: 1 },
          { content: '第二步内容', title: '第二步', timerMinutes: 2 }
        ]
      });

      const updated = await inject('PUT', `/api/v1/recipes/${created.id}`, {
        name: created.name,
        version: created.version,
        ingredients: [
          { name: '乙', amountText: '2汤匙', quantity: 2, unit: 'OTHER' },
          { name: '甲', amountText: null, quantity: null, unit: null }
        ],
        steps: [
          { content: '第二步内容', title: '第二步改名', timerMinutes: 180 },
          { content: '第一步内容', title: null, timerMinutes: null }
        ]
      });
      expect(updated.statusCode).toBe(200);
      // category 未随请求发送（omit）→ 保留原值
      expect(updated.body.data.category).toBe('清爽时蔬');
      expect(updated.body.data.ingredients.map(ingredientTuple)).toEqual([
        ['乙', '2汤匙', 2, 'OTHER', null, false, false, 0],
        ['甲', null, null, null, null, false, false, 1]
      ]);
      expect(updated.body.data.steps.map((step: any) => [step.stepNo, step.title, step.timerMinutes])).toEqual([
        [1, '第二步改名', 180],
        [2, null, null]
      ]);

      const rows = await database.recipeIngredient.findMany({
        where: { recipeId: created.id },
        orderBy: { sortOrder: 'asc' }
      });
      expect(rows.map(ingredientTuple)).toEqual([
        ['乙', '2汤匙', 2, 'OTHER', null, false, false, 0],
        ['甲', null, null, null, null, false, false, 1]
      ]);
      const steps = await database.recipeStep.findMany({ where: { recipeId: created.id }, orderBy: { stepNo: 'asc' } });
      expect(steps.map((step) => [step.stepNo, step.title, step.timerMinutes, step.content])).toEqual([
        [1, '第二步改名', 180, '第二步内容'],
        [2, null, null, '第一步内容']
      ]);
    });

    it('category：omit 保留原值、显式 null 清空；老 scalar 的 PUT 全量替换语义不受影响', async () => {
      const created = await createRecipeViaApi({
        name: `${RECIPE_PREFIX}保留清空`,
        category: '鲜美水产',
        notes: '原始备注',
        ingredients: [],
        steps: []
      });
      expect(created.category).toBe('鲜美水产');

      const omitted = await inject('PUT', `/api/v1/recipes/${created.id}`, {
        name: created.name,
        version: created.version
      });
      expect(omitted.statusCode).toBe(200);
      expect(omitted.body.data.category).toBe('鲜美水产');
      // 老 scalar 仍是"全量替换"：未发送的 notes 被清成 null（既有契约，不得被新字段改动）
      expect(omitted.body.data.notes).toBeNull();

      const cleared = await inject('PUT', `/api/v1/recipes/${created.id}`, {
        name: created.name,
        version: omitted.body.data.version,
        category: null
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.body.data.category).toBeNull();
      const row = await database.recipe.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.category).toBeNull();
    });
  });

  describe('校验：非法输入 400 且父行 / 关系行 / version 不变', () => {
    it.each([
      ['category 数字', { category: 123 }],
      ['category 布尔', { category: true }],
      ['category 对象', { category: { name: 'x' } }],
      ['ingredients[].amountText 数字', { ingredients: [{ name: '甲', amountText: 5 }] }],
      ['ingredients[].amountText 布尔', { ingredients: [{ name: '甲', amountText: false }] }],
      ['ingredients[].quantity 负数（既有校验保留）', { ingredients: [{ name: '甲', quantity: -1 }] }],
      ['steps[].title 数字', { steps: [{ content: 'ok', title: 7 }] }],
      ['steps[].timerMinutes 181', { steps: [{ content: 'ok', timerMinutes: 181 }] }],
      ['steps[].timerMinutes 负数', { steps: [{ content: 'ok', timerMinutes: -1 }] }],
      ['steps[].timerMinutes 小数', { steps: [{ content: 'ok', timerMinutes: 10.5 }] }],
      ['steps[].timerMinutes 字符串', { steps: [{ content: 'ok', timerMinutes: '10' }] }],
      ['steps[].timerMinutes 布尔', { steps: [{ content: 'ok', timerMinutes: true }] }],
      ['steps[].content 空串（既有必填保留）', { steps: [{ content: '' }] }]
    ])('create %s 返回 400 且不落库', async (_label, override) => {
      const name = `${RECIPE_PREFIX}非法${_label}`;
      const { statusCode } = await inject('POST', '/api/v1/recipes', { name, ...override });
      expect(statusCode).toBe(400);
      expect(await countByName(name)).toBe(0);
    });

    it.each([0, 180])('timerMinutes=%i 是合法边界', async (timerMinutes) => {
      const created = await createRecipeViaApi({
        name: `${RECIPE_PREFIX}边界${timerMinutes}`,
        steps: [{ content: '边界步骤', timerMinutes }]
      });
      expect(created.steps[0].timerMinutes).toBe(timerMinutes);
    });

    it('update 非法输入 400 且父行与关系行完全不变', async () => {
      const created = await createRecipeViaApi({
        name: `${RECIPE_PREFIX}更新非法`,
        category: '下饭经典',
        ingredients: [{ name: '甲', amountText: '半个' }],
        steps: [{ content: '原步骤', title: '原标题', timerMinutes: 5 }]
      });
      const before = await database.recipe.findUniqueOrThrow({
        where: { id: created.id },
        include: { ingredients: true, steps: true }
      });

      for (const override of [
        { category: 42 },
        { ingredients: [{ name: '甲', amountText: 5 }] },
        { steps: [{ content: '原步骤', title: 9 }] },
        { steps: [{ content: '原步骤', timerMinutes: 181 }] },
        { steps: [{ content: '原步骤', timerMinutes: '5' }] },
        { steps: [{ content: ' ' }] }
      ]) {
        const response = await inject('PUT', `/api/v1/recipes/${created.id}`, {
          name: created.name,
          version: created.version,
          ...override
        });
        expect(response.statusCode).toBe(400);
      }

      const after = await database.recipe.findUniqueOrThrow({
        where: { id: created.id },
        include: { ingredients: true, steps: true }
      });
      expect(after).toMatchObject({ category: before.category, version: before.version });
      expect(after.ingredients.map(ingredientTuple)).toEqual(before.ingredients.map(ingredientTuple));
      expect(after.steps.map((step) => [step.title, step.timerMinutes, step.content])).toEqual(
        before.steps.map((step) => [step.title, step.timerMinutes, step.content])
      );
    });

    it('陈旧 version 返回 409 且不改动任何字段', async () => {
      const created = await createRecipeViaApi({
        name: `${RECIPE_PREFIX}版本冲突`,
        category: '治愈肉食',
        steps: [{ content: '步骤', title: '标题', timerMinutes: 9 }]
      });

      const response = await inject('PUT', `/api/v1/recipes/${created.id}`, {
        name: created.name,
        version: created.version + 1,
        category: '改不动的分类'
      });
      expect(response.statusCode).toBe(409);
      expect(response.body.error.code).toBe('VERSION_CONFLICT');
      const row = await database.recipe.findUniqueOrThrow({ where: { id: created.id }, include: { steps: true } });
      expect(row).toMatchObject({ category: '治愈肉食', version: created.version });
      expect(row.steps[0]).toMatchObject({ title: '标题', timerMinutes: 9 });
    });

    it('服务层同样拒绝非法新字段（绕过 HTTP 也不能落库）', async () => {
      await expect(
        createRecipe(database, { name: `${RECIPE_PREFIX}服务层分类`, category: 5 as unknown as string })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        createRecipe(database, {
          name: `${RECIPE_PREFIX}服务层用量`,
          ingredients: [{ name: '甲', amountText: 3 as unknown as string }]
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        createRecipe(database, {
          name: `${RECIPE_PREFIX}服务层计时`,
          steps: [{ content: 'ok', timerMinutes: 181 }]
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        createRecipe(database, {
          name: `${RECIPE_PREFIX}服务层计时字符串`,
          steps: [{ content: 'ok', timerMinutes: '5' as unknown as number }]
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await countByName(`${RECIPE_PREFIX}服务层计时`)).toBe(0);
    });
  });
});
