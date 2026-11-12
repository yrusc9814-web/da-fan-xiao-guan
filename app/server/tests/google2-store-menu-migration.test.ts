import { spawnSync } from 'node:child_process';
import { fixtureDataRoot, prismaConfigImport } from './setup/fixture-paths.js';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Google2 店铺招牌菜单迁移（20261001000200_google2_store_menu_item）兼容性证据。
 *
 * 做法：在 data/ 下的一次性临时目录里复制一份 prisma 工程（schema + 已冻结的历史迁移），
 * 只应用新迁移之前的历史迁移（旧三迁移 + shopping + nutrition）→ 写入真实 Store 及其关系行 →
 * deploy 新迁移 → 断言 Store / StoreMealType 结构与既有数据逐字段不变、新表为空；
 * 再 deploy 一次验证幂等；最后用真实 API + Prisma 往新表插菜单并读回。
 *
 * 不触碰 data/app.db，不修改任何已冻结的历史迁移，临时工程与临时库都在 gitignored 的 data/ 下。
 */

const projectRoot = resolve(import.meta.dirname, '../../..');
const prismaCli = resolve(projectRoot, 'node_modules/prisma/build/index.js');
const migrationsSource = resolve(projectRoot, 'app/server/prisma/migrations');
const schemaSource = resolve(projectRoot, 'app/server/prisma/schema.prisma');

const LEGACY_MIGRATIONS = ['20260805145000_init', '20260810182518_domain_core', '20260810190425_recipe_meal_roles'];
const SHOPPING_MIGRATION = '20261001000000_google2_shopping_checkin';
const NUTRITION_MIGRATION = '20261001000100_google2_nutrition_fields';
const MENU_MIGRATION = '20261001000200_google2_store_menu_item';
const EXISTING_MIGRATIONS = [...LEGACY_MIGRATIONS, SHOPPING_MIGRATION, NUTRITION_MIGRATION];

let workRoot: string;
let databasePath: string;
let databaseUrl: string;

const LEGACY_STORE = {
  id: 'legacy-store-1',
  name: '旧店铺',
  address: '浅草食街 108 号',
  storeType: '小馆',
  cuisine: '日式料理',
  averageCost: 35,
  supportsDineIn: true,
  supportsTakeout: false,
  contact: '0512-68219901',
  businessHours: '10:30 - 21:30',
  rating: 4.9,
  recommendedDishes: '照烧鸡排便当、温泉蛋牛丼',
  avoidDishes: '重辣',
  tagsText: '日式,便当',
  notes: '午市点单建议提前 15 分钟',
  favorite: true,
  version: 7
};

async function prepareWorkspace(): Promise<void> {
  await mkdir(join(workRoot, 'prisma/migrations'), { recursive: true });
  await cp(schemaSource, join(workRoot, 'prisma/schema.prisma'));
  await cp(join(migrationsSource, 'migration_lock.toml'), join(workRoot, 'prisma/migrations/migration_lock.toml'));
  for (const name of EXISTING_MIGRATIONS) {
    await cp(join(migrationsSource, name), join(workRoot, 'prisma/migrations', name), { recursive: true });
  }
  // 临时工程里用最小 prisma.config.ts 指向临时库，与仓库级配置（默认 data/app.db）完全隔离
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
}

function deployMigrations(): { status: number; output: string } {
  const started = performance.now();
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: workRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl, NODE_ENV: 'test' }
  });
  console.info(`migration deploy: ${Math.round(performance.now() - started)}ms, exit=${result.status}`);
  console.info(result.stdout);
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

async function addMigration(name: string): Promise<void> {
  await cp(join(migrationsSource, name), join(workRoot, 'prisma/migrations', name), { recursive: true });
}

const openDatabase = () => new DatabaseSync(databasePath);

function columnsOf(database: DatabaseSync, table: string): string[] {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function tableNames(database: DatabaseSync): string[] {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

function indexNamesOf(database: DatabaseSync, table: string): string[] {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name")
    .all(table) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function seedLegacyRows(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO "Store" (
      "id","name","address","storeType","cuisine","averageCost","supportsDineIn","supportsTakeout",
      "contact","businessHours","rating","recommendedDishes","avoidDishes","tagsText","notes",
      "favorite","version","deletedAt","createdAt","updatedAt"
    ) VALUES (
      '${LEGACY_STORE.id}','${LEGACY_STORE.name}','${LEGACY_STORE.address}','${LEGACY_STORE.storeType}',
      '${LEGACY_STORE.cuisine}',${LEGACY_STORE.averageCost},1,0,
      '${LEGACY_STORE.contact}','${LEGACY_STORE.businessHours}',${LEGACY_STORE.rating},
      '${LEGACY_STORE.recommendedDishes}','${LEGACY_STORE.avoidDishes}','${LEGACY_STORE.tagsText}',
      '${LEGACY_STORE.notes}',1,${LEGACY_STORE.version},NULL,'2026-09-01 08:00:00','2026-09-02 09:30:00'
    );

    INSERT INTO "StoreMealType" ("id","storeId","mealType","createdAt","updatedAt")
    VALUES ('legacy-smt-1','${LEGACY_STORE.id}','LUNCH','2026-09-01 08:00:00','2026-09-01 08:00:00');

    INSERT INTO "StoreMealType" ("id","storeId","mealType","createdAt","updatedAt")
    VALUES ('legacy-smt-2','${LEGACY_STORE.id}','DINNER','2026-09-01 08:00:00','2026-09-01 08:00:00');
  `);
}

function legacyStoreRow(): Record<string, unknown> {
  const database = openDatabase();
  const row = database.prepare('SELECT * FROM "Store" WHERE id = ?').get(LEGACY_STORE.id) as Record<string, unknown>;
  database.close();
  return row;
}

describe('Google2 店铺招牌菜单迁移兼容性（历史库 → 新迁移）', () => {
  beforeAll(async () => {
    if (!existsSync(prismaCli)) {
      throw new Error('未找到 Prisma CLI，请先执行 npm ci / npm install');
    }
    workRoot = await mkdtemp(join(fixtureDataRoot(projectRoot), 'tmp-store-menu-migration-'));
    databasePath = join(workRoot, 'legacy.db');
    databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;
    await writeFile(databasePath, '');
    await prepareWorkspace();
  });

  afterAll(async () => {
    // 断言中途失败时可能有未关闭的 SQLite 连接，清理失败不应掩盖真正的断言错误
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  // 两次真实 Prisma CLI deploy 保留全部兼容性断言，单独使用集成测试预算。
  it('旧库 deploy 新迁移后只新增菜单表，Store 与关系数据逐字段不变且菜单为空', { timeout: 60000 }, async () => {
    const legacyDeploy = deployMigrations();
    expect(legacyDeploy.status).toBe(0);

    const before = openDatabase();
    expect(tableNames(before)).not.toContain('StoreMenuItem');
    const storeColumnsBefore = columnsOf(before, 'Store');
    seedLegacyRows(before);
    before.close();

    const storeBefore = legacyStoreRow();

    await addMigration(MENU_MIGRATION);
    const migration = deployMigrations();
    expect(migration.status).toBe(0);
    expect(migration.output).toContain(MENU_MIGRATION);

    const after = openDatabase();
    expect(tableNames(after)).toContain('StoreMenuItem');
    expect(columnsOf(after, 'StoreMenuItem')).toEqual([
      'id',
      'storeId',
      'name',
      'price',
      'icon',
      'isSignature',
      'desc',
      'sortOrder',
      'createdAt',
      'updatedAt'
    ]);
    expect(indexNamesOf(after, 'StoreMenuItem')).toContain('StoreMenuItem_storeId_sortOrder_idx');

    // Store 表结构与其他既有表完全没被新迁移改动
    expect(columnsOf(after, 'Store')).toEqual(storeColumnsBefore);
    expect(columnsOf(after, 'StoreMealType')).toEqual(['id', 'storeId', 'mealType', 'createdAt', 'updatedAt']);

    // 历史 Store 行逐字段不变
    const storeAfter = after.prepare('SELECT * FROM "Store" WHERE id = ?').get(LEGACY_STORE.id) as Record<
      string,
      unknown
    >;
    expect(storeAfter).toEqual(storeBefore);
    expect(storeAfter).toMatchObject({
      name: LEGACY_STORE.name,
      address: LEGACY_STORE.address,
      cuisine: LEGACY_STORE.cuisine,
      averageCost: LEGACY_STORE.averageCost,
      rating: LEGACY_STORE.rating,
      recommendedDishes: LEGACY_STORE.recommendedDishes,
      favorite: 1,
      version: LEGACY_STORE.version,
      deletedAt: null
    });

    // 关系行保持原样
    const mealTypes = after
      .prepare('SELECT id, storeId, mealType FROM "StoreMealType" WHERE storeId = ? ORDER BY mealType')
      .all(LEGACY_STORE.id) as Array<Record<string, unknown>>;
    expect(mealTypes).toEqual([
      { id: 'legacy-smt-2', storeId: LEGACY_STORE.id, mealType: 'DINNER' },
      { id: 'legacy-smt-1', storeId: LEGACY_STORE.id, mealType: 'LUNCH' }
    ]);

    // 新迁移绝不回填假菜单：历史店铺的菜单真实为空
    const menuRowCount = after.prepare('SELECT COUNT(*) AS count FROM "StoreMenuItem"').get() as { count: number };
    expect(menuRowCount.count).toBe(0);

    const allMigrations = after
      .prepare('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name')
      .all() as Array<{ migration_name: string }>;
    expect(allMigrations.map((row) => row.migration_name)).toEqual(
      expect.arrayContaining([...EXISTING_MIGRATIONS, MENU_MIGRATION])
    );

    // 新迁移 SQL 必须是纯 DDL：不回填、不改既有行、不写死 NOT NULL 默认值
    const migrationSql = await readFile(join(workRoot, 'prisma/migrations', MENU_MIGRATION, 'migration.sql'), 'utf8');
    const migrationStatements = migrationSql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(migrationStatements).toContain('CREATE TABLE "StoreMenuItem"');
    expect(migrationStatements).toContain('CREATE INDEX "StoreMenuItem_storeId_sortOrder_idx"');
    expect(migrationStatements).not.toMatch(/ALTER\s+TABLE/i);
    // 纯 DDL：不得出现任何以 UPDATE / INSERT / DELETE 开头的语句（FK 的 ON UPDATE CASCADE 不算）
    expect(migrationStatements).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\b/im);

    after.close();
  });

  it('重复 deploy 幂等：不重复应用、不改变数据', async () => {
    const second = deployMigrations();
    expect(second.status).toBe(0);
    expect(second.output).toContain('No pending migrations to apply');

    const database = openDatabase();
    const applied = database
      .prepare(
        'SELECT migration_name, COUNT(*) AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL GROUP BY migration_name'
      )
      .all() as Array<{ migration_name: string; count: number }>;
    for (const row of applied) {
      expect(row.count).toBe(1);
    }
    const menuRowCount = database.prepare('SELECT COUNT(*) AS count FROM "StoreMenuItem"').get() as { count: number };
    expect(menuRowCount.count).toBe(0);
    database.close();
  });

  it('迁移后的库可用真实 API + Prisma 写入并读回菜单，且旧店铺字段不受影响', async () => {
    // 动态导入，确保使用的是迁移完成后、指向本临时库的 Prisma Client
    const { createPrismaClient } = await import('../src/database/client.js');
    const { registerStoreRoutes } = await import('../src/modules/stores/routes.js');
    const { registerErrorHandlers } = await import('../src/plugins/error-handler.js');
    const { runtimeValidationFastifyOptions } = await import('../src/plugins/schema-validation.js');

    const storeBeforeApi = legacyStoreRow();
    const client = createPrismaClient(databaseUrl);
    const app: FastifyInstance = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerStoreRoutes(app, client);

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/stores',
        payload: {
          name: '迁移后新店',
          menuItems: [
            { name: '迁移后甲', price: 32, icon: '🍱', isSignature: true, desc: '甲' },
            { name: '迁移后乙', price: 18, icon: '🥗', isSignature: false }
          ]
        }
      });
      expect(created.statusCode).toBe(201);
      const store = created.json().data;
      expect(store.menuItems.map((item: { name: string }) => item.name)).toEqual(['迁移后甲', '迁移后乙']);

      const rows = await client.storeMenuItem.findMany({
        where: { storeId: store.id },
        orderBy: { sortOrder: 'asc' }
      });
      expect(rows.map((row) => [row.name, row.price, row.icon, row.isSignature, row.desc, row.sortOrder])).toEqual([
        ['迁移后甲', 32, '🍱', true, '甲', 0],
        ['迁移后乙', 18, '🥗', false, null, 1]
      ]);

      // 未提供菜单的店铺读取为真实空数组
      const empty = await client.store.findUniqueOrThrow({
        where: { id: LEGACY_STORE.id },
        include: { menuItems: true }
      });
      expect(empty.menuItems).toEqual([]);

      const detail = await app.inject({ method: 'GET', url: `/api/v1/stores/${LEGACY_STORE.id}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().data).toMatchObject({
        name: LEGACY_STORE.name,
        recommendedDishes: LEGACY_STORE.recommendedDishes,
        rating: LEGACY_STORE.rating,
        favorite: true,
        version: LEGACY_STORE.version
      });
      expect(detail.json().data.menuItems).toEqual([]);
      expect(detail.json().data.mealTypes).toEqual(['DINNER', 'LUNCH']);
    } finally {
      await app.close();
      await client.$disconnect();
    }

    // 原始历史行仍逐字段不变
    expect(legacyStoreRow()).toEqual(storeBeforeApi);
  });
});
