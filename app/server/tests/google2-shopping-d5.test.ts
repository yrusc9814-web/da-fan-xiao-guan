import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerShoppingRoutes } from '../src/modules/shopping/routes.js';
import { prismaConfigImport } from './setup/fixture-paths.js';

/**
 * VAN-201 购物清单 D5 收口（amountText 自由规格 + 菜谱缺料单事务补齐 + check-in 缺量原子拦截）。
 *
 * 两个独立验证单元：
 * 1) 迁移 20261002000300_google2_shopping_amount_text：在一次性临时工程里只 deploy 历史迁移、
 *    seed 真实旧购物项、再 deploy 新迁移，断言字段/索引/外键/数据 100% 保留且 amountText 为 NULL。
 * 2) 真实 HTTP + 真实 Prisma 持久化：结构化/自由规格两条写入路径、非法请求拒绝、
 *    同菜谱幂等对齐、跨菜谱分行、失效 ingredientId 降级、版本冲突、check-in 缺量 422 原子性、
 *    补量更新保留 ingredientId 清旧 amountText 后入库累加已有库存。
 *
 * 不触碰 data/app.db：迁移工程与库都落在 os.tmpdir() 下的一次性目录，测试结束强制清理；
 * 子进程的 DAFAN_DATABASE_PATH / DATABASE_URL / TEST_DATABASE_URL 全部指向该临时库，
 * 不继承父进程（test-backend-relay.db）的数据库环境变量。
 */

const projectRoot = resolve(import.meta.dirname, '../../..');
const prismaCli = resolve(projectRoot, 'node_modules/prisma/build/index.js');
const migrationsSource = resolve(projectRoot, 'app/server/prisma/migrations');
const schemaSource = resolve(projectRoot, 'app/server/prisma/schema.prisma');

const AMOUNT_TEXT_MIGRATION = '20261002000300_google2_shopping_amount_text';
const PREVIOUS_MIGRATIONS = [
  '20260805145000_init',
  '20260810182518_domain_core',
  '20260810190425_recipe_meal_roles',
  '20261001000000_google2_shopping_checkin',
  '20261001000100_google2_nutrition_fields',
  '20261001000200_google2_store_menu_item',
  '20261001000300_google2_recipe_form_fields',
  '20261002000000_google2_remaining_capabilities',
  '20261002000100_google2_meal_record_title',
  '20261002000200_deleted_item_plan_uncomplete_proof'
];

describe('VAN-201 购物清单 amountText 迁移（历史库 → 新迁移）', () => {
  let workRoot: string;
  let databasePath: string;
  let databaseUrl: string;

  function migrationEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      TEST_DATABASE_URL: databaseUrl,
      DAFAN_DATABASE_PATH: databasePath
    };
    // 临时迁移工程必须完全独立于父进程隔离根与基线开关，否则 deploy 可能被父库环境干扰
    delete env.DAFAN_ISOLATION_ROOT;
    delete env.DAFAN_FORWARD_BASELINE;
    return env;
  }

  function deploy(): { status: number; output: string } {
    const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: workRoot,
      encoding: 'utf8',
      env: migrationEnv()
    });
    return { status: result.status ?? 1, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
  }

  const open = () => new DatabaseSync(databasePath);
  const columnsOf = (db: DatabaseSync, table: string) =>
    (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string; notnull: number }>).map(
      (row) => ({ name: row.name, type: row.type, notnull: row.notnull })
    );
  const indexNamesOf = (db: DatabaseSync, table: string) =>
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name")
        .all(table) as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  const foreignKeysOf = (db: DatabaseSync, table: string) =>
    db
      .prepare(`PRAGMA foreign_key_list("${table}")`)
      .all()
      .map((row) => row as Record<string, unknown>)
      .sort((a, b) => String(a.from).localeCompare(String(b.from)));

  beforeAll(async () => {
    if (!existsSync(prismaCli)) throw new Error('未找到 Prisma CLI，请先执行 npm install');
    workRoot = await mkdtemp(join(tmpdir(), 't002-d5-migration-'));
    databasePath = join(workRoot, 'legacy.db');
    databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;
    await writeFile(databasePath, '');
    await mkdir(join(workRoot, 'prisma/migrations'), { recursive: true });
    await cp(schemaSource, join(workRoot, 'prisma/schema.prisma'));
    await cp(join(migrationsSource, 'migration_lock.toml'), join(workRoot, 'prisma/migrations/migration_lock.toml'));
    for (const name of PREVIOUS_MIGRATIONS) {
      await cp(join(migrationsSource, name), join(workRoot, 'prisma/migrations', name), { recursive: true });
    }
    await writeFile(
      join(workRoot, 'prisma.config.ts'),
      [
        `import { defineConfig } from '${prismaConfigImport}';`,
        '',
        'export default defineConfig({',
        "  schema: 'prisma/schema.prisma',",
        "  migrations: { path: 'prisma/migrations' },",
        `  datasource: { url: '${databaseUrl}' }`,
        '});',
        ''
      ].join('\n')
    );
  });

  afterAll(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(workRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      }
    }
    // 清理失败不得静默放过：残留的临时迁移库必须让测试失败，否则会掩盖存储污染
    throw new Error(`临时迁移目录清理失败：${workRoot}`, { cause: lastError });
  });

  it('存量 ShoppingListItem 全字段保留、amountText 为 NULL，索引与外键完整重建', { timeout: 120000 }, async () => {
    const legacy = deploy();
    expect(legacy.status, legacy.output).toBe(0);

    const before = open();
    before.exec(`
        INSERT INTO "Ingredient" ("id","name","quantity","unit","version","createdAt","updatedAt")
        VALUES ('legacy-ing-am','旧米',100,'GRAM',3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

        INSERT INTO "ShoppingList" ("id","name","status","notes","version","createdAt","updatedAt")
        VALUES ('legacy-list-am','旧采购清单','ACTIVE','旧备注',5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

        INSERT INTO "ShoppingListItem"
          ("id","shoppingListId","ingredientId","ingredientNameSnapshot","quantity","unit","sourceType","sourceId","completed","sortOrder","notes","createdAt","updatedAt")
        VALUES
          ('legacy-item-am-1','legacy-list-am','legacy-ing-am','旧米',500.5,'GRAM','RECIPE','legacy-recipe-am',1,3,'旧备注','2026-08-01 08:00:00','2026-08-02 09:30:00'),
          ('legacy-item-am-2','legacy-list-am',NULL,'旧鸡蛋',6,'PIECE','MANUAL',NULL,0,1,NULL,'2026-08-01 08:00:00','2026-08-02 09:30:00');
      `);
    const columnsBefore = columnsOf(before, 'ShoppingListItem');
    const indexesBefore = indexNamesOf(before, 'ShoppingListItem');
    const fksBefore = foreignKeysOf(before, 'ShoppingListItem');
    before.close();

    await cp(
      join(migrationsSource, AMOUNT_TEXT_MIGRATION),
      join(workRoot, 'prisma/migrations', AMOUNT_TEXT_MIGRATION),
      {
        recursive: true
      }
    );
    const migrated = deploy();
    expect(migrated.status, migrated.output).toBe(0);
    expect(migrated.output).toContain(AMOUNT_TEXT_MIGRATION);

    const after = open();
    const columnsAfter = columnsOf(after, 'ShoppingListItem');
    // 结构差异：quantity/unit 放宽为可空，并在 unit 之后新增 amountText、category，其余列顺序不变
    expect(columnsAfter.map((column) => column.name)).toEqual([
      'id',
      'shoppingListId',
      'ingredientId',
      'ingredientNameSnapshot',
      'quantity',
      'unit',
      'amountText',
      'category',
      'sourceType',
      'sourceId',
      'completed',
      'sortOrder',
      'notes',
      'createdAt',
      'updatedAt'
    ]);
    expect(columnsAfter.find((column) => column.name === 'quantity')?.notnull).toBe(0);
    expect(columnsAfter.find((column) => column.name === 'unit')?.notnull).toBe(0);
    expect(columnsAfter.find((column) => column.name === 'amountText')?.notnull).toBe(0);
    expect(columnsAfter.find((column) => column.name === 'category')?.notnull).toBe(0);
    expect(columnsBefore.find((column) => column.name === 'quantity')?.notnull).toBe(1);
    expect(columnsBefore.find((column) => column.name === 'unit')?.notnull).toBe(1);

    expect(indexNamesOf(after, 'ShoppingListItem')).toEqual(indexesBefore);
    expect(indexNamesOf(after, 'ShoppingListItem')).toEqual(
      expect.arrayContaining([
        'ShoppingListItem_shoppingListId_completed_sortOrder_idx',
        'ShoppingListItem_ingredientId_idx'
      ])
    );
    expect(foreignKeysOf(after, 'ShoppingListItem')).toEqual(fksBefore);

    const items = after
      .prepare(
        'SELECT id, shoppingListId, ingredientId, ingredientNameSnapshot, quantity, unit, amountText, category, sourceType, sourceId, completed, sortOrder, notes, createdAt, updatedAt FROM "ShoppingListItem" ORDER BY id'
      )
      .all() as Array<Record<string, unknown>>;
    expect(items).toEqual([
      {
        id: 'legacy-item-am-1',
        shoppingListId: 'legacy-list-am',
        ingredientId: 'legacy-ing-am',
        ingredientNameSnapshot: '旧米',
        quantity: 500.5,
        unit: 'GRAM',
        amountText: null,
        category: null,
        sourceType: 'RECIPE',
        sourceId: 'legacy-recipe-am',
        completed: 1,
        sortOrder: 3,
        notes: '旧备注',
        createdAt: '2026-08-01 08:00:00',
        updatedAt: '2026-08-02 09:30:00'
      },
      {
        id: 'legacy-item-am-2',
        shoppingListId: 'legacy-list-am',
        ingredientId: null,
        ingredientNameSnapshot: '旧鸡蛋',
        quantity: 6,
        unit: 'PIECE',
        amountText: null,
        category: null,
        sourceType: 'MANUAL',
        sourceId: null,
        completed: 0,
        sortOrder: 1,
        notes: null,
        createdAt: '2026-08-01 08:00:00',
        updatedAt: '2026-08-02 09:30:00'
      }
    ]);

    expect(after.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    after.close();

    const second = deploy();
    expect(second.status, second.output).toBe(0);
    expect(second.output).toContain('No pending migrations to apply');
  });
});

const database = createTestPrismaClient();
let app: FastifyInstance;
const runId = randomUUID().slice(0, 8);
const PREFIX = `van201-${runId}`;
const trackedIngredientIds: string[] = [];
const trackedListIds: string[] = [];
const trackedItemIds: string[] = [];

async function createIngredient(name: string, quantity: number, unit: 'GRAM' | 'KILOGRAM' | 'PIECE') {
  const ingredient = await database.ingredient.create({ data: { name, quantity, unit } });
  trackedIngredientIds.push(ingredient.id);
  return ingredient;
}

async function createList(name: string, items: Array<Record<string, unknown>>) {
  const withOrder = items.map((item, index) => ({ sortOrder: index, ...item }));
  const list = await database.shoppingList.create({ data: { name, items: { create: withOrder as never } } });
  trackedListIds.push(list.id);
  return database.shoppingList.findUniqueOrThrow({
    where: { id: list.id },
    include: { items: { orderBy: { sortOrder: 'asc' } } }
  });
}

async function createActiveList(name: string) {
  return createList(name, []);
}

const replenish = (listId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/v1/shopping-lists/${listId}/replenish-recipe`, payload });

const checkIn = (listId: string, payload: { version: number; operationId: string; itemIds: string[] }) =>
  app.inject({ method: 'POST', url: `/api/v1/shopping-lists/${listId}/check-in`, payload });

describe('VAN-201 购物清单 D5 后端契约（真实 HTTP + 真实持久化）', () => {
  beforeAll(async () => {
    await database.$connect();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerShoppingRoutes(app, database);
  });

  afterAll(async () => {
    const ingredients = await database.ingredient.findMany({
      where: { OR: [{ name: { startsWith: PREFIX } }, { id: { in: trackedIngredientIds } }] }
    });
    const ingredientIds = ingredients.map((row) => row.id);
    const lists = await database.shoppingList.findMany({
      where: { OR: [{ name: { startsWith: PREFIX } }, { id: { in: trackedListIds } }] }
    });
    const listIds = lists.map((row) => row.id);
    const items = await database.shoppingListItem.findMany({
      where: { OR: [{ shoppingListId: { in: listIds } }, { id: { in: trackedItemIds } }] }
    });
    await database.inventoryLog.deleteMany({
      where: { OR: [{ ingredientId: { in: ingredientIds } }, { ingredientNameSnapshot: { startsWith: PREFIX } }] }
    });
    await database.inventoryBatch.deleteMany({ where: { ingredientId: { in: ingredientIds } } });
    await database.shoppingListItem.deleteMany({ where: { id: { in: items.map((row) => row.id) } } });
    await database.shoppingCheckinOperation.deleteMany({
      where: { OR: [{ shoppingListId: { in: listIds } }, { id: { startsWith: PREFIX } }] }
    });
    await database.shoppingList.deleteMany({ where: { id: { in: listIds } } });
    await database.deletedItem.deleteMany({ where: { entityId: { in: listIds } } });
    await database.recipe.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await database.ingredient.deleteMany({ where: { id: { in: ingredientIds } } });

    await app.close();
    await database.$disconnect();
  });

  it('结构化数量单位与自由规格 amountText 两条合法路径均持久化，非法规格被拒绝且零写入', async () => {
    const structured = await app.inject({
      method: 'POST',
      url: '/api/v1/shopping-lists',
      payload: {
        name: `${PREFIX}-结构化清单`,
        items: [
          { ingredientName: `${PREFIX}-土豆`, quantity: 200, unit: 'GRAM' },
          { ingredientName: `${PREFIX}-盐`, amountText: '少许' }
        ]
      }
    });
    expect(structured.statusCode, structured.body).toBe(201);
    const created = structured.json().data;
    trackedListIds.push(created.id);
    expect(
      created.items.map((item: Record<string, unknown>) => [
        item.ingredientNameSnapshot,
        item.quantity,
        item.unit,
        item.amountText
      ])
    ).toEqual([
      [`${PREFIX}-土豆`, 200, 'GRAM', null],
      [`${PREFIX}-盐`, null, null, '少许']
    ]);

    const freeItem = await app.inject({
      method: 'POST',
      url: `/api/v1/shopping-lists/${created.id}/items`,
      payload: {
        version: created.version,
        ingredientName: `${PREFIX}-姜`,
        quantity: null,
        unit: null,
        amountText: '2块'
      }
    });
    expect(freeItem.statusCode, freeItem.body).toBe(200);
    const freeBody = freeItem.json().data;
    expect(
      freeBody.items.find((item: Record<string, unknown>) => item.ingredientNameSnapshot === `${PREFIX}-姜`)
    ).toMatchObject({ quantity: null, unit: null, amountText: '2块' });

    const invalidPayloads: Array<Record<string, unknown>> = [
      { ingredientName: `${PREFIX}-非法1`, quantity: 0, unit: 'GRAM' },
      { ingredientName: `${PREFIX}-非法2`, quantity: -5, unit: 'GRAM' },
      { ingredientName: `${PREFIX}-非法3`, quantity: 100 },
      { ingredientName: `${PREFIX}-非法4`, unit: 'GRAM' },
      { ingredientName: `${PREFIX}-非法5`, quantity: null, unit: null, amountText: null },
      { ingredientName: `${PREFIX}-非法6`, quantity: null, unit: null, amountText: '   ' },
      { ingredientName: '   ', amountText: '适量' }
    ];
    const version = freeBody.version;
    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/shopping-lists/${created.id}/items`,
        payload: { version, ...payload }
      });
      expect(response.statusCode, `${JSON.stringify(payload)} → ${response.body}`).toBe(400);
    }
    const unchanged = await database.shoppingList.findUniqueOrThrow({
      where: { id: created.id },
      include: { items: true }
    });
    expect(unchanged.version).toBe(version);
    expect(unchanged.items).toHaveLength(3);
    expect(unchanged.items.some((item) => item.ingredientNameSnapshot.startsWith(`${PREFIX}-非法`))).toBe(false);
  });

  it('addOrMerge 仅在双方结构化且可换算时累加，并清空过期 amountText', async () => {
    const list = await createActiveList(`${PREFIX}-合并清单`);
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/shopping-lists/${list.id}/items`,
      payload: {
        version: list.version,
        ingredientName: `${PREFIX}-米`,
        quantity: 200,
        unit: 'GRAM',
        amountText: '200克'
      }
    });
    expect(first.statusCode, first.body).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/shopping-lists/${list.id}/items`,
      payload: { version: first.json().data.version, ingredientName: `${PREFIX}-米`, quantity: 0.5, unit: 'KILOGRAM' }
    });
    expect(second.statusCode, second.body).toBe(200);
    const merged = second.json().data.items;
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ quantity: 700, unit: 'GRAM', amountText: null });

    // 自由规格项不参与数值累加：两条「适量」保持为两行（同一天然合并键也不合并）
    const freeA = await app.inject({
      method: 'POST',
      url: `/api/v1/shopping-lists/${list.id}/items`,
      payload: { version: second.json().data.version, ingredientName: `${PREFIX}-葱`, amountText: '适量' }
    });
    expect(freeA.statusCode, freeA.body).toBe(200);
    const freeB = await app.inject({
      method: 'POST',
      url: `/api/v1/shopping-lists/${list.id}/items`,
      payload: { version: freeA.json().data.version, ingredientName: `${PREFIX}-葱`, amountText: '适量' }
    });
    expect(freeB.statusCode, freeB.body).toBe(200);
    const onionRows = freeB
      .json()
      .data.items.filter((item: { ingredientNameSnapshot: string }) => item.ingredientNameSnapshot === `${PREFIX}-葱`);
    expect(onionRows).toHaveLength(2);
    expect(
      onionRows.every(
        (item: { quantity: unknown; unit: unknown; amountText: string }) =>
          item.quantity === null && item.unit === null && item.amountText === '适量'
      )
    ).toBe(true);
  });

  it('replenish-recipe 同菜谱严格幂等对齐最新差额，整批只推进一次版本', async () => {
    const recipe = await database.recipe.create({ data: { name: `${PREFIX}-番茄炒蛋` } });
    const list = await createActiveList(`${PREFIX}-补齐清单`);
    const payload = {
      version: list.version,
      recipeId: recipe.id,
      items: [
        { ingredientName: `${PREFIX}-土豆`, quantity: 200, unit: 'GRAM', amountText: null },
        { ingredientName: `${PREFIX}-葱`, quantity: null, unit: null, amountText: '适量' }
      ]
    };
    const first = await replenish(list.id, payload);
    expect(first.statusCode, first.body).toBe(200);
    const firstBody = first.json().data;
    expect(firstBody.version).toBe(list.version + 1);
    const recipeRows = firstBody.items.filter((item: { sourceId: string | null }) => item.sourceId === recipe.id);
    expect(recipeRows).toHaveLength(2);
    expect(
      recipeRows.every(
        (item: { sourceType: string; completed: boolean }) => item.sourceType === 'RECIPE' && !item.completed
      )
    ).toBe(true);
    expect(
      recipeRows.find((item: { ingredientNameSnapshot: string }) => item.ingredientNameSnapshot === `${PREFIX}-葱`)
    ).toMatchObject({ quantity: null, unit: null, amountText: '适量' });

    // 重复点击同一菜谱（同缺口）：对齐 update，绝不翻倍，版本仍只 +1
    const repeat = await replenish(list.id, { ...payload, version: firstBody.version });
    expect(repeat.statusCode, repeat.body).toBe(200);
    const repeatBody = repeat.json().data;
    expect(repeatBody.version).toBe(firstBody.version + 1);
    const repeatRows = repeatBody.items.filter((item: { sourceId: string | null }) => item.sourceId === recipe.id);
    expect(repeatRows).toHaveLength(2);
    expect(
      repeatRows.find((item: { ingredientNameSnapshot: string }) => item.ingredientNameSnapshot === `${PREFIX}-土豆`)
    ).toMatchObject({ quantity: 200, unit: 'GRAM' });

    // 最新差额（300g）覆盖而不是累加已有 200g
    const latest = await replenish(list.id, {
      ...payload,
      version: repeatBody.version,
      items: [{ ingredientName: `${PREFIX}-土豆`, quantity: 300, unit: 'GRAM' }]
    });
    expect(latest.statusCode, latest.body).toBe(200);
    const latestBody = latest.json().data;
    const potatoRows = latestBody.items.filter(
      (item: { ingredientNameSnapshot: string; sourceId: string | null }) =>
        item.ingredientNameSnapshot === `${PREFIX}-土豆` && item.sourceId === recipe.id
    );
    expect(potatoRows).toHaveLength(1);
    expect(potatoRows[0]).toMatchObject({ quantity: 300, unit: 'GRAM' });
    expect(latestBody.version).toBe(repeatBody.version + 1);
  });

  it('跨菜谱同名缺料分行保留各自 sourceId，手动录入同名项不被菜谱补齐污染', async () => {
    const recipeA = await database.recipe.create({ data: { name: `${PREFIX}-菜谱A` } });
    const recipeB = await database.recipe.create({ data: { name: `${PREFIX}-菜谱B` } });
    const list = await createActiveList(`${PREFIX}-跨菜谱清单`);
    const manual = await app.inject({
      method: 'POST',
      url: `/api/v1/shopping-lists/${list.id}/items`,
      payload: { version: list.version, ingredientName: `${PREFIX}-葱`, amountText: '手动适量' }
    });
    expect(manual.statusCode, manual.body).toBe(200);
    const manualVersion = manual.json().data.version;

    const first = await replenish(list.id, {
      version: manualVersion,
      recipeId: recipeA.id,
      items: [{ ingredientName: `${PREFIX}-葱`, quantity: null, unit: null, amountText: '1根' }]
    });
    expect(first.statusCode, first.body).toBe(200);
    const second = await replenish(list.id, {
      version: first.json().data.version,
      recipeId: recipeB.id,
      items: [{ ingredientName: `${PREFIX}-葱`, quantity: null, unit: null, amountText: '2根' }]
    });
    expect(second.statusCode, second.body).toBe(200);
    const rows = second
      .json()
      .data.items.filter((item: { ingredientNameSnapshot: string }) => item.ingredientNameSnapshot === `${PREFIX}-葱`);
    expect(rows).toHaveLength(3);
    expect(rows.find((item: { sourceType: string }) => item.sourceType === 'MANUAL')).toMatchObject({
      amountText: '手动适量'
    });
    const aRow = rows.find((item: { sourceId: string | null }) => item.sourceId === recipeA.id);
    const bRow = rows.find((item: { sourceId: string | null }) => item.sourceId === recipeB.id);
    expect(aRow).toMatchObject({ amountText: '1根', sourceType: 'RECIPE' });
    expect(bRow).toMatchObject({ amountText: '2根', sourceType: 'RECIPE' });
    expect(aRow.id).not.toBe(bRow.id);
  });

  it('失效 ingredientId 自动降级为 null；stale version 409 且零写入；非 ACTIVE 清单拒绝补齐', async () => {
    const list = await createActiveList(`${PREFIX}-降级清单`);
    const response = await replenish(list.id, {
      version: list.version,
      recipeId: `${PREFIX}-recipe-missing-ing`,
      items: [{ ingredientId: `${PREFIX}-not-exist`, ingredientName: `${PREFIX}-姜`, quantity: 2, unit: 'PIECE' }]
    });
    expect(response.statusCode, response.body).toBe(200);
    const created = response
      .json()
      .data.items.find((item: { ingredientNameSnapshot: string }) => item.ingredientNameSnapshot === `${PREFIX}-姜`);
    expect(created).toMatchObject({ ingredientId: null, quantity: 2, unit: 'PIECE', sourceType: 'RECIPE' });

    const beforeVersion = response.json().data.version;
    const stale = await replenish(list.id, {
      version: beforeVersion + 5,
      recipeId: `${PREFIX}-recipe-missing-ing`,
      items: [{ ingredientName: `${PREFIX}-姜`, quantity: 9, unit: 'PIECE' }]
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(JSON.parse(stale.body).error.code).toBe('VERSION_CONFLICT');
    const afterStale = await database.shoppingList.findUniqueOrThrow({
      where: { id: list.id },
      include: { items: true }
    });
    expect(afterStale.version).toBe(beforeVersion);
    expect(afterStale.items.find((item) => item.ingredientNameSnapshot === `${PREFIX}-姜`)?.quantity).toBe(2);

    const completed = await database.shoppingList.create({
      data: { name: `${PREFIX}-已完成清单`, status: 'COMPLETED' }
    });
    trackedListIds.push(completed.id);
    const rejected = await replenish(completed.id, {
      version: completed.version,
      recipeId: `${PREFIX}-recipe`,
      items: [{ ingredientName: `${PREFIX}-蒜`, quantity: 1, unit: 'PIECE' }]
    });
    expect(rejected.statusCode, rejected.body).toBe(409);
    const afterRejected = await database.shoppingList.findUniqueOrThrow({
      where: { id: completed.id },
      include: { items: true }
    });
    expect(afterRejected.version).toBe(completed.version);
    expect(afterRejected.items).toHaveLength(0);
  });

  it('check-in 遇到缺量自由规格项 422 原子拦截：库存/项目/版本/operation 全部零变化', async () => {
    const ingredient = await createIngredient(`${PREFIX}-库存米`, 100, 'GRAM');
    const list = await createList(`${PREFIX}-缺量清单`, [
      {
        ingredientId: ingredient.id,
        ingredientNameSnapshot: `${PREFIX}-库存米`,
        quantity: 500,
        unit: 'GRAM',
        sourceType: 'MANUAL',
        completed: true
      },
      {
        ingredientNameSnapshot: `${PREFIX}-盐`,
        quantity: null,
        unit: null,
        amountText: '少许',
        sourceType: 'MANUAL',
        completed: true
      }
    ]);
    const [riceItem, saltItem] = list.items;
    const logsBefore = await database.inventoryLog.count({ where: { ingredientId: ingredient.id } });
    const response = await checkIn(list.id, {
      version: list.version,
      operationId: `${PREFIX}-op-missing-${runId}`,
      itemIds: [riceItem.id, saltItem.id]
    });
    expect(response.statusCode, response.body).toBe(422);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('SHOPPING_CHECKIN_QUANTITY_REQUIRED');
    expect(body.error.message).toContain('缺少有效的采购数量或单位');

    expect((await database.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).quantity).toBe(100);
    expect(await database.inventoryLog.count({ where: { ingredientId: ingredient.id } })).toBe(logsBefore);
    expect(await database.inventoryBatch.count({ where: { ingredientId: ingredient.id } })).toBe(0);
    const after = await database.shoppingList.findUniqueOrThrow({ where: { id: list.id }, include: { items: true } });
    expect(after.version).toBe(list.version);
    expect(after.items).toHaveLength(2);
    expect(await database.shoppingCheckinOperation.count({ where: { id: `${PREFIX}-op-missing-${runId}` } })).toBe(0);
  });

  it('补量 PUT 保留 ingredientId 并清空旧 amountText，随后 check-in 累加已有库存而非新建同名食材', async () => {
    const ingredient = await createIngredient(`${PREFIX}-已有米`, 100, 'GRAM');
    const list = await createList(`${PREFIX}-补量清单`, [
      {
        ingredientId: ingredient.id,
        ingredientNameSnapshot: `${PREFIX}-已有米`,
        quantity: null,
        unit: null,
        amountText: '适量',
        sourceType: 'MANUAL',
        completed: true
      }
    ]);
    const item = list.items[0];

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/shopping-list-items/${item.id}`,
      payload: { version: list.version, quantity: 500, unit: 'GRAM' }
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const updatedBody = updated.json().data;
    expect(updatedBody.items[0]).toMatchObject({
      id: item.id,
      ingredientId: ingredient.id,
      quantity: 500,
      unit: 'GRAM',
      amountText: null
    });

    const response = await checkIn(list.id, {
      version: updatedBody.version,
      operationId: `${PREFIX}-op-refill-${runId}`,
      itemIds: [item.id]
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((await database.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).quantity).toBe(600);
    expect(await database.ingredient.count({ where: { name: `${PREFIX}-已有米` } })).toBe(1);
    expect(response.json().data.items).toHaveLength(0);
    expect(await database.shoppingCheckinOperation.count({ where: { id: `${PREFIX}-op-refill-${runId}` } })).toBe(1);
  });

  it('并发同版本补齐只有一个成功：另一请求 409，且不产生重复行/不重复推进版本', async () => {
    const list = await createActiveList(`${PREFIX}-并发清单`);
    const payload = {
      version: list.version,
      recipeId: `${PREFIX}-recipe-concurrent`,
      items: [{ ingredientName: `${PREFIX}-并发土豆`, quantity: 200, unit: 'GRAM' }]
    };
    const results = await Promise.allSettled([replenish(list.id, payload), replenish(list.id, payload)]);
    const responses = results.map((entry) => {
      if (entry.status === 'rejected') throw entry.reason;
      return entry.value;
    });
    const ok = responses.filter((response) => response.statusCode === 200);
    const conflicts = responses.filter((response) => response.statusCode === 409);
    expect(
      responses.map((response) => response.statusCode).sort(),
      responses.map((response) => response.body).join(' | ')
    ).toEqual([200, 409]);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    const after = await database.shoppingList.findUniqueOrThrow({ where: { id: list.id }, include: { items: true } });
    expect(after.version).toBe(list.version + 1);
    expect(after.items.filter((item) => item.ingredientNameSnapshot === `${PREFIX}-并发土豆`)).toHaveLength(1);
  });

  it('PUT 不传 ingredientId 时既有食材关联保留；只传数量单位会自动清空旧自由规格', async () => {
    const ingredient = await createIngredient(`${PREFIX}-关联米`, 100, 'GRAM');
    const list = await createList(`${PREFIX}-保留关联清单`, [
      {
        ingredientId: ingredient.id,
        ingredientNameSnapshot: `${PREFIX}-关联米`,
        quantity: 300,
        unit: 'GRAM',
        amountText: '300克',
        sourceType: 'RECIPE',
        sourceId: `${PREFIX}-recipe-keep`,
        completed: false
      }
    ]);
    const item = list.items[0];
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/shopping-list-items/${item.id}`,
      payload: { version: list.version, quantity: 350, unit: 'GRAM' }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.items[0]).toMatchObject({
      id: item.id,
      ingredientId: ingredient.id,
      quantity: 350,
      unit: 'GRAM',
      amountText: null,
      sourceType: 'RECIPE',
      sourceId: `${PREFIX}-recipe-keep`
    });
  });

  it('PUT 触及数量或单位时必须成对显式提供：单边缺失 400 且版本不变', async () => {
    const list = await createList(`${PREFIX}-成对校验清单`, [
      {
        ingredientNameSnapshot: `${PREFIX}-成对米`,
        quantity: 300,
        unit: 'GRAM',
        sourceType: 'MANUAL',
        completed: false
      },
      {
        ingredientNameSnapshot: `${PREFIX}-成对盐`,
        quantity: null,
        unit: null,
        amountText: '适量',
        sourceType: 'MANUAL',
        completed: false
      }
    ]);
    const [rice, salt] = list.items;

    const quantityOnly = await app.inject({
      method: 'PUT',
      url: `/api/v1/shopping-list-items/${rice.id}`,
      payload: { version: list.version, quantity: 350 }
    });
    expect(quantityOnly.statusCode, quantityOnly.body).toBe(400);
    expect(JSON.parse(quantityOnly.body).error.code).toBe('VALIDATION_ERROR');

    const unitOnly = await app.inject({
      method: 'PUT',
      url: `/api/v1/shopping-list-items/${salt.id}`,
      payload: { version: list.version, unit: 'GRAM' }
    });
    expect(unitOnly.statusCode, unitOnly.body).toBe(400);
    expect(JSON.parse(unitOnly.body).error.code).toBe('VALIDATION_ERROR');

    const unchanged = await database.shoppingList.findUniqueOrThrow({
      where: { id: list.id },
      include: { items: { orderBy: { sortOrder: 'asc' } } }
    });
    expect(unchanged.version).toBe(list.version);
    expect(unchanged.items[0]).toMatchObject({ quantity: 300, unit: 'GRAM', amountText: null });
    expect(unchanged.items[1]).toMatchObject({ quantity: null, unit: null, amountText: '适量' });

    // 成对完整更新成功
    const paired = await app.inject({
      method: 'PUT',
      url: `/api/v1/shopping-list-items/${salt.id}`,
      payload: { version: list.version, quantity: 2, unit: 'PIECE' }
    });
    expect(paired.statusCode, paired.body).toBe(200);
    expect(paired.json().data.items.find((item: { id: string }) => item.id === salt.id)).toMatchObject({
      quantity: 2,
      unit: 'PIECE',
      amountText: null
    });

    // completed / notes 单独更新仍合法（不要求数量单位成对）
    const notesOnly = await app.inject({
      method: 'PUT',
      url: `/api/v1/shopping-list-items/${rice.id}`,
      payload: { version: paired.json().data.version, completed: true, notes: '已完成采购' }
    });
    expect(notesOnly.statusCode, notesOnly.body).toBe(200);
    expect(notesOnly.json().data.items.find((item: { id: string }) => item.id === rice.id)).toMatchObject({
      quantity: 300,
      unit: 'GRAM',
      completed: true,
      notes: '已完成采购'
    });
  });

  it('category 在创建初始项 / POST 新增 / PUT 更新 / 菜谱补齐四条路径持久化，未传时保留既有值', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/shopping-lists',
      payload: {
        name: `${PREFIX}-分类清单`,
        items: [{ ingredientName: `${PREFIX}-分类土豆`, quantity: 200, unit: 'GRAM', category: '蔬菜' }]
      }
    });
    expect(created.statusCode, created.body).toBe(201);
    const list = created.json().data;
    trackedListIds.push(list.id);
    expect(list.items[0]).toMatchObject({ category: '蔬菜' });

    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/shopping-lists/${list.id}/items`,
      payload: {
        version: list.version,
        ingredientName: `${PREFIX}-分类盐`,
        amountText: '少许',
        category: ' 调味品 '
      }
    });
    expect(added.statusCode, added.body).toBe(200);
    const salt = added
      .json()
      .data.items.find(
        (item: { ingredientNameSnapshot: string }) => item.ingredientNameSnapshot === `${PREFIX}-分类盐`
      );
    expect(salt).toMatchObject({ category: '调味品', quantity: null, unit: null, amountText: '少许' });

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/shopping-list-items/${salt.id}`,
      payload: { version: added.json().data.version, category: '调料' }
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().data.items.find((item: { id: string }) => item.id === salt.id)).toMatchObject({
      category: '调料',
      amountText: '少许'
    });

    // 未传 category 的更新保留既有分类
    const keep = await app.inject({
      method: 'PUT',
      url: `/api/v1/shopping-list-items/${salt.id}`,
      payload: { version: updated.json().data.version, notes: '保持不变' }
    });
    expect(keep.statusCode, keep.body).toBe(200);
    expect(keep.json().data.items.find((item: { id: string }) => item.id === salt.id)).toMatchObject({
      category: '调料',
      notes: '保持不变'
    });

    const recipe = await database.recipe.create({ data: { name: `${PREFIX}-分类菜谱` } });
    const replenished = await replenish(list.id, {
      version: keep.json().data.version,
      recipeId: recipe.id,
      items: [
        { ingredientName: `${PREFIX}-分类姜`, quantity: 2, unit: 'PIECE', category: '蔬菜' },
        { ingredientName: `${PREFIX}-分类盐`, quantity: null, unit: null, amountText: '少许' }
      ]
    });
    expect(replenished.statusCode, replenished.body).toBe(200);
    const replenishedItems = replenished.json().data.items;
    expect(
      replenishedItems.find(
        (item: { ingredientNameSnapshot: string }) => item.ingredientNameSnapshot === `${PREFIX}-分类姜`
      )
    ).toMatchObject({ category: '蔬菜', quantity: 2, unit: 'PIECE' });
    // 同菜谱幂等对齐时未传 category（非空才对齐）不影响既有分类
    expect(
      replenishedItems.find(
        (item: { ingredientNameSnapshot: string; sourceId: string | null }) =>
          item.ingredientNameSnapshot === `${PREFIX}-分类盐` && item.sourceId === recipe.id
      )
    ).toMatchObject({ category: null });
    expect(
      replenishedItems.find(
        (item: { ingredientNameSnapshot: string; sourceType: string }) =>
          item.ingredientNameSnapshot === `${PREFIX}-分类盐` && item.sourceType === 'MANUAL'
      )
    ).toMatchObject({ category: '调料' });

    // 批量补齐传了新分类：同菜谱命中项对齐更新分类
    const realigned = await replenish(list.id, {
      version: replenished.json().data.version,
      recipeId: recipe.id,
      items: [{ ingredientName: `${PREFIX}-分类姜`, quantity: 3, unit: 'PIECE', category: '根茎' }]
    });
    expect(realigned.statusCode, realigned.body).toBe(200);
    expect(
      realigned
        .json()
        .data.items.find(
          (item: { ingredientNameSnapshot: string; sourceId: string | null }) =>
            item.ingredientNameSnapshot === `${PREFIX}-分类姜` && item.sourceId === recipe.id
        )
    ).toMatchObject({ category: '根茎', quantity: 3, unit: 'PIECE' });
  });
});
