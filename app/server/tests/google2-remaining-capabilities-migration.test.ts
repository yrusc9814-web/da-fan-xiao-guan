import { spawnSync } from 'node:child_process';
import { fixtureDataRoot, prismaConfigImport } from './setup/fixture-paths.js';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Google2 第二轮剩余能力迁移兼容性（20261002000000_google2_remaining_capabilities）。
 *
 * 做法：在 data/ 下的一次性临时目录里复制一份 prisma 工程（当前 schema + 已有历史迁移），
 * 只应用新迁移之前的历史迁移（基础三迁移 + 已合入的 4 个 Google2 迁移）→ seed 真实旧数据
 * （旧计划 / 旧工具 / 旧记录含关系行）→ 再 deploy 新迁移 → 断言：
 *   * 只追加可空列（列序在末尾），其余结构 / 索引 / 既有行逐字段不变；
 *   * 六个新列全部为真正的 NULL（不是 ''、不是 '[]'、不是任何推测性默认值）；
 *   * 重复 deploy 幂等；
 *   * 迁移产物与当前 schema.prisma datamodel 完全一致（migrate diff 为空）；
 *   * 迁移后的库可通过生成的 Prisma Client 读写新列；旧单图 imagePath 不变，
 *     多图为空时 photosJson 保持 NULL（读取侧回退单图，不伪造照片）。
 *
 * 不触碰 data/app.db；临时工程与临时库都在 gitignored 的 data/ 下。
 * 服务端 vitest 由 tests/setup/test-env-guard.ts 在加载任何数据库模块前强制 TEST_DATABASE_URL。
 */

const projectRoot = resolve(import.meta.dirname, '../../..');
const prismaCli = resolve(projectRoot, 'node_modules/prisma/build/index.js');
const migrationsSource = resolve(projectRoot, 'app/server/prisma/migrations');
const schemaSource = resolve(projectRoot, 'app/server/prisma/schema.prisma');

const LEGACY_MIGRATIONS = ['20260805145000_init', '20260810182518_domain_core', '20260810190425_recipe_meal_roles'];
const SHOPPING_MIGRATION = '20261001000000_google2_shopping_checkin';
const NUTRITION_MIGRATION = '20261001000100_google2_nutrition_fields';
const MENU_MIGRATION = '20261001000200_google2_store_menu_item';
const RECIPE_FORM_MIGRATION = '20261001000300_google2_recipe_form_fields';
const REMAINING_MIGRATION = '20261002000000_google2_remaining_capabilities';
const EXISTING_MIGRATIONS = [
  ...LEGACY_MIGRATIONS,
  SHOPPING_MIGRATION,
  NUTRITION_MIGRATION,
  MENU_MIGRATION,
  RECIPE_FORM_MIGRATION
];

const NEW_COLUMNS: Array<[string, string]> = [
  ['MealPlan', 'time'],
  ['MealPlan', 'title'],
  ['MealPlan', 'subtext'],
  ['MealPlan', 'icon'],
  ['KitchenTool', 'icon'],
  ['MealRecord', 'photosJson']
];

const SNAPSHOT_TABLES = ['MealPlan', 'MealPlanItem', 'KitchenTool', 'MealRecord', 'MealRecordItem'];

let workRoot: string;
let databasePath: string;
let databaseUrl: string;
let shadowDatabaseUrl: string;

async function prepareWorkspace(): Promise<void> {
  await mkdir(join(workRoot, 'prisma/migrations'), { recursive: true });
  await cp(schemaSource, join(workRoot, 'prisma/schema.prisma'));
  await cp(join(migrationsSource, 'migration_lock.toml'), join(workRoot, 'prisma/migrations/migration_lock.toml'));
  for (const name of EXISTING_MIGRATIONS) {
    await cp(join(migrationsSource, name), join(workRoot, 'prisma/migrations', name), { recursive: true });
  }
  // 临时工程用最小 prisma.config.ts 指向临时库，与仓库级 prisma.config.ts（默认 data/app.db）完全隔离
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

function runPrisma(args: string[]): { status: number; output: string } {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: workRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl, NODE_ENV: 'test' }
  });
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

const deployMigrations = () => runPrisma(['migrate', 'deploy']);

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

function snapshotOf(database: DatabaseSync, table: string, orderBy = 'id'): Array<Record<string, unknown>> {
  return database.prepare(`SELECT * FROM "${table}" ORDER BY ${orderBy}`).all() as Array<Record<string, unknown>>;
}

/** 比较“旧行逐字段不变”时剔除本次新增列：新列的存在与为 null 由专门断言覆盖。 */
function dropNewColumns(rows: Array<Record<string, unknown>>, table: string): Array<Record<string, unknown>> {
  const columns = new Set(NEW_COLUMNS.filter(([name]) => name === table).map(([, column]) => column));
  if (!columns.size) return rows;
  return rows.map((row) => {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!columns.has(key)) copy[key] = value;
    }
    return copy;
  });
}

function snapshotAll(): Record<string, Array<Record<string, unknown>>> {
  const database = openDatabase();
  const snapshot: Record<string, Array<Record<string, unknown>>> = {};
  for (const table of SNAPSHOT_TABLES) {
    snapshot[table] = snapshotOf(database, table);
  }
  database.close();
  return snapshot;
}

function seedLegacyRows(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO "MealPlan" ("id","planDate","mealType","dinerCount","status","notes","version","completedAt","deletedAt","createdAt","updatedAt")
    VALUES ('legacy-plan-1','2026-09-20','DINNER',2,'COMPLETED','旧计划备注',4,'2026-09-20 19:10:00',NULL,'2026-09-20 08:00:00','2026-09-20 19:10:00');

    INSERT INTO "MealPlanItem" ("id","mealPlanId","itemType","mealRole","recipeId","storeId","customName","sortOrder","createdAt","updatedAt")
    VALUES ('legacy-plan-item-1','legacy-plan-1','CUSTOM',NULL,NULL,NULL,'旧自定义餐',0,'2026-09-20 08:00:00','2026-09-20 08:00:00');

    INSERT INTO "KitchenTool" ("id","name","imagePath","category","quantity","status","notes","version","deletedAt","createdAt","updatedAt")
    VALUES ('legacy-tool-1','铸铁炖锅','uploads/legacy-tool.jpg','锅具',1,'状态良好','旧工具备注',3,NULL,'2026-08-01 08:00:00','2026-08-02 09:30:00');

    INSERT INTO "MealRecord" ("id","recordDate","recordTime","mealType","sourceType","status","imagePath","rating","isNewTry","favorite","notes","relatedPlanId","sourceMealPlanId","confirmedAt","version","deletedAt","createdAt","updatedAt")
    VALUES ('legacy-record-1','2026-09-20','19:05','DINNER','HOMEMADE','CONFIRMED','uploads/legacy-record.jpg',4.5,0,1,'旧记录备注','legacy-plan-1',NULL,'2026-09-20 19:05:00',2,NULL,'2026-09-20 19:05:00','2026-09-20 19:05:00');

    INSERT INTO "MealRecord" ("id","recordDate","recordTime","mealType","sourceType","status","imagePath","rating","isNewTry","favorite","notes","relatedPlanId","sourceMealPlanId","confirmedAt","version","deletedAt","createdAt","updatedAt")
    VALUES ('legacy-record-2','2026-09-21','12:40','LUNCH','TAKEOUT','CONFIRMED',NULL,3.0,1,0,'无图旧记录',NULL,NULL,'2026-09-21 12:40:00',1,NULL,'2026-09-21 12:40:00','2026-09-21 12:40:00');

    INSERT INTO "MealRecordItem" ("id","mealRecordId","itemType","mealRole","recipeId","storeId","customName","sortOrder","createdAt","updatedAt")
    VALUES ('legacy-record-item-1','legacy-record-1','CUSTOM',NULL,NULL,NULL,'旧就餐内容',0,'2026-09-20 19:05:00','2026-09-20 19:05:00');
  `);
}

describe('Google2 剩余能力迁移兼容性（历史库 → 20261002000000）', () => {
  beforeAll(async () => {
    if (!existsSync(prismaCli)) {
      throw new Error('未找到 Prisma CLI，请先执行 npm ci / npm install');
    }
    workRoot = await mkdtemp(join(fixtureDataRoot(projectRoot), 'tmp-remaining-capabilities-migration-'));
    databasePath = join(workRoot, 'legacy.db');
    databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;
    shadowDatabaseUrl = `file:${join(workRoot, 'shadow.db').replaceAll('\\', '/')}`;
    await writeFile(databasePath, '');
    await writeFile(join(workRoot, 'shadow.db'), '');
    await prepareWorkspace();
  });

  afterAll(async () => {
    // 断言中途失败时可能有未关闭的 SQLite 连接；清理失败不得掩盖真正的断言错误
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('旧库 deploy 新迁移后只追加可空列，旧行逐字段不变且新列全 NULL', { timeout: 60000 }, async () => {
    const legacyDeploy = deployMigrations();
    expect(legacyDeploy.status).toBe(0);

    const before = openDatabase();
    for (const [table, column] of NEW_COLUMNS) {
      expect(columnsOf(before, table)).not.toContain(column);
    }
    const tablesBefore = tableNames(before);
    const indexSnapshotBefore = Object.fromEntries(
      ['MealPlan', 'KitchenTool', 'MealRecord'].map((table) => [table, indexNamesOf(before, table)])
    );
    const columnsBefore = Object.fromEntries(
      [...new Set(['MealPlan', 'KitchenTool', 'MealRecord'])].map((table) => [table, columnsOf(before, table)])
    );
    seedLegacyRows(before);
    before.close();

    const snapshotsBefore = snapshotAll();

    await addMigration(REMAINING_MIGRATION);
    const migration = deployMigrations();
    expect(migration.status).toBe(0);
    expect(migration.output).toContain(REMAINING_MIGRATION);

    const after = openDatabase();

    // 1) 三张表只多出目标列（追加在列末尾），其余表结构 / 索引一字未改
    const newColumnsByTable = new Map<string, string[]>();
    for (const [table, column] of NEW_COLUMNS) {
      newColumnsByTable.set(table, [...(newColumnsByTable.get(table) ?? []), column]);
    }
    for (const [table, addedColumns] of newColumnsByTable) {
      const columns = columnsOf(after, table);
      const existingCount = columnsBefore[table].length;
      expect(columns.slice(0, existingCount)).toEqual(columnsBefore[table]);
      expect(columns.slice(existingCount)).toEqual(addedColumns);
    }
    expect(columnsOf(after, 'MealPlan').slice(-4)).toEqual(['time', 'title', 'subtext', 'icon']);
    expect(columnsOf(after, 'KitchenTool').at(-1)).toBe('icon');
    expect(columnsOf(after, 'MealRecord').at(-1)).toBe('photosJson');
    expect(tableNames(after)).toEqual(tablesBefore);
    for (const table of ['MealPlan', 'KitchenTool', 'MealRecord']) {
      expect(indexNamesOf(after, table)).toEqual(indexSnapshotBefore[table]);
    }

    // 2) 旧行逐字段快照不变（旧单图 imagePath / 旧工具版本 / 旧计划关系行都在快照内）
    const snapshotsAfter: Record<string, Array<Record<string, unknown>>> = {
      MealPlan: snapshotOf(after, 'MealPlan'),
      MealPlanItem: snapshotOf(after, 'MealPlanItem'),
      KitchenTool: snapshotOf(after, 'KitchenTool'),
      MealRecord: snapshotOf(after, 'MealRecord'),
      MealRecordItem: snapshotOf(after, 'MealRecordItem')
    };
    for (const table of SNAPSHOT_TABLES) {
      expect(dropNewColumns(snapshotsAfter[table], table)).toEqual(snapshotsBefore[table]);
    }

    // 3) 六个新列全部为真正的 NULL：不写入推测性时间/标题/副文案/图标/照片
    const planRow = after
      .prepare('SELECT id, planDate, status, notes, version, "time", title, subtext, icon FROM "MealPlan" WHERE id = ?')
      .get('legacy-plan-1') as Record<string, unknown>;
    expect(planRow).toEqual({
      id: 'legacy-plan-1',
      planDate: '2026-09-20',
      status: 'COMPLETED',
      notes: '旧计划备注',
      version: 4,
      time: null,
      title: null,
      subtext: null,
      icon: null
    });

    const toolRow = after
      .prepare('SELECT id, name, imagePath, category, version, icon FROM "KitchenTool" WHERE id = ?')
      .get('legacy-tool-1') as Record<string, unknown>;
    expect(toolRow).toEqual({
      id: 'legacy-tool-1',
      name: '铸铁炖锅',
      imagePath: 'uploads/legacy-tool.jpg',
      category: '锅具',
      version: 3,
      icon: null
    });

    const recordRows = after
      .prepare(
        'SELECT id, imagePath, rating, version, photosJson, typeof(photosJson) AS photosJsonType FROM "MealRecord" ORDER BY id'
      )
      .all() as Array<Record<string, unknown>>;
    expect(recordRows).toEqual([
      {
        id: 'legacy-record-1',
        imagePath: 'uploads/legacy-record.jpg',
        rating: 4.5,
        version: 2,
        photosJson: null,
        photosJsonType: 'null'
      },
      {
        id: 'legacy-record-2',
        imagePath: null,
        rating: 3.0,
        version: 1,
        photosJson: null,
        photosJsonType: 'null'
      }
    ]);
    // 旧单图不受影响；空多图必须是 NULL，而不是 '' / '[]' 之类的假数据
    for (const row of recordRows) {
      expect(row.photosJson).not.toBe('');
      expect(row.photosJson).not.toBe('[]');
    }

    const allMigrations = after
      .prepare('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name')
      .all() as Array<{ migration_name: string }>;
    expect(allMigrations.map((row) => row.migration_name)).toEqual(
      expect.arrayContaining([...EXISTING_MIGRATIONS, REMAINING_MIGRATION])
    );

    // 4) 新迁移 SQL 必须是纯 ALTER TABLE ADD COLUMN：不回填、不写 DEFAULT / NOT NULL、不做任何 DML
    const migrationSql = await readFile(
      join(workRoot, 'prisma/migrations', REMAINING_MIGRATION, 'migration.sql'),
      'utf8'
    );
    const migrationStatements = migrationSql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(migrationStatements).toContain('ALTER TABLE "MealPlan" ADD COLUMN "time" TEXT;');
    expect(migrationStatements).toContain('ALTER TABLE "MealPlan" ADD COLUMN "title" TEXT;');
    expect(migrationStatements).toContain('ALTER TABLE "MealPlan" ADD COLUMN "subtext" TEXT;');
    expect(migrationStatements).toContain('ALTER TABLE "MealPlan" ADD COLUMN "icon" TEXT;');
    expect(migrationStatements).toContain('ALTER TABLE "KitchenTool" ADD COLUMN "icon" TEXT;');
    expect(migrationStatements).toContain('ALTER TABLE "MealRecord" ADD COLUMN "photosJson" TEXT;');
    expect(migrationStatements).not.toMatch(/DEFAULT/i);
    expect(migrationStatements).not.toMatch(/NOT NULL/i);
    expect(migrationStatements).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\b/im);
    expect(migrationStatements).not.toMatch(/CREATE\s+(TABLE|INDEX)/i);

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

    const planRow = database
      .prepare('SELECT "time", title, subtext, icon, version FROM "MealPlan" WHERE id = ?')
      .get('legacy-plan-1') as Record<string, unknown>;
    expect(planRow).toEqual({ time: null, title: null, subtext: null, icon: null, version: 4 });

    const recordRow = database
      .prepare('SELECT photosJson, imagePath, version FROM "MealRecord" WHERE id = ?')
      .get('legacy-record-1') as Record<string, unknown>;
    expect(recordRow).toEqual({ photosJson: null, imagePath: 'uploads/legacy-record.jpg', version: 2 });
    database.close();
  });

  it('迁移产物与当前最终 schema 完全一致（migrate diff 为空，exit code 0）', { timeout: 60000 }, async () => {
    // 历史阶段断言完成后，按完整迁移链升级，才能使用当前 schema 和生成的 Client。
    await cp(migrationsSource, join(workRoot, 'prisma/migrations'), { recursive: true });
    const upgraded = deployMigrations();
    expect(upgraded.status, upgraded.output).toBe(0);
    // 把“历史迁移产物”与当前 schema.prisma datamodel 对比：diff 为空即证明新迁移 + schema 同步无漂移（不触碰正式库）
    const diff = runPrisma([
      'migrate',
      'diff',
      '--from-migrations',
      'prisma/migrations',
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--shadow-database-url',
      shadowDatabaseUrl,
      '--exit-code'
    ]);
    expect(diff.output).not.toContain('Error');
    if (diff.status !== 0) {
      throw new Error(`migrate diff 非空（exit ${diff.status}）：\n${diff.output}`);
    }
    expect(diff.status).toBe(0);
  });

  it('迁移后的库可通过 Prisma Client 读写新列；旧单图保留、空多图保持 NULL', async () => {
    const { createPrismaClient } = await import('../src/database/client.js');
    const client = createPrismaClient(databaseUrl);

    try {
      // 1) 计划新字段可写可读（真实值原样，不做默认值兜底）
      const plan = await client.mealPlan.create({
        data: {
          planDate: '2026-10-02',
          mealType: 'DINNER',
          dinerCount: 2,
          status: 'PLANNED',
          time: '18:30',
          title: '红烧肉配米饭',
          subtext: '自烹营养餐 · 预估 620 kcal',
          icon: '🍖'
        }
      });
      const planRead = await client.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
      expect(planRead).toMatchObject({
        time: '18:30',
        title: '红烧肉配米饭',
        subtext: '自烹营养餐 · 预估 620 kcal',
        icon: '🍖',
        version: 1
      });

      // 未填写时间/标题的计划保持 null（与真实输入区分）
      const planWithoutOptional = await client.mealPlan.create({
        data: { planDate: '2026-10-03', mealType: 'BREAKFAST', dinerCount: 1, status: 'PLANNED' }
      });
      expect(planWithoutOptional).toMatchObject({ time: null, title: null, subtext: null, icon: null });

      // 旧计划经 Prisma 读取：新字段显式 null，旧字段原样
      const legacyPlan = await client.mealPlan.findUniqueOrThrow({ where: { id: 'legacy-plan-1' } });
      expect(legacyPlan).toMatchObject({
        planDate: '2026-09-20',
        notes: '旧计划备注',
        version: 4,
        time: null,
        title: null,
        subtext: null,
        icon: null
      });

      // 2) 工具 icon 可写可读
      const tool = await client.kitchenTool.create({ data: { name: '迁移后新工具', icon: '🍳', quantity: 1 } });
      const toolRead = await client.kitchenTool.findUniqueOrThrow({ where: { id: tool.id } });
      expect(toolRead.icon).toBe('🍳');
      const legacyTool = await client.kitchenTool.findUniqueOrThrow({ where: { id: 'legacy-tool-1' } });
      expect(legacyTool).toMatchObject({ imagePath: 'uploads/legacy-tool.jpg', icon: null, version: 3 });

      // 3) 多图 photosJson：规范 JSON 字符串原样持久化；读取侧可解析
      const photos = ['/uploads/photo-1.jpg', '/uploads/photo-2.jpg'];
      const record = await client.mealRecord.create({
        data: {
          recordDate: '2026-10-02',
          mealType: 'DINNER',
          sourceType: 'HOMEMADE',
          status: 'CONFIRMED',
          photosJson: JSON.stringify(photos),
          imagePath: photos[0]
        }
      });
      const recordRead = await client.mealRecord.findUniqueOrThrow({ where: { id: record.id } });
      expect(recordRead.photosJson).toBe('["/uploads/photo-1.jpg","/uploads/photo-2.jpg"]');
      expect(JSON.parse(recordRead.photosJson as string)).toEqual(photos);
      expect(recordRead.imagePath).toBe(photos[0]);

      // 无照片记录：photosJson 与 imagePath 均为 NULL（不生成业务照片、不写空 JSON）
      const recordWithoutPhotos = await client.mealRecord.create({
        data: { recordDate: '2026-10-02', mealType: 'LUNCH', sourceType: 'TAKEOUT', status: 'CONFIRMED' }
      });
      expect(recordWithoutPhotos).toMatchObject({ photosJson: null, imagePath: null });

      // 旧记录经 Prisma 读取：photosJson 保持 NULL，旧单图/评分/版本不变
      const legacyRecord = await client.mealRecord.findUniqueOrThrow({ where: { id: 'legacy-record-1' } });
      expect(legacyRecord).toMatchObject({
        imagePath: 'uploads/legacy-record.jpg',
        photosJson: null,
        rating: 4.5,
        version: 2
      });

      // 4) 库内不存在被写成 '' / '[]' 的 photosJson
      const fakeEmpty = await client.mealRecord.count({
        where: { OR: [{ photosJson: '' }, { photosJson: '[]' }] }
      });
      expect(fakeEmpty).toBe(0);
    } finally {
      await client.$disconnect();
    }
  });
});
