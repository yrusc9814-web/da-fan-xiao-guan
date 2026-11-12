import { spawnSync } from 'node:child_process';
import { fixtureDataRoot, prismaConfigImport } from './setup/fixture-paths.js';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const source = resolve(root, 'app/server/prisma');
const cli = resolve(root, 'node_modules/prisma/build/index.js');
const legacy = [
  '20260805145000_init',
  '20260810182518_domain_core',
  '20260810190425_recipe_meal_roles',
  '20261001000000_google2_shopping_checkin',
  '20261001000100_google2_nutrition_fields',
  '20261001000200_google2_store_menu_item',
  '20261001000300_google2_recipe_form_fields',
  '20261002000000_google2_remaining_capabilities'
];
const title = '20261002000100_google2_meal_record_title';
const final = '20261002000200_deleted_item_plan_uncomplete_proof';
let work = '';
let dbPath = '';
let url = '';

async function prepare(names: string[]) {
  await cp(resolve(source, 'schema.prisma'), join(work, 'prisma/schema.prisma'));
  await cp(resolve(source, 'migrations/migration_lock.toml'), join(work, 'prisma/migrations/migration_lock.toml'));
  for (const name of names)
    await cp(resolve(source, `migrations/${name}`), join(work, `prisma/migrations/${name}`), { recursive: true });
  await writeFile(
    join(work, 'prisma.config.ts'),
    `import { defineConfig } from '${prismaConfigImport}'; export default defineConfig({schema:'prisma/schema.prisma', migrations:{path:'prisma/migrations'}, datasource:{url:'${url}'}});`
  );
}
function deploy() {
  const r = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url, NODE_ENV: 'test' }
  });
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}
function open() {
  return new DatabaseSync(dbPath);
}

describe('Google2 MealRecord.title legacy migration', () => {
  beforeAll(async () => {
    if (!existsSync(cli)) throw new Error('Prisma CLI missing');
    work = await mkdtemp(join(fixtureDataRoot(root), 'tmp-google2-title-migration-'));
    dbPath = join(work, 'legacy.db');
    url = `file:${dbPath.replaceAll('\\', '/')}`;
    await writeFile(dbPath, '');
    await prepare(legacy);
  });
  afterAll(async () => {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  });

  it('旧库真实记录/关系在 title 迁移及后续迁移后保持，title 为 NULL，无回填默认值', async () => {
    expect(deploy().status).toBe(0);
    const before = open();
    expect((before.prepare('PRAGMA table_info("MealRecord")').all() as any[]).map((x) => x.name)).not.toContain(
      'title'
    );
    before.exec(`
      INSERT INTO "Recipe" ("id","name","favorite","enabledForRecommendation","version","createdAt","updatedAt") VALUES ('legacy-title-recipe','旧菜谱',0,1,3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO "MealRecord" ("id","recordDate","mealType","sourceType","status","imagePath","rating","isNewTry","favorite","notes","version","createdAt","updatedAt") VALUES ('legacy-title-record','2046-02-01','DINNER','HOMEMADE','CONFIRMED','uploads/old.jpg',4.5,1,1,'旧备注',2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO "MealRecordItem" ("id","mealRecordId","itemType","recipeId","customName","sortOrder","createdAt","updatedAt") VALUES ('legacy-title-item','legacy-title-record','RECIPE','legacy-title-recipe',NULL,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    `);
    before.close();
    await cp(resolve(source, `migrations/${title}`), join(work, `prisma/migrations/${title}`), { recursive: true });
    await cp(resolve(source, `migrations/${final}`), join(work, `prisma/migrations/${final}`), { recursive: true });
    const deployed = deploy();
    expect(deployed.status).toBe(0);
    expect(deployed.output).toContain(title);
    const after = open();
    const row = after
      .prepare('SELECT id,recordDate,imagePath,rating,notes,version,title FROM "MealRecord" WHERE id=?')
      .get('legacy-title-record') as any;
    expect(row).toMatchObject({
      id: 'legacy-title-record',
      recordDate: '2046-02-01',
      imagePath: 'uploads/old.jpg',
      rating: 4.5,
      notes: '旧备注',
      version: 2,
      title: null
    });
    expect(
      after
        .prepare('SELECT id,mealRecordId,itemType,recipeId,customName FROM "MealRecordItem" WHERE id=?')
        .get('legacy-title-item')
    ).toMatchObject({
      id: 'legacy-title-item',
      mealRecordId: 'legacy-title-record',
      itemType: 'RECIPE',
      recipeId: 'legacy-title-recipe',
      customName: null
    });
    const sql = await readFile(join(work, `prisma/migrations/${title}/migration.sql`), 'utf8');
    expect(sql).not.toMatch(/DEFAULT|UPDATE\s+"MealRecord"|NOT NULL/i);
    after.close();
  }, 30000);
});
