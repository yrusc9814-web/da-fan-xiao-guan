import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MealType,
  QuantityUnit,
  RecordItemType,
  RecordSourceType,
  PlanItemType,
  ShoppingSourceType
} from '@prisma/client';

import { buildApp } from '../src/app.js';
import {
  assertBusinessDate,
  assertIngredientQuantity,
  assertMealPlanDinerCount,
  assertNonEmpty,
  assertNonNegative,
  assertRecipeIngredientQuantity,
  assertRecipeName,
  assertRating,
  assertShoppingListQuantity,
  assertSpicyLevel
} from '../src/database/validation.js';
import { assertVersion, nextVersion, VersionConflictError } from '../src/database/optimistic-lock.js';
import { filePathFromDatabaseUrl, resolveDatabaseUrl } from '../src/database/paths.js';
import { withActiveFilter } from '../src/database/soft-delete.js';
import { convertQuantity, canConvertUnit } from '../src/database/units.js';
import { createPrismaClient } from '../src/database/client.js';
import { createTestPrismaClient, testDatabaseUrl } from '../src/database/test-database.js';

const database = createTestPrismaClient();
const projectRoot = resolve(import.meta.dirname, '../../..');
const applicationDatabasePath = resolve(projectRoot, 'data/app.db');
const expectedTestDatabaseUrl = process.env.TEST_DATABASE_URL ?? 'file:../../../data/test.db';
const expectedTestDatabasePath = filePathFromDatabaseUrl(expectedTestDatabaseUrl);
const defaultTestDatabasePath = resolve(projectRoot, 'data/test.db');

if (!expectedTestDatabasePath) {
  throw new Error('测试数据库必须使用 file: SQLite URL');
}

describe('节点 2 数据库底座', () => {
  beforeAll(async () => {
    await database.$connect();
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it('连接到测试数据库且与开发数据库隔离', async () => {
    const result = await database.$queryRaw<Array<{ value: bigint }>>`SELECT 1 AS value`;

    expect(result[0]?.value).toBe(1n);
    const developmentUrl = resolveDatabaseUrl({ DATABASE_URL: 'file:../../../data/app.db' });
    const isolatedTestUrl = resolveDatabaseUrl({
      NODE_ENV: 'test',
      TEST_DATABASE_URL: 'file:../../../data/test.db',
      DATABASE_URL: 'file:../../../data/app.db'
    });
    const developmentUrlWithTestVariable = resolveDatabaseUrl({
      TEST_DATABASE_URL: 'file:../../../data/test.db',
      DATABASE_URL: 'file:../../../data/app.db'
    });

    expect(normalize(filePathFromDatabaseUrl(testDatabaseUrl)!)).toBe(normalize(expectedTestDatabasePath));
    expect(normalize(filePathFromDatabaseUrl(developmentUrl)!)).toBe(normalize(applicationDatabasePath));
    expect(normalize(filePathFromDatabaseUrl(isolatedTestUrl)!)).toBe(normalize(defaultTestDatabasePath));
    expect(normalize(filePathFromDatabaseUrl(developmentUrlWithTestVariable)!)).toBe(
      normalize(applicationDatabasePath)
    );
    expect(normalize(expectedTestDatabasePath)).not.toBe(normalize(applicationDatabasePath));
  });

  it('正式 Migration 已在测试数据库中执行', async () => {
    const migrations = await database.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
    `;

    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations.some((migration) => migration.migration_name === '20260805145000_init')).toBe(true);
  });

  it('数据库不可用时健康接口返回明确错误', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'dafan-health-unavailable-'));
    const unavailableParent = join(temporary, randomUUID());
    const unavailableDatabase = createPrismaClient(`file:${join(unavailableParent, 'health.db')}`);
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;

    try {
      await writeFile(unavailableParent, 'not a directory');
      app = await buildApp({ logger: false, database: unavailableDatabase });
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      const payload = response.json() as {
        success: boolean;
        data: null;
        error: { code: string; message: string };
      };

      expect(response.statusCode).toBe(503);
      expect(payload).toEqual({
        success: false,
        data: null,
        error: {
          code: 'DATABASE_ERROR',
          message: '数据库不可用'
        }
      });
    } finally {
      await app?.close();
      await unavailableDatabase.$disconnect();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('保存结构化菜谱食材关系', async () => {
    const ingredient = await database.ingredient.create({
      data: {
        name: '番茄',
        quantity: 500,
        unit: QuantityUnit.GRAM
      }
    });
    const recipe = await database.recipe.create({
      data: {
        name: '番茄炒蛋',
        spicyLevel: 1,
        ingredients: {
          create: {
            ingredientId: ingredient.id,
            ingredientNameSnapshot: ingredient.name,
            quantity: 300,
            unit: QuantityUnit.GRAM,
            sortOrder: 0
          }
        }
      },
      include: { ingredients: true }
    });

    expect(recipe.name).toBe('番茄炒蛋');
    expect(recipe.version).toBe(1);
    expect(recipe.ingredients).toHaveLength(1);
    expect(recipe.ingredients[0]?.quantity).toBe(300);
    expect(recipe.ingredients[0]?.ingredientId).toBe(ingredient.id);
  });

  it('支持多项目计划及多位食用者', async () => {
    const recipe = await database.recipe.create({ data: { name: '紫菜蛋花汤' } });
    const dinerA = await database.diner.create({ data: { name: '小明' } });
    const dinerB = await database.diner.create({ data: { name: '小红' } });
    const plan = await database.mealPlan.create({
      data: {
        planDate: '2026-08-05',
        mealType: MealType.DINNER,
        dinerCount: 2,
        items: {
          create: [
            { itemType: PlanItemType.RECIPE, recipeId: recipe.id, sortOrder: 0 },
            { itemType: PlanItemType.CUSTOM, customName: '凉拌黄瓜', sortOrder: 1 }
          ]
        },
        diners: {
          create: [{ dinerId: dinerA.id }, { dinerId: dinerB.id }]
        }
      },
      include: { items: true, diners: true }
    });

    expect(plan.items).toHaveLength(2);
    expect(plan.diners).toHaveLength(2);
    expect(plan.version).toBe(1);
  });

  it('支持多项目饮食记录及历史食用者关联', async () => {
    const recipe = await database.recipe.create({ data: { name: '宫保鸡丁' } });
    const store = await database.store.create({ data: { name: '家门口餐馆' } });
    const diner = await database.diner.create({ data: { name: '小李' } });
    const record = await database.mealRecord.create({
      data: {
        recordDate: '2026-08-05',
        mealType: MealType.LUNCH,
        sourceType: RecordSourceType.CUSTOM,
        items: {
          create: [
            { itemType: RecordItemType.RECIPE, recipeId: recipe.id, sortOrder: 0 },
            { itemType: RecordItemType.STORE, storeId: store.id, sortOrder: 1 }
          ]
        },
        diners: {
          create: { dinerId: diner.id }
        }
      },
      include: { items: true, diners: true }
    });

    expect(record.items).toHaveLength(2);
    expect(record.diners).toHaveLength(1);
    expect(record.version).toBe(1);
  });

  it('支持购物清单及清单项目关系', async () => {
    const ingredient = await database.ingredient.create({
      data: { name: '鸡蛋', quantity: 6, unit: QuantityUnit.PIECE }
    });
    const list = await database.shoppingList.create({
      data: {
        name: '本周采购',
        items: {
          create: {
            ingredientId: ingredient.id,
            ingredientNameSnapshot: ingredient.name,
            quantity: 12,
            unit: QuantityUnit.PIECE,
            sourceType: ShoppingSourceType.MANUAL
          }
        }
      },
      include: { items: true }
    });

    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.quantity).toBe(12);
    expect(list.version).toBe(1);
  });

  it('软删除辅助函数默认只返回未删除记录', async () => {
    const active = await database.recipe.create({ data: { name: '保留菜谱' } });
    const deleted = await database.recipe.create({
      data: { name: '已删除菜谱', deletedAt: new Date() }
    });

    const recipes = await database.recipe.findMany({
      where: withActiveFilter({ id: { in: [active.id, deleted.id] } })
    });

    expect(recipes.map((recipe) => recipe.id)).toEqual([active.id]);
  });

  it('乐观锁支持成功更新和版本冲突', async () => {
    const recipe = await database.recipe.create({ data: { name: '锁测试菜谱' } });

    assertVersion('Recipe', recipe.id, 1, recipe.version);
    const updateResult = await database.recipe.updateMany({
      where: { id: recipe.id, version: recipe.version },
      data: { name: '锁测试菜谱（已更新）', version: { increment: 1 } }
    });

    expect(updateResult.count).toBe(1);
    const updated = await database.recipe.findUniqueOrThrow({ where: { id: recipe.id } });
    expect(updated.version).toBe(2);
    expect(nextVersion(recipe.version)).toBe(2);
    expect(() => assertVersion('Recipe', recipe.id, 1, updated.version)).toThrow(VersionConflictError);
  });

  it('版本冲突映射为 409 统一错误响应', async () => {
    const app = await buildApp({ logger: false, database });
    app.get('/api/v1/test-version-conflict', async () => {
      throw new VersionConflictError({
        entity: 'Recipe',
        id: 'recipe-1',
        expectedVersion: 1,
        actualVersion: 2
      });
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/test-version-conflict' });
    const payload = response.json() as {
      success: boolean;
      data: null;
      error: { code: string; details: Record<string, string | number> };
    };

    await app.close();
    expect(response.statusCode).toBe(409);
    expect(payload.success).toBe(false);
    expect(payload.data).toBeNull();
    expect(payload.error.code).toBe('VERSION_CONFLICT');
    expect(payload.error.details.actualVersion).toBe(2);
  });

  it('单位换算支持千克克和升毫升，拒绝不可换算单位', () => {
    expect(convertQuantity(1, 'KILOGRAM', 'GRAM')).toBe(1000);
    expect(convertQuantity(1500, 'MILLILITER', 'LITER')).toBe(1.5);
    expect(convertQuantity(1, 'GRAM', 'LITER')).toBeNull();
    expect(canConvertUnit('GRAM', 'KILOGRAM')).toBe(true);
    expect(canConvertUnit('PIECE', 'GRAM')).toBe(false);
  });

  it('事务失败时回滚写入', async () => {
    const before = await database.recipe.count();

    await expect(
      database.$transaction(async (transaction) => {
        await transaction.recipe.create({ data: { name: '事务内临时菜谱' } });
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    expect(await database.recipe.count()).toBe(before);
  });

  it('基础业务校验覆盖非负数、评分、辣度、名称和业务日期', () => {
    expect(() => assertNonNegative(0, '数量')).not.toThrow();
    expect(() => assertNonNegative(-1, '数量')).toThrow();
    expect(() => assertIngredientQuantity(0)).not.toThrow();
    expect(() => assertIngredientQuantity(-1)).toThrow();
    expect(() => assertRecipeIngredientQuantity(null)).not.toThrow();
    expect(() => assertRecipeIngredientQuantity(-1)).toThrow();
    expect(() => assertShoppingListQuantity(1)).not.toThrow();
    expect(() => assertShoppingListQuantity(-1)).toThrow();
    expect(() => assertMealPlanDinerCount(2)).not.toThrow();
    expect(() => assertMealPlanDinerCount(-1)).toThrow();
    expect(() => assertMealPlanDinerCount(1.5)).toThrow();
    expect(() => assertRating(5)).not.toThrow();
    expect(() => assertRating(5.1)).toThrow();
    expect(() => assertSpicyLevel(0)).not.toThrow();
    expect(() => assertSpicyLevel(5)).not.toThrow();
    expect(() => assertSpicyLevel(5.5)).toThrow();
    expect(() => assertNonEmpty('番茄炒蛋', '菜谱名称')).not.toThrow();
    expect(() => assertNonEmpty('  ', '菜谱名称')).toThrow();
    expect(() => assertRecipeName('番茄炒蛋')).not.toThrow();
    expect(() => assertRecipeName('')).toThrow();
    expect(() => assertBusinessDate('2026-08-05')).not.toThrow();
    expect(() => assertBusinessDate('2026/08/05')).toThrow();
  });
});

describe('测试数据库安全闸', () => {
  it('NODE_ENV=test 且缺少 TEST_DATABASE_URL 时立即中止，绝不回退到开发数据库', () => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test' })).toThrow(/测试数据库安全闸/);
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test' })).toThrow(/TEST_DATABASE_URL/);
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test', DATABASE_URL: 'file:../../../data/app.db' })).toThrow(
      /测试数据库安全闸/
    );
  });

  it('TEST_DATABASE_URL 为空字符串或纯空白时立即中止', () => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: '' })).toThrow(/测试数据库安全闸/);
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: '   ' })).toThrow(/测试数据库安全闸/);
  });

  it('TEST_DATABASE_URL 解析到开发数据库时立即中止（相对路径、绝对路径与 query 参数变体）', () => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: 'file:../../../data/app.db' })).toThrow(
      /测试数据库安全闸/
    );
    expect(() =>
      resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: `file:${applicationDatabasePath}` })
    ).toThrow(/开发数据库/);
    expect(() =>
      resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: 'file:../../../data/app.db?connection_limit=1' })
    ).toThrow(/测试数据库安全闸/);
  });

  it.skipIf(process.platform !== 'win32')('Windows 大小写不敏感的路径变体同样视为开发数据库', () => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: 'file:../../../DATA/APP.DB' })).toThrow(
      /测试数据库安全闸/
    );
  });

  it('非 file 协议的 TEST_DATABASE_URL 原样通过', () => {
    const postgresUrl = 'postgresql://user:pass@localhost:5432/test';
    expect(resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: postgresUrl })).toBe(postgresUrl);
  });

  it('客户端工厂在测试环境下拒绝开发数据库 URL', () => {
    expect(() => createPrismaClient(`file:${applicationDatabasePath}`)).toThrow(/安全闸|开发数据库/);
  });

  it('合法的独立测试库继续可用，且不受 DATABASE_URL 干扰', () => {
    const isolatedUrl = resolveDatabaseUrl({
      NODE_ENV: 'test',
      TEST_DATABASE_URL: 'file:../../../data/test.db',
      DATABASE_URL: 'file:../../../data/app.db'
    });

    expect(normalize(filePathFromDatabaseUrl(isolatedUrl)!)).toBe(normalize(defaultTestDatabasePath));
  });

  it('标准三斜杠 WHATWG file URL 指向开发数据库时立即中止（跨平台）', () => {
    // pathToFileURL 产出 file:///D:/... / file:///home/... 的标准三斜杠形式：
    // Prisma 按 WHATWG 语义解析时会指向真实开发库，而 naive 解析在 Windows 上会算错放行。
    expect(() =>
      resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: pathToFileURL(applicationDatabasePath).href })
    ).toThrow(/测试数据库安全闸/);
  });

  it('file URL 变体（fragment、百分号编码、尾斜杠）无法绕过守卫（跨平台）', () => {
    expect(() =>
      resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: 'file:../../../data/app.db#fragment' })
    ).toThrow(/测试数据库安全闸/);
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: 'file:../../../data/a%70p.db' })).toThrow(
      /测试数据库安全闸/
    );
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: 'file:../../../data/app.db/' })).toThrow(
      /测试数据库安全闸/
    );
  });

  it('大写 FILE: scheme 无法绕过守卫（跨平台）', () => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: 'FILE:../../../data/app.db' })).toThrow(
      /测试数据库安全闸/
    );
  });

  it.skipIf(process.platform !== 'win32')(
    'Windows 专属 file URL 变体（localhost 主机名、编码盘符）同样无法绕过',
    () => {
      const applicationFileUrl = pathToFileURL(applicationDatabasePath).href;
      const localhostUrl = `file://localhost/${applicationFileUrl.slice('file://'.length)}`;
      expect(() => resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: localhostUrl })).toThrow(
        /测试数据库安全闸/
      );

      const driveLetter = applicationFileUrl.charAt('file:///'.length);
      const encodedDrive = `%${driveLetter.charCodeAt(0).toString(16).toUpperCase()}%3A`;
      const pathAfterDrive = applicationFileUrl.slice('file:///'.length + 2);
      const encodedDriveUrl = `file:///${encodedDrive}/${pathAfterDrive}`;
      expect(() => resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: encodedDriveUrl })).toThrow(
        /测试数据库安全闸/
      );
    }
  );

  it('合法的标准三斜杠 file URL 指向独立测试库时不被误杀（跨平台）', () => {
    const isolatedUrl = resolveDatabaseUrl({
      NODE_ENV: 'test',
      TEST_DATABASE_URL: pathToFileURL(defaultTestDatabasePath).href
    });

    expect(fileURLToPath(isolatedUrl)).toBe(defaultTestDatabasePath);
  });
});
