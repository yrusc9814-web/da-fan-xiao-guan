import { spawnSync } from 'node:child_process';
import { fixtureDataRoot, prismaConfigImport } from './setup/fixture-paths.js';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Google2 菜谱正式录入字段迁移（20261001000300_google2_recipe_form_fields）兼容性证据。
 *
 * 做法：在 data/ 下的一次性临时目录里复制一份 prisma 工程（当前 schema + 已冻结的历史迁移），
 * 只应用新迁移之前的历史迁移 → seed 真实旧 Recipe / RecipeIngredient / RecipeStep 及其关系行 →
 * deploy 新迁移 → 断言：
 *   * 三张表只新增可空列，其余表与既有索引结构完全不变；
 *   * 旧行（含 img/imagePath 字段）逐字段快照不变，新增列全部为 NULL；
 *   * 再 deploy 一次幂等，不重复应用、不改变数据；
 *   * 用 `prisma migrate diff --from-migrations … --to-schema-datamodel …` 证明
 *     "迁移产物 == 当前最终 schema"，diff 为空（exit code 0）。
 *
 * 不触碰 data/app.db，不使用 db push，不修改任何已冻结的历史迁移；临时工程与临时库都在 gitignored 的 data/ 下。
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
// 20261002000000（剩余能力补齐）在本迁移之后追加：它不改动 Recipe 系列表，
// 但为了让本文件末尾“迁移产物 == 当前最终 schema”的 migrate diff 不变量继续成立，
// 临时工程必须把它一并 deploy（与 store-menu / recipe-form 测试沿用同一约定）。
const REMAINING_MIGRATION = '20261002000000_google2_remaining_capabilities';
const EXISTING_MIGRATIONS = [...LEGACY_MIGRATIONS, SHOPPING_MIGRATION, NUTRITION_MIGRATION, MENU_MIGRATION];

const NEW_COLUMNS: Array<[string, string]> = [
  ['Recipe', 'category'],
  ['RecipeIngredient', 'amountText'],
  ['RecipeStep', 'title'],
  ['RecipeStep', 'timerMinutes']
];

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

/** 比较"旧行逐字段不变"时剔除本次新增列：新列的存在与为 null 由专门断言覆盖。 */
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

const RECIPE_SNAPSHOT_TABLES = [
  'Recipe',
  'RecipeIngredient',
  'RecipeStep',
  'RecipeTag',
  'RecipeMealType',
  'RecipeMealRole',
  'RecipeTool'
];

function seedLegacyRows(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO "Recipe" (
      "id","name","imagePath","ingredientsText","cookingTimeMinutes","difficulty","spicyLevel","servings",
      "sourceNote","notes","favorite","enabledForRecommendation","version","deletedAt","createdAt","updatedAt","calories"
    ) VALUES (
      'legacy-recipe-1','旧菜谱·西红柿牛腩煲','uploads/legacy-recipe.jpg','牛腩 500g；番茄 2个；洋葱 半个',
      55,'中等',2,3,'来自旧导入','旧备注',1,1,4,NULL,'2026-08-01 08:00:00','2026-08-02 09:30:00',350
    );

    INSERT INTO "RecipeIngredient" (
      "id","recipeId","ingredientId","ingredientNameSnapshot","quantity","unit","optional","isPrimary","sortOrder",
      "createdAt","updatedAt"
    ) VALUES
      ('legacy-ri-1','legacy-recipe-1',NULL,'牛腩肉',500,'GRAM',0,1,0,'2026-08-01 08:00:00','2026-08-01 08:00:00'),
      ('legacy-ri-2','legacy-recipe-1',NULL,'自然熟番茄',2,'PIECE',0,0,1,'2026-08-01 08:00:00','2026-08-01 08:00:00'),
      ('legacy-ri-3','legacy-recipe-1',NULL,'八角生姜',NULL,NULL,1,0,2,'2026-08-01 08:00:00','2026-08-01 08:00:00');

    INSERT INTO "RecipeStep" ("id","recipeId","stepNo","content","imagePath","createdAt","updatedAt") VALUES
      ('legacy-rs-1','legacy-recipe-1',1,'牛腩切块冷水焯水，撇净浮沫。','uploads/legacy-step-1.jpg','2026-08-01 08:00:00','2026-08-01 08:00:00'),
      ('legacy-rs-2','legacy-recipe-1',2,'砂锅小火慢煨 35 分钟。',NULL,'2026-08-01 08:00:00','2026-08-01 08:00:00');

    INSERT INTO "Tag" ("id","name","type","createdAt","updatedAt") VALUES
      ('legacy-tag-1','暖胃炖菜','CUISINE','2026-08-01 08:00:00','2026-08-01 08:00:00');
    INSERT INTO "RecipeTag" ("id","recipeId","tagId","createdAt","updatedAt")
      VALUES ('legacy-rtag-1','legacy-recipe-1','legacy-tag-1','2026-08-01 08:00:00','2026-08-01 08:00:00');
    INSERT INTO "RecipeMealType" ("id","recipeId","mealType","createdAt","updatedAt")
      VALUES ('legacy-rmt-1','legacy-recipe-1','DINNER','2026-08-01 08:00:00','2026-08-01 08:00:00');
    INSERT INTO "RecipeMealRole" ("id","recipeId","mealRole","createdAt","updatedAt")
      VALUES ('legacy-rmr-1','legacy-recipe-1','MAIN','2026-08-01 08:00:00','2026-08-01 08:00:00');
    INSERT INTO "KitchenTool" ("id","name","quantity","version","createdAt","updatedAt")
      VALUES ('legacy-tool-1','铸铁炖锅',1,1,'2026-08-01 08:00:00','2026-08-01 08:00:00');
    INSERT INTO "RecipeTool" ("id","recipeId","toolId","toolNameSnapshot","required","createdAt","updatedAt")
      VALUES ('legacy-rt-1','legacy-recipe-1','legacy-tool-1','铸铁炖锅',1,'2026-08-01 08:00:00','2026-08-01 08:00:00');
  `);
}

function snapshotAllRecipeTables(): Record<string, Array<Record<string, unknown>>> {
  const database = openDatabase();
  const snapshot: Record<string, Array<Record<string, unknown>>> = {};
  for (const table of RECIPE_SNAPSHOT_TABLES) {
    snapshot[table] = snapshotOf(database, table);
  }
  database.close();
  return snapshot;
}

describe('Google2 菜谱正式字段迁移兼容性（历史库 → 新迁移）', () => {
  beforeAll(async () => {
    if (!existsSync(prismaCli)) {
      throw new Error('未找到 Prisma CLI，请先执行 npm ci / npm install');
    }
    workRoot = await mkdtemp(join(fixtureDataRoot(projectRoot), 'tmp-recipe-form-migration-'));
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

  it(
    '旧库 deploy 新迁移后只追加可空列，旧行（含 img 字段与关系行）逐字段不变且新列全 NULL',
    { timeout: 60000 },
    async () => {
      const legacyDeploy = deployMigrations();
      expect(legacyDeploy.status).toBe(0);

      const before = openDatabase();
      // 1) 旧迁移产物中确认新列不存在，然后再 seed 真实旧数据
      for (const [table, column] of NEW_COLUMNS) {
        expect(columnsOf(before, table)).not.toContain(column);
      }
      const tablesBefore = tableNames(before);
      const indexSnapshotBefore = Object.fromEntries(
        ['Recipe', 'RecipeIngredient', 'RecipeStep'].map((table) => [table, indexNamesOf(before, table)])
      );
      const columnsBefore = Object.fromEntries([...tablesBefore].map((table) => [table, columnsOf(before, table)]));
      seedLegacyRows(before);
      before.close();

      const snapshotsBefore = snapshotAllRecipeTables();

      // 2) 追加新迁移并 deploy（含后续不含 Recipe 改动的 20261002000000，保持全量迁移 == 当前 schema）
      await addMigration(RECIPE_FORM_MIGRATION);
      await addMigration(REMAINING_MIGRATION);
      const migration = deployMigrations();
      expect(migration.status).toBe(0);
      expect(migration.output).toContain(RECIPE_FORM_MIGRATION);

      // 3) 三张表只多出目标列（追加在列末尾），其余表结构/索引一字未改
      const after = openDatabase();
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
      expect(columnsOf(after, 'Recipe').at(-1)).toBe('category');
      expect(columnsOf(after, 'RecipeIngredient').at(-1)).toBe('amountText');
      expect(columnsOf(after, 'RecipeStep').slice(-2)).toEqual(['title', 'timerMinutes']);
      expect(tableNames(after)).toEqual(tablesBefore);
      for (const table of ['Recipe', 'RecipeIngredient', 'RecipeStep']) {
        expect(indexNamesOf(after, table)).toEqual(indexSnapshotBefore[table]);
      }

      // 4) 旧行逐字段快照不变（Recipe 的 imagePath、RecipeStep 的 imagePath 都在快照内）
      const snapshotsAfter: Record<string, Array<Record<string, unknown>>> = {
        Recipe: snapshotOf(after, 'Recipe'),
        RecipeIngredient: snapshotOf(after, 'RecipeIngredient'),
        RecipeStep: snapshotOf(after, 'RecipeStep'),
        RecipeTag: snapshotOf(after, 'RecipeTag'),
        RecipeMealType: snapshotOf(after, 'RecipeMealType'),
        RecipeMealRole: snapshotOf(after, 'RecipeMealRole'),
        RecipeTool: snapshotOf(after, 'RecipeTool')
      };
      for (const table of RECIPE_SNAPSHOT_TABLES) {
        // after 侧剔除本次新增列后必须与 before 完全一致（新列为 null 由第 5 步单独断言）
        expect(dropNewColumns(snapshotsAfter[table], table)).toEqual(snapshotsBefore[table]);
      }
      expect(snapshotsAfter.Recipe[0]).toMatchObject({
        name: '旧菜谱·西红柿牛腩煲',
        imagePath: 'uploads/legacy-recipe.jpg',
        calories: 350,
        version: 4,
        deletedAt: null
      });

      // 5) 新列全部为真正的 NULL，不写入任何推测性分类/用量/标题/计时
      const recipeRow = after
        .prepare('SELECT category, imagePath FROM "Recipe" WHERE id = ?')
        .get('legacy-recipe-1') as Record<string, unknown>;
      expect(recipeRow).toMatchObject({ category: null, imagePath: 'uploads/legacy-recipe.jpg' });

      const ingredientRows = after
        .prepare('SELECT id, amountText, quantity, unit FROM "RecipeIngredient" WHERE recipeId = ? ORDER BY sortOrder')
        .all('legacy-recipe-1') as Array<Record<string, unknown>>;
      expect(ingredientRows).toEqual([
        { id: 'legacy-ri-1', amountText: null, quantity: 500, unit: 'GRAM' },
        { id: 'legacy-ri-2', amountText: null, quantity: 2, unit: 'PIECE' },
        { id: 'legacy-ri-3', amountText: null, quantity: null, unit: null }
      ]);

      const stepRows = after
        .prepare(
          'SELECT id, title, timerMinutes, content, imagePath FROM "RecipeStep" WHERE recipeId = ? ORDER BY stepNo'
        )
        .all('legacy-recipe-1') as Array<Record<string, unknown>>;
      expect(stepRows).toEqual([
        {
          id: 'legacy-rs-1',
          title: null,
          timerMinutes: null,
          content: '牛腩切块冷水焯水，撇净浮沫。',
          imagePath: 'uploads/legacy-step-1.jpg'
        },
        { id: 'legacy-rs-2', title: null, timerMinutes: null, content: '砂锅小火慢煨 35 分钟。', imagePath: null }
      ]);

      const allMigrations = after
        .prepare('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name')
        .all() as Array<{ migration_name: string }>;
      expect(allMigrations.map((row) => row.migration_name)).toEqual(
        expect.arrayContaining([...EXISTING_MIGRATIONS, RECIPE_FORM_MIGRATION])
      );

      // 6) 新迁移 SQL 必须是纯 ALTER TABLE ADD COLUMN：不回填、不写 DEFAULT / NOT NULL、不做任何 DML
      const migrationSql = await readFile(
        join(workRoot, 'prisma/migrations', RECIPE_FORM_MIGRATION, 'migration.sql'),
        'utf8'
      );
      const migrationStatements = migrationSql
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      expect(migrationStatements).toContain('ALTER TABLE "Recipe" ADD COLUMN "category" TEXT;');
      expect(migrationStatements).toContain('ALTER TABLE "RecipeIngredient" ADD COLUMN "amountText" TEXT;');
      expect(migrationStatements).toContain('ALTER TABLE "RecipeStep" ADD COLUMN "title" TEXT;');
      expect(migrationStatements).toContain('ALTER TABLE "RecipeStep" ADD COLUMN "timerMinutes" INTEGER;');
      expect(migrationStatements).not.toMatch(/DEFAULT/i);
      expect(migrationStatements).not.toMatch(/NOT NULL/i);
      expect(migrationStatements).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\b/im);
      expect(migrationStatements).not.toMatch(/CREATE\s+(TABLE|INDEX)/i);

      after.close();
    }
  );

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

    const recipeRow = database
      .prepare('SELECT category, imagePath, version FROM "Recipe" WHERE id = ?')
      .get('legacy-recipe-1') as Record<string, unknown>;
    expect(recipeRow).toMatchObject({ category: null, imagePath: 'uploads/legacy-recipe.jpg', version: 4 });

    const steps = database
      .prepare('SELECT title, timerMinutes FROM "RecipeStep" WHERE recipeId = ? ORDER BY stepNo')
      .all('legacy-recipe-1') as Array<Record<string, unknown>>;
    expect(steps).toEqual([
      { title: null, timerMinutes: null },
      { title: null, timerMinutes: null }
    ]);
    database.close();
  });

  it('迁移产物与当前最终 schema 完全一致（migrate diff 为空，exit code 0）', { timeout: 60000 }, async () => {
    // 前面的断言验证目标历史阶段；当前 schema 比较前必须应用完整后续迁移链。
    await cp(migrationsSource, join(workRoot, 'prisma/migrations'), { recursive: true });
    const upgraded = deployMigrations();
    expect(upgraded.status, upgraded.output).toBe(0);
    // 迁移已全部 deploy 到临时库；把“历史迁移产物”与当前 schema.prisma datamodel 对比：
    // diff 为空即证明新增迁移 + schema.prisma 同步无漂移（不触碰正式库）
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

  it('迁移后的库可通过真实 API 写入新字段并读回，旧行不受影响', async () => {
    const { createPrismaClient } = await import('../src/database/client.js');
    const { registerRecipeRoutes } = await import('../src/modules/recipes/routes.js');
    const { registerErrorHandlers } = await import('../src/plugins/error-handler.js');
    const { runtimeValidationFastifyOptions } = await import('../src/plugins/schema-validation.js');

    const legacyBefore = snapshotOf(openDatabase(), 'Recipe');
    const client = createPrismaClient(databaseUrl);
    const app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerRecipeRoutes(app, client);

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/recipes',
        payload: {
          name: '迁移后新菜谱',
          category: '暖胃炖菜',
          ingredients: [
            { name: '洋葱', amountText: '半个' },
            { name: '八角生姜', amountText: '适量' }
          ],
          steps: [{ content: '慢炖收汁', title: '小火慢煨', timerMinutes: 35 }]
        }
      });
      expect(created.statusCode).toBe(201);
      const recipe = created.json().data;
      expect(recipe.category).toBe('暖胃炖菜');
      expect(recipe.ingredients.map((row: { amountText: string | null }) => row.amountText)).toEqual(['半个', '适量']);
      expect(recipe.steps[0]).toMatchObject({ title: '小火慢煨', timerMinutes: 35 });

      const rows = await client.recipeIngredient.findMany({
        where: { recipeId: recipe.id },
        orderBy: { sortOrder: 'asc' }
      });
      expect(rows.map((row) => [row.ingredientNameSnapshot, row.amountText, row.quantity, row.unit])).toEqual([
        ['洋葱', '半个', null, null],
        ['八角生姜', '适量', null, null]
      ]);

      // 旧菜谱经真实 API 读取：新字段为显式 null，旧字段（imagePath/calories/version）原样
      const legacyDetail = await app.inject({ method: 'GET', url: '/api/v1/recipes/legacy-recipe-1' });
      expect(legacyDetail.statusCode).toBe(200);
      expect(legacyDetail.json().data).toMatchObject({
        id: 'legacy-recipe-1',
        imagePath: 'uploads/legacy-recipe.jpg',
        calories: 350,
        version: 4,
        category: null
      });
      expect(legacyDetail.json().data.steps.map((step: { title: string | null }) => step.title)).toEqual([null, null]);
    } finally {
      await app.close();
      await client.$disconnect();
    }

    // 旧行仍然逐字段不变（按 id 取，不受新插入行影响）
    const legacyAfter = snapshotOf(openDatabase(), 'Recipe').find((row) => row.id === 'legacy-recipe-1');
    expect(legacyAfter).toEqual(legacyBefore.find((row) => row.id === 'legacy-recipe-1'));
  });
});
