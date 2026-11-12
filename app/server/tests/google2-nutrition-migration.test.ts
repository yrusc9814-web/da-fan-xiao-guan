import { spawnSync } from 'node:child_process';
import { fixtureDataRoot, prismaConfigImport } from './setup/fixture-paths.js';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 迁移兼容性证据：不复用测试库，也不使用 db push。
 *
 * 做法：在临时目录里复制一份 prisma 工程（schema + 历史 migrations），
 * 只应用 20261001000000 之前的历史迁移 → seed 旧记录/旧菜谱 → 再 deploy 全量迁移，
 * 断言四列全部为 NULL 且旧数据保留；最后再 deploy 一次验证幂等。
 *
 * 这里不触碰 data/app.db；临时工程与临时库都建在 data/ 下的一次性目录（gitignored），
 * 以便 Prisma CLI 能沿目录向上解析仓库 node_modules 里的 prisma/config。
 */

const projectRoot = resolve(import.meta.dirname, '../../..');
const prismaCli = resolve(projectRoot, 'node_modules/prisma/build/index.js');
const migrationsSource = resolve(projectRoot, 'app/server/prisma/migrations');
const schemaSource = resolve(projectRoot, 'app/server/prisma/schema.prisma');

const LEGACY_MIGRATIONS = ['20260805145000_init', '20260810182518_domain_core', '20260810190425_recipe_meal_roles'];
const SHOPPING_MIGRATION = '20261001000000_google2_shopping_checkin';
const NUTRITION_MIGRATION = '20261001000100_google2_nutrition_fields';

let workRoot: string;
let databasePath: string;
let databaseUrl: string;

async function prepareWorkspace(migrationNames: string[]): Promise<void> {
  await mkdir(join(workRoot, 'prisma/migrations'), { recursive: true });
  await cp(schemaSource, join(workRoot, 'prisma/schema.prisma'));
  await cp(join(migrationsSource, 'migration_lock.toml'), join(workRoot, 'prisma/migrations/migration_lock.toml'));
  for (const name of migrationNames) {
    await cp(join(migrationsSource, name), join(workRoot, 'prisma/migrations', name), { recursive: true });
  }
  // Prisma CLI 在自己的项目根目录里跑，用最小 prisma.config.ts 指向临时库，
  // 从而与仓库级 prisma.config.ts（默认指向 data/app.db）完全隔离。
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
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: workRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl, NODE_ENV: 'test' }
  });
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

function openDatabase(): DatabaseSync {
  return new DatabaseSync(databasePath);
}

function columnsOf(database: DatabaseSync, table: string): string[] {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

async function addMigration(name: string): Promise<void> {
  await cp(join(migrationsSource, name), join(workRoot, 'prisma/migrations', name), { recursive: true });
}

describe('Google2 营养字段迁移兼容性（历史库 → 新迁移）', () => {
  beforeAll(async () => {
    if (!existsSync(prismaCli)) {
      throw new Error('未找到 Prisma CLI，请先执行 npm ci / npm install');
    }
    workRoot = await mkdtemp(join(fixtureDataRoot(projectRoot), 'tmp-nutrition-migration-'));
    databasePath = join(workRoot, 'legacy.db');
    databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;
    await writeFile(databasePath, '');
    await prepareWorkspace(LEGACY_MIGRATIONS);
  });

  afterAll(async () => {
    // 断言中途失败时可能有未关闭的 SQLite 连接，清理失败不应掩盖真正的断言错误
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('旧迁移库中不存在新列，deploy 后四列均为 NULL 且旧数据完整保留', { timeout: 60000 }, async () => {
    const legacyDeploy = deployMigrations();
    expect(legacyDeploy.status).toBe(0);

    // 1) 应用旧迁移后，seed 真实旧数据（含关系与 marker）
    const before = openDatabase();
    expect(columnsOf(before, 'MealRecord')).not.toContain('satiety');
    expect(columnsOf(before, 'MealRecord')).not.toContain('calories');
    expect(columnsOf(before, 'MealRecord')).not.toContain('cost');
    expect(columnsOf(before, 'Recipe')).not.toContain('calories');

    before.exec(`
      INSERT INTO "MealPlan" ("id","planDate","mealType","dinerCount","status","notes","version","createdAt","updatedAt")
      VALUES ('legacy-plan-1','2026-09-20','LUNCH',2,'COMPLETED','旧计划',4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

      INSERT INTO "Recipe" ("id","name","favorite","enabledForRecommendation","version","createdAt","updatedAt")
      VALUES ('legacy-recipe-1','旧菜谱',0,1,3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

      INSERT INTO "RecipeIngredient" ("id","recipeId","ingredientNameSnapshot","optional","isPrimary","sortOrder","createdAt","updatedAt")
      VALUES ('legacy-ri-1','legacy-recipe-1','旧食材',0,1,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

      INSERT INTO "MealRecord" ("id","recordDate","recordTime","mealType","sourceType","status","imagePath","rating","isNewTry","favorite","notes","relatedPlanId","sourceMealPlanId","confirmedAt","version","deletedAt","createdAt","updatedAt")
      VALUES ('legacy-record-1','2026-09-20','12:30','LUNCH','HOMEMADE','CONFIRMED','uploads/legacy.jpg',4.5,1,1,'旧记录备注','legacy-plan-1',NULL,CURRENT_TIMESTAMP,2,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

      INSERT INTO "MealRecordItem" ("id","mealRecordId","itemType","recipeId","customName","sortOrder","createdAt","updatedAt")
      VALUES ('legacy-mri-1','legacy-record-1','RECIPE','legacy-recipe-1',NULL,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    `);
    before.close();

    // 2) 追加新迁移并 deploy
    await addMigration(SHOPPING_MIGRATION);
    await addMigration(NUTRITION_MIGRATION);
    const migration = deployMigrations();
    expect(migration.status).toBe(0);
    expect(migration.output).toContain(NUTRITION_MIGRATION);

    // 3) 新列存在、全部为 NULL，旧字段与关系一字未改
    const after = openDatabase();
    const recordColumns = columnsOf(after, 'MealRecord');
    expect(recordColumns).toEqual(expect.arrayContaining(['satiety', 'calories', 'cost']));
    expect(columnsOf(after, 'Recipe')).toContain('calories');

    const recordRow = after
      .prepare(
        'SELECT id, recordDate, recordTime, mealType, sourceType, status, imagePath, rating, isNewTry, favorite, notes, relatedPlanId, sourceMealPlanId, version, satiety, calories, cost FROM "MealRecord" WHERE id = ?'
      )
      .get('legacy-record-1') as Record<string, unknown>;
    expect(recordRow).toMatchObject({
      recordDate: '2026-09-20',
      recordTime: '12:30',
      mealType: 'LUNCH',
      sourceType: 'HOMEMADE',
      status: 'CONFIRMED',
      imagePath: 'uploads/legacy.jpg',
      rating: 4.5,
      isNewTry: 1,
      favorite: 1,
      notes: '旧记录备注',
      relatedPlanId: 'legacy-plan-1',
      sourceMealPlanId: null,
      version: 2,
      satiety: null,
      calories: null,
      cost: null
    });

    const recipeRow = after
      .prepare('SELECT id, name, version, favorite, calories FROM "Recipe" WHERE id = ?')
      .get('legacy-recipe-1') as Record<string, unknown>;
    expect(recipeRow).toMatchObject({ name: '旧菜谱', version: 3, favorite: 0, calories: null });

    const planRow = after
      .prepare('SELECT id, planDate, status, dinerCount, notes, version FROM "MealPlan" WHERE id = ?')
      .get('legacy-plan-1') as Record<string, unknown>;
    expect(planRow).toMatchObject({
      planDate: '2026-09-20',
      status: 'COMPLETED',
      dinerCount: 2,
      notes: '旧计划',
      version: 4
    });

    const itemRow = after
      .prepare('SELECT id, mealRecordId, itemType, recipeId, sortOrder FROM "MealRecordItem" WHERE id = ?')
      .get('legacy-mri-1') as Record<string, unknown>;
    expect(itemRow).toMatchObject({
      mealRecordId: 'legacy-record-1',
      itemType: 'RECIPE',
      recipeId: 'legacy-recipe-1',
      sortOrder: 0
    });

    const allMigrations = after
      .prepare('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name')
      .all() as Array<{ migration_name: string }>;
    expect(allMigrations.map((row) => row.migration_name)).toEqual(
      expect.arrayContaining([...LEGACY_MIGRATIONS, SHOPPING_MIGRATION, NUTRITION_MIGRATION])
    );

    // 4) 新迁移 SQL 不得偷偷回填默认值：注释行不计入，只看实际 DDL/DML 语句
    const migrationSql = await readFile(
      join(workRoot, 'prisma/migrations', NUTRITION_MIGRATION, 'migration.sql'),
      'utf8'
    );
    const migrationStatements = migrationSql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    for (const column of ['satiety', 'calories', 'cost']) {
      expect(migrationStatements).toContain(`ALTER TABLE "MealRecord" ADD COLUMN "${column}" INTEGER;`);
    }
    expect(migrationStatements).toContain('ALTER TABLE "Recipe" ADD COLUMN "calories" INTEGER;');
    expect(migrationStatements).not.toMatch(/DEFAULT/i);
    expect(migrationStatements).not.toMatch(/NOT NULL/i);
    expect(migrationStatements).not.toMatch(/UPDATE\s+"(?:MealRecord|Recipe)"/i);

    after.close();
  });

  it('重复 deploy 幂等：再次执行不报错、不重复应用、不改变数据', async () => {
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

    const row = database
      .prepare('SELECT satiety, calories, cost, version FROM "MealRecord" WHERE id = ?')
      .get('legacy-record-1') as Record<string, unknown>;
    expect(row).toMatchObject({ satiety: null, calories: null, cost: null, version: 2 });
    database.close();
  });

  it('新迁移之后写入的真实值可持久化，且与 NULL 语义区分', async () => {
    const database = openDatabase();
    database.exec(`
      INSERT INTO "MealRecord" ("id","recordDate","mealType","sourceType","status","isNewTry","favorite","version","satiety","calories","cost","createdAt","updatedAt")
      VALUES ('new-record-1','2026-10-01','DINNER','TAKEOUT','CONFIRMED',0,0,1,8,550,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    `);
    const row = database
      .prepare('SELECT satiety, calories, cost FROM "MealRecord" WHERE id = ?')
      .get('new-record-1') as Record<string, unknown>;
    // cost = 0 是真实输入值，必须与 NULL 区分
    expect(row).toMatchObject({ satiety: 8, calories: 550, cost: 0 });
    database.close();
  });
});
