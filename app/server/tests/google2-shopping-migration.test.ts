import { spawnSync } from 'node:child_process';
import { prismaConfigImport } from './setup/fixture-paths.js';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * VAN-31 购物清单入库迁移（20261001000000_google2_shopping_checkin）兼容性证据。
 *
 * 做法：在 os.tmpdir() 下的一次性临时目录里复制一份 prisma 工程（schema + 已冻结的历史迁移），
 * 只应用新迁移之前的历史迁移 → 写入真实旧购物清单/ShoppingListItem 记录 →
 * deploy 新版迁移 → 断言新表存在、旧记录一字未改；最后再 deploy 一次验证幂等。
 *
 * 不触碰 data/app.db，也不修改任何已冻结的历史迁移文件。
 */

const projectRoot = resolve(import.meta.dirname, '../../..');
const prismaCli = resolve(projectRoot, 'node_modules/prisma/build/index.js');
const migrationsSource = resolve(projectRoot, 'app/server/prisma/migrations');
const schemaSource = resolve(projectRoot, 'app/server/prisma/schema.prisma');

const LEGACY_MIGRATIONS = ['20260805145000_init', '20260810182518_domain_core', '20260810190425_recipe_meal_roles'];
const SHOPPING_MIGRATION = '20261001000000_google2_shopping_checkin';

let workRoot: string;
let databasePath: string;
let databaseUrl: string;

async function prepareWorkspace(): Promise<void> {
  await mkdir(join(workRoot, 'prisma/migrations'), { recursive: true });
  await cp(schemaSource, join(workRoot, 'prisma/schema.prisma'));
  await cp(join(migrationsSource, 'migration_lock.toml'), join(workRoot, 'prisma/migrations/migration_lock.toml'));
  for (const name of LEGACY_MIGRATIONS) {
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    DAFAN_DATABASE_PATH: databasePath
  };
  // 临时迁移工程不得继承父进程隔离根/基线开关，必须只由本文件的临时库决定行为
  delete env.DAFAN_ISOLATION_ROOT;
  delete env.DAFAN_FORWARD_BASELINE;
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: workRoot,
    encoding: 'utf8',
    env
  });
  console.info(`migration deploy: ${Math.round(performance.now() - started)}ms, exit=${result.status}`);
  console.info(result.stdout);
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

const openDatabase = () => new DatabaseSync(databasePath);

function tableNames(database: DatabaseSync): string[] {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

function columnsOf(database: DatabaseSync, table: string): string[] {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('VAN-31 购物清单入库迁移兼容性（历史库 → 新迁移）', () => {
  beforeAll(async () => {
    if (!existsSync(prismaCli)) {
      throw new Error('未找到 Prisma CLI，请先执行 npm ci / npm install');
    }
    workRoot = await mkdtemp(join(tmpdir(), 'dafan-van31-migration-'));
    databasePath = join(workRoot, 'legacy.db');
    databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;
    await writeFile(databasePath, '');
    await prepareWorkspace();
  });

  afterAll(async () => {
    // 断言中途失败时可能仍有未关闭的 SQLite 连接；Windows 上目录可能短暂被占用，
    // 因此做有限次退避重试。清理失败必须显式失败，不能静默放过临时库残留。
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(workRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error(`临时迁移目录清理失败：${workRoot}`, { cause: lastError });
  });

  // 两次真实 Prisma CLI deploy 的启动/迁移耗时合计接近或超过默认 5 秒。
  it('旧 schema 库迁移到新版本：新表建立、旧清单/项目/食材记录完整保留', { timeout: 60000 }, async () => {
    const legacyDeploy = deployMigrations();
    expect(legacyDeploy.status).toBe(0);

    const before = openDatabase();
    expect(tableNames(before)).not.toContain('ShoppingCheckinOperation');

    // seed 真实旧业务数据：一个已使用过的购物清单 + 已完成/未完成项目 + 关联食材
    before.exec(`
      INSERT INTO "Ingredient" ("id","name","quantity","unit","version","createdAt","updatedAt")
      VALUES ('legacy-ing-1','旧米',100,'GRAM',3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

      INSERT INTO "ShoppingList" ("id","name","status","notes","version","createdAt","updatedAt")
      VALUES ('legacy-list-1','旧采购清单','ACTIVE','旧备注',5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

      INSERT INTO "ShoppingListItem" ("id","shoppingListId","ingredientId","ingredientNameSnapshot","quantity","unit","sourceType","completed","sortOrder","createdAt","updatedAt")
      VALUES ('legacy-item-1','legacy-list-1','legacy-ing-1','旧米',500,'GRAM','MANUAL',1,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

      INSERT INTO "ShoppingListItem" ("id","shoppingListId","ingredientId","ingredientNameSnapshot","quantity","unit","sourceType","completed","sortOrder","createdAt","updatedAt")
      VALUES ('legacy-item-2','legacy-list-1',NULL,'旧鸡蛋',6,'PIECE','MANUAL',0,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    `);
    before.close();

    await cp(join(migrationsSource, SHOPPING_MIGRATION), join(workRoot, 'prisma/migrations', SHOPPING_MIGRATION), {
      recursive: true
    });
    const migration = deployMigrations();
    expect(migration.status).toBe(0);
    expect(migration.output).toContain(SHOPPING_MIGRATION);

    const after = openDatabase();
    expect(tableNames(after)).toContain('ShoppingCheckinOperation');
    expect(columnsOf(after, 'ShoppingCheckinOperation')).toEqual([
      'id',
      'shoppingListId',
      'payloadHash',
      'resultJson',
      'createdAt'
    ]);

    const list = after
      .prepare('SELECT id, name, status, notes, version FROM "ShoppingList" WHERE id = ?')
      .get('legacy-list-1') as Record<string, unknown>;
    expect(list).toMatchObject({
      id: 'legacy-list-1',
      name: '旧采购清单',
      status: 'ACTIVE',
      notes: '旧备注',
      version: 5
    });

    const items = after
      .prepare(
        'SELECT id, shoppingListId, ingredientId, ingredientNameSnapshot, quantity, unit, sourceType, completed, sortOrder FROM "ShoppingListItem" WHERE shoppingListId = ? ORDER BY sortOrder'
      )
      .all('legacy-list-1') as Array<Record<string, unknown>>;
    expect(items).toEqual([
      {
        id: 'legacy-item-1',
        shoppingListId: 'legacy-list-1',
        ingredientId: 'legacy-ing-1',
        ingredientNameSnapshot: '旧米',
        quantity: 500,
        unit: 'GRAM',
        sourceType: 'MANUAL',
        completed: 1,
        sortOrder: 0
      },
      {
        id: 'legacy-item-2',
        shoppingListId: 'legacy-list-1',
        ingredientId: null,
        ingredientNameSnapshot: '旧鸡蛋',
        quantity: 6,
        unit: 'PIECE',
        sourceType: 'MANUAL',
        completed: 0,
        sortOrder: 1
      }
    ]);

    const ingredient = after
      .prepare('SELECT name, quantity, unit, version FROM "Ingredient" WHERE id = ?')
      .get('legacy-ing-1') as Record<string, unknown>;
    expect(ingredient).toMatchObject({ name: '旧米', quantity: 100, unit: 'GRAM', version: 3 });

    const applied = after
      .prepare('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name')
      .all() as Array<{ migration_name: string }>;
    expect(applied.map((row) => row.migration_name)).toEqual(
      expect.arrayContaining([...LEGACY_MIGRATIONS, SHOPPING_MIGRATION])
    );

    // 新迁移 SQL 只能建表/建索引，不得回填或修改既有业务数据
    const migrationSql = await readFile(
      join(workRoot, 'prisma/migrations', SHOPPING_MIGRATION, 'migration.sql'),
      'utf8'
    );
    const statements = migrationSql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).toContain('CREATE TABLE "ShoppingCheckinOperation"');
    expect(statements).toMatch(/CREATE (?:UNIQUE )?INDEX/);
    expect(statements).not.toMatch(/ALTER TABLE/i);
    expect(statements).not.toMatch(/UPDATE\s+"/i);
    expect(statements).not.toMatch(/INSERT INTO/i);
    after.close();
  });

  it('重复 deploy 幂等：不报错、不重复应用、旧记录不变', async () => {
    const second = deployMigrations();
    expect(second.status).toBe(0);
    expect(second.output).toContain('No pending migrations to apply');

    const database = openDatabase();
    const applied = database
      .prepare(
        'SELECT migration_name, COUNT(*) AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL GROUP BY migration_name'
      )
      .all() as Array<{ migration_name: string; count: number }>;
    expect(applied.length).toBeGreaterThan(0);
    for (const row of applied) expect(row.count).toBe(1);

    expect(
      database.prepare('SELECT COUNT(*) AS count FROM "ShoppingCheckinOperation"').get() as { count: number }
    ).toMatchObject({ count: 0 });
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM "ShoppingListItem" WHERE shoppingListId = ?').get('legacy-list-1')
    ).toMatchObject({ count: 2 });
    database.close();
  });

  it('新表按 operationId 主键持久化结果，可在原记录之上真实复用（幂等重放的数据基础）', async () => {
    const database = openDatabase();
    database.exec(`
      INSERT INTO "ShoppingCheckinOperation" ("id","shoppingListId","payloadHash","resultJson","createdAt")
      VALUES ('legacy-op-1','legacy-list-1','hash-a','{"version":6}','2026-10-01T00:00:00Z');
    `);
    const operation = database
      .prepare('SELECT id, shoppingListId, payloadHash, resultJson FROM "ShoppingCheckinOperation" WHERE id = ?')
      .get('legacy-op-1') as Record<string, unknown>;
    expect(operation).toMatchObject({
      id: 'legacy-op-1',
      shoppingListId: 'legacy-list-1',
      payloadHash: 'hash-a',
      resultJson: '{"version":6}'
    });

    const indexes = database.prepare('PRAGMA index_list("ShoppingCheckinOperation")').all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain('ShoppingCheckinOperation_shoppingListId_createdAt_idx');
    database.close();
  });
});
