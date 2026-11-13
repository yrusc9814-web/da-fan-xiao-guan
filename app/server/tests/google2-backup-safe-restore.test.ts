import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ZipArchive } from 'archiver';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { createTestPrismaClient } from '../src/database/test-database.js';
import {
  filePathFromDatabaseUrl,
  resolveDatabaseUrl,
  resolveRestoreTempDirectory,
  resolveUploadsDirectory
} from '../src/database/paths.js';
import { createBackup, restoreBackup } from '../src/modules/backup/service.js';
import { endMaintenance, maintenanceState } from '../src/plugins/maintenance.js';
import { fixtureDirectory, prismaConfigImport } from './setup/fixture-paths.js';

const projectRoot = resolve(import.meta.dirname, '../../..');
const migrationsDirectory = resolve(projectRoot, 'app/server/prisma/migrations');
const prismaCli = resolve(projectRoot, 'node_modules/prisma/build/index.js');
// 旧库只部署到 google2_remaining_capabilities，缺少 title 与 plan-uncomplete-proof 两个后续迁移。
const legacyMigrations = [
  '20260805145000_init',
  '20260810182518_domain_core',
  '20260810190425_recipe_meal_roles',
  '20261001000000_google2_shopping_checkin',
  '20261001000100_google2_nutrition_fields',
  '20261001000200_google2_store_menu_item',
  '20261001000300_google2_recipe_form_fields',
  '20261002000000_google2_remaining_capabilities'
];

const database = createTestPrismaClient();
let app: Awaited<ReturnType<typeof buildApp>>;

function databaseFilePath(): string {
  const path = filePathFromDatabaseUrl(resolveDatabaseUrl());
  if (!path) throw new Error('test database must be a local SQLite file');
  return path;
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function localMigrationNames(): Promise<string[]> {
  return (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function createZip(path: string, entries: Array<{ name: string; content: Buffer }>): Promise<void> {
  const output = createWriteStream(path);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.pipe(output);
  for (const entry of entries) archive.append(entry.content, { name: entry.name });
  await archive.finalize();
  await new Promise<void>((resolveOutput, rejectOutput) => {
    output.on('close', resolveOutput);
    output.on('error', rejectOutput);
  });
}

function manifestFor(files: Array<{ path: string; content: Buffer }>) {
  return {
    backupVersion: 1,
    appVersion: '1.0.0',
    createdAt: new Date().toISOString(),
    files: files.map((file) => ({ path: file.path, size: file.content.byteLength, sha256: sha256(file.content) }))
  };
}

async function writeBackupZip(zipPath: string, databaseContent: Buffer): Promise<void> {
  const files = [
    { path: 'app.db', content: databaseContent },
    {
      path: 'config.json',
      content: Buffer.from(
        JSON.stringify(
          {
            appName: '搭饭小馆',
            subtitle: '安全恢复集成测试',
            defaultPort: 8787,
            autoBackupEnabled: false,
            createdAt: new Date().toISOString()
          },
          null,
          2
        )
      )
    }
  ];
  await createZip(zipPath, [
    ...files.map((file) => ({ name: file.path, content: file.content })),
    { name: 'backup-manifest.json', content: Buffer.from(JSON.stringify(manifestFor(files), null, 2)) }
  ]);
}

function multipartPayload(boundary: string, filename: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

async function uploadRestore(zip: Buffer, token: string) {
  const boundary = `----dafan-restore-${randomUUID()}`;
  return app.inject({
    method: 'POST',
    url: '/api/v1/backups/restore',
    headers: { 'x-high-risk-token': token, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipartPayload(boundary, 'backup.zip', zip)
  });
}

async function authorizeRestore(): Promise<string> {
  const challenge = await app.inject({
    method: 'POST',
    url: '/api/v1/settings/high-risk/authorize',
    payload: { action: 'RESTORE' }
  });
  expect(challenge.statusCode).toBe(200);
  const authorized = await app.inject({
    method: 'POST',
    url: '/api/v1/settings/high-risk/authorize',
    payload: {
      action: 'RESTORE',
      challenge: challenge.json().data.challenge,
      confirmation: 'RESTORE_LOCAL_DATA'
    }
  });
  expect(authorized.statusCode).toBe(200);
  return authorized.json().data.token as string;
}

async function uploadsTree(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const absolute = join(directory, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(absolute, key);
      else if (entry.isFile()) result[key] = sha256(await readFile(absolute));
    }
  }
  await walk(resolveUploadsDirectory(), '');
  return result;
}

async function rollbackDirectories(): Promise<string[]> {
  return (await readdir(resolveRestoreTempDirectory()).catch(() => []))
    .filter((name) => name.startsWith('.rollback-'))
    .sort();
}

type RestoreSnapshot = { directory: string; databasePath: string };

/**
 * AC5 的清理必须无条件执行：逐项尝试并收集错误，保证 spy 还原、测试库重连、本次新增
 * .rollback-* 删除（列差集，最多一个且必须是 .rollback- 前缀）、维护态结束互不阻塞。
 */
async function cleanupAc5Artifacts(options: {
  spy: { mockRestore: () => void };
  snapshot: RestoreSnapshot;
  beforeRollbacks: string[];
  uploadPath: string;
  recipeId: string;
  backup: { cleanup: () => Promise<void> };
}): Promise<string[]> {
  const errors: string[] = [];
  const attempt = async (label: string, action: () => unknown): Promise<void> => {
    try {
      await action();
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await attempt('spy', () => options.spy.mockRestore());
  await attempt('snapshot', () => restoreSnapshot(options.snapshot));
  await attempt('reconnect', () => database.$connect());
  await attempt('rollback', async () => {
    const created = (await rollbackDirectories()).filter((name) => !options.beforeRollbacks.includes(name));
    if (created.length > 1) throw new Error(`残留多个回滚目录：${created.join(', ')}`);
    for (const name of created) {
      if (!name.startsWith('.rollback-')) throw new Error(`拒绝删除非回滚目录：${name}`);
      await rm(join(resolveRestoreTempDirectory(), name), { recursive: true, force: true });
    }
  });
  await attempt('backup', () => options.backup.cleanup());
  await attempt('upload', () => rm(options.uploadPath, { force: true }));
  await attempt('recipe', () => database.recipe.deleteMany({ where: { id: options.recipeId } }));
  await attempt('maintenance', () => endMaintenance());
  return errors;
}

async function snapshotStorage(): Promise<RestoreSnapshot> {
  const directory = await mkdtemp(join(fixtureDirectory(), 'restore-snapshot-'));
  const databasePath = databaseFilePath();
  await database.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
  await database.$disconnect();
  try {
    await copyFile(databasePath, join(directory, 'app.db'));
    await cp(resolveUploadsDirectory(), join(directory, 'uploads'), { recursive: true });
  } finally {
    await database.$connect();
  }
  return { directory, databasePath };
}

async function restoreSnapshot(snapshot: { directory: string; databasePath: string }): Promise<void> {
  await database.$disconnect().catch(() => undefined);
  for (const suffix of ['-wal', '-shm']) await rm(`${snapshot.databasePath}${suffix}`, { force: true });
  await copyFile(join(snapshot.directory, 'app.db'), snapshot.databasePath);
  const uploads = resolveUploadsDirectory();
  await rm(uploads, { recursive: true, force: true });
  await cp(join(snapshot.directory, 'uploads'), uploads, { recursive: true });
  await database.$connect();
  await rm(snapshot.directory, { recursive: true, force: true });
}

async function prepareLegacyDatabase(work: string, url: string): Promise<void> {
  await mkdir(join(work, 'prisma/migrations'), { recursive: true });
  await cp(resolve(projectRoot, 'app/server/prisma/schema.prisma'), join(work, 'prisma/schema.prisma'));
  await cp(
    resolve(projectRoot, 'app/server/prisma/migrations/migration_lock.toml'),
    join(work, 'prisma/migrations/migration_lock.toml')
  );
  for (const name of legacyMigrations)
    await cp(resolve(migrationsDirectory, name), join(work, 'prisma/migrations', name), { recursive: true });
  await writeFile(
    join(work, 'prisma.config.ts'),
    `import { defineConfig } from '${prismaConfigImport}'; export default defineConfig({schema:'prisma/schema.prisma', migrations:{path:'prisma/migrations'}, datasource:{url:'${url}'}});`
  );
}

function deployLegacyDatabase(work: string, url: string): { status: number; output: string } {
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: url, TEST_DATABASE_URL: url }
  });
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

async function createMigrationDatabase(
  path: string,
  rows: Array<{ name: string; finished: boolean }>
): Promise<Buffer> {
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(`CREATE TABLE "_prisma_migrations" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
    );`);
    const insert = legacy.prepare(
      `INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count") VALUES (?,?,?,?,NULL,NULL,CURRENT_TIMESTAMP,1)`
    );
    for (const row of rows) insert.run(randomUUID(), 'checksum', row.finished ? '2026-01-01 00:00:00' : null, row.name);
  } finally {
    legacy.close();
  }
  return readFile(path);
}

async function createDatabaseWithoutMigrationTable(path: string): Promise<Buffer> {
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec('CREATE TABLE "Unrelated" ("id" TEXT NOT NULL PRIMARY KEY);');
  } finally {
    legacy.close();
  }
  return readFile(path);
}

describe('备份安全恢复集成', () => {
  beforeAll(async () => {
    await database.$connect();
    await database.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    await database.settings.updateMany({ where: { id: 1 }, data: { pinEnabled: false, pinHash: null } });
    app = await buildApp({ database, logger: false });
  });
  afterEach(() => {
    endMaintenance();
  });
  // restoreBackup 失败路径会主动断开连接，保证每个用例起点可查询且不依赖前序用例的连接状态。
  beforeEach(async () => {
    await database.$connect();
  });
  afterAll(async () => {
    endMaintenance();
    try {
      await database.settings.updateMany({
        where: { id: 1 },
        data: { pinEnabled: false, pinHash: null, version: { increment: 1 } }
      });
    } finally {
      try {
        await app?.close();
      } finally {
        await database.$disconnect();
      }
    }
  });

  it('AC1 导出后修改记录与 uploads 文件，restoreBackup 完整恢复两者；默认 uploads 在临时盘而数据库与暂存区在数据盘', async () => {
    const uploads = resolveUploadsDirectory();
    const databasePath = databaseFilePath();
    const staging = resolveRestoreTempDirectory();
    const dataDirectory = resolve(projectRoot, 'data');

    expect(uploads.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase())).toBe(true);
    expect(databasePath.toLowerCase().startsWith(dataDirectory.toLowerCase())).toBe(true);
    expect(staging.toLowerCase()).toBe(dataDirectory.toLowerCase());
    expect(parse(uploads).root.toLowerCase()).not.toBe(parse(databasePath).root.toLowerCase());

    const uploadPath = join(uploads, 'ac1-restore-original.png');
    const recipe = await database.recipe.create({ data: { name: 'AC1 备份前名称' } });
    await writeFile(uploadPath, 'ac1-before');
    const backup = await createBackup(database);
    try {
      await database.recipe.update({ where: { id: recipe.id }, data: { name: 'AC1 备份后修改' } });
      await database.recipe.create({ data: { name: 'AC1 备份后新增' } });
      await writeFile(uploadPath, 'ac1-after');

      await restoreBackup(database, backup.zipPath);

      expect((await database.recipe.findUniqueOrThrow({ where: { id: recipe.id } })).name).toBe('AC1 备份前名称');
      expect(await database.recipe.count({ where: { name: 'AC1 备份后新增' } })).toBe(0);
      expect(await readFile(uploadPath, 'utf8')).toBe('ac1-before');
      expect(maintenanceState().active).toBe(false);
    } finally {
      await backup.cleanup();
      await rm(uploadPath, { force: true });
      await database.recipe.deleteMany({ where: { id: recipe.id } });
    }
  });

  it('AC2 子集历史迁移建立的旧库随 ZIP 恢复时自动 migrate deploy，旧业务数据无损且全部当前迁移完成', async () => {
    const work = await mkdtemp(join(fixtureDirectory(), 'ac2-legacy-'));
    const legacyPath = join(work, 'legacy.db');
    const url = `file:${legacyPath.replaceAll('\\', '/')}`;
    const zipPath = join(work, 'legacy-backup.zip');
    const snapshot = await snapshotStorage();
    try {
      await writeFile(legacyPath, '');
      await prepareLegacyDatabase(work, url);
      const deployed = deployLegacyDatabase(work, url);
      expect(deployed.status, deployed.output).toBe(0);

      const legacy = new DatabaseSync(legacyPath);
      try {
        const columns = (legacy.prepare('PRAGMA table_info("MealRecord")').all() as Array<{ name: string }>).map(
          (column) => column.name
        );
        expect(columns).not.toContain('title');
        legacy.exec(`
          INSERT INTO "Recipe" ("id","name","favorite","enabledForRecommendation","version","createdAt","updatedAt") VALUES ('ac2-recipe','AC2 旧菜谱',0,1,4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
          INSERT INTO "MealRecord" ("id","recordDate","mealType","sourceType","status","imagePath","rating","isNewTry","favorite","notes","version","createdAt","updatedAt") VALUES ('ac2-record','2046-03-01','DINNER','HOMEMADE','CONFIRMED','uploads/ac2-old.jpg',4.5,1,1,'AC2 旧备注',3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
          INSERT INTO "MealRecordItem" ("id","mealRecordId","itemType","recipeId","customName","sortOrder","createdAt","updatedAt") VALUES ('ac2-item','ac2-record','RECIPE','ac2-recipe',NULL,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        `);
      } finally {
        legacy.close();
      }

      await writeBackupZip(zipPath, await readFile(legacyPath));
      await restoreBackup(database, zipPath);

      const expected = await localMigrationNames();
      const rows = await database.$queryRawUnsafe<
        Array<{ migration_name: string; finished_at: string | null; rolled_back_at: string | null }>
      >('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations');
      const completed = rows
        .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
        .map((row) => row.migration_name)
        .sort();
      expect(completed).toEqual(expected);
      expect(expected).toContain('20261002000100_google2_meal_record_title');
      expect(expected).toContain('20261002000200_deleted_item_plan_uncomplete_proof');

      const recipe = await database.recipe.findUniqueOrThrow({ where: { id: 'ac2-recipe' } });
      expect(recipe).toMatchObject({ name: 'AC2 旧菜谱', version: 4, favorite: false });
      const record = await database.mealRecord.findUniqueOrThrow({ where: { id: 'ac2-record' } });
      expect(record).toMatchObject({
        recordDate: '2046-03-01',
        imagePath: 'uploads/ac2-old.jpg',
        rating: 4.5,
        notes: 'AC2 旧备注',
        version: 3,
        title: null
      });
      expect(
        await database.mealRecordItem.findUniqueOrThrow({ where: { id: 'ac2-item' }, include: { recipe: true } })
      ).toMatchObject({ itemType: 'RECIPE', recipeId: 'ac2-recipe', recipe: { name: 'AC2 旧菜谱' } });
      expect(maintenanceState().active).toBe(false);
    } finally {
      await restoreSnapshot(snapshot);
      await rm(work, { recursive: true, force: true });
    }
  });

  describe('AC3 迁移异常预检 422 且不消费高风险 token', () => {
    // message 断言把 422 锁定到对应的迁移预检分支，避免被 INVALID_FILE 等其他 422 拦截冒充。
    const cases: Array<{ label: string; message: string; build: (path: string) => Promise<Buffer> }> = [
      {
        label: '缺少 _prisma_migrations 表',
        message: '暂存数据库缺少 Prisma 迁移表',
        build: (path) => createDatabaseWithoutMigrationTable(path)
      },
      {
        label: '存在未完成迁移（finished_at 与 rolled_back_at 均为 null）',
        message: '暂存数据库包含未完成或失败迁移',
        build: (path) =>
          createMigrationDatabase(path, [
            { name: legacyMigrations[0]!, finished: true },
            { name: legacyMigrations[1]!, finished: false }
          ])
      },
      {
        label: '包含未知未来迁移名称',
        message: '暂存数据库包含未知未来迁移',
        build: (path) =>
          createMigrationDatabase(path, [
            { name: legacyMigrations[0]!, finished: true },
            { name: '20991231000000_future_unknown_migration', finished: true }
          ])
      }
    ];

    it.each(cases)('$label 时返回 422，同一 token 随后上传合法 ZIP 成功一次', async ({ build, message }) => {
      const work = await mkdtemp(join(fixtureDirectory(), 'ac3-invalid-'));
      const invalidPath = join(work, 'invalid.zip');
      const validBackup = await createBackup(database);
      const token = await authorizeRestore();
      try {
        const invalidDatabasePath = join(work, 'invalid.db');
        await writeFile(invalidDatabasePath, '');
        await writeBackupZip(invalidPath, await build(invalidDatabasePath));

        const rejected = await uploadRestore(await readFile(invalidPath), token);
        expect(rejected.statusCode, rejected.body).toBe(422);
        expect(rejected.json().error).toMatchObject({ code: 'VALIDATION_ERROR', message });
        expect(maintenanceState().active).toBe(false);

        const accepted = await uploadRestore(await readFile(validBackup.zipPath), token);
        expect(accepted.statusCode, accepted.body).toBe(200);
        expect(accepted.json().data.restored).toBe(true);
        expect(maintenanceState().active).toBe(false);
      } finally {
        await validBackup.cleanup();
        await rm(work, { recursive: true, force: true });
      }
    });
  });

  it('AC4 切换后探针失败：数据库与 uploads 精确回滚，本次 .rollback-* 清理，维护结束', async () => {
    const uploads = resolveUploadsDirectory();
    const uploadPath = join(uploads, 'ac4-rollback.txt');
    const recipe = await database.recipe.create({ data: { name: 'AC4 回滚后应保留' } });
    await writeFile(uploadPath, 'ac4-original');
    const backup = await createBackup(database);
    const beforeRollbacks = await rollbackDirectories();
    const spy = vi.spyOn(database.shoppingList, 'count').mockRejectedValueOnce(new Error('ac4 probe failed'));
    try {
      await database.recipe.update({ where: { id: recipe.id }, data: { name: 'AC4 待回滚值' } });
      await writeFile(uploadPath, 'ac4-mutated');
      const before = {
        tree: await uploadsTree(),
        name: (await database.recipe.findUniqueOrThrow({ where: { id: recipe.id } })).name
      };

      await expect(restoreBackup(database, backup.zipPath)).rejects.toThrow('ac4 probe failed');

      expect((await database.recipe.findUniqueOrThrow({ where: { id: recipe.id } })).name).toBe(before.name);
      expect(await uploadsTree()).toEqual(before.tree);
      expect(await readFile(uploadPath, 'utf8')).toBe('ac4-mutated');
      expect(maintenanceState().active).toBe(false);
      expect(await rollbackDirectories()).toEqual(beforeRollbacks);
    } finally {
      spy.mockRestore();
      await database.$connect().catch(() => undefined);
      await backup.cleanup();
      await rm(uploadPath, { force: true });
      await database.recipe.deleteMany({ where: { id: recipe.id } });
      endMaintenance();
    }
  });

  it('AC5 探针连续两次失败：503、保留本次 .rollback-* 内 app.db、维护中且 settings 返回 503 MAINTENANCE', async () => {
    const uploadPath = join(resolveUploadsDirectory(), 'ac5-rollback-failure.txt');
    const recipe = await database.recipe.create({ data: { name: 'AC5 回滚失败前' } });
    await writeFile(uploadPath, 'ac5-original');
    const backup = await createBackup(database);
    const snapshot = await snapshotStorage();
    const beforeRollbacks = await rollbackDirectories();
    const spy = vi.spyOn(database.shoppingList, 'count').mockRejectedValue(new Error('ac5 probe failed twice'));
    let testError: unknown;
    let cleanupErrors: string[] = [];
    try {
      await database.recipe.update({ where: { id: recipe.id }, data: { name: 'AC5 切换值' } });
      await writeFile(uploadPath, 'ac5-mutated');

      await expect(restoreBackup(database, backup.zipPath)).rejects.toMatchObject({ statusCode: 503 });

      // 切换后探针与回滚后探针各失败一次，恰好两次。
      expect(spy).toHaveBeenCalledTimes(2);
      const created = (await rollbackDirectories()).filter((name) => !beforeRollbacks.includes(name));
      expect(created).toHaveLength(1);
      expect(created[0]!.startsWith('.rollback-')).toBe(true);
      const retained = join(resolveRestoreTempDirectory(), created[0]!);
      expect((await readdir(retained)).sort()).toEqual(['app.db', 'uploads']);
      const retainedDatabasePath = join(retained, 'app.db');
      expect((await readFile(retainedDatabasePath)).byteLength).toBeGreaterThan(0);
      const retainedDatabase = new DatabaseSync(retainedDatabasePath, { readOnly: true });
      try {
        expect(retainedDatabase.prepare('SELECT "name" FROM "Recipe" WHERE "id" = ?').get(recipe.id)).toEqual({
          name: 'AC5 切换值'
        });
      } finally {
        retainedDatabase.close();
      }
      expect(maintenanceState().active).toBe(true);

      const settings = await app.inject({ method: 'GET', url: '/api/v1/settings' });
      expect(settings.statusCode).toBe(503);
      expect(settings.json().error.code).toBe('MAINTENANCE');
    } catch (error) {
      testError = error;
    } finally {
      // 断言失败或快照恢复异常时，清理项之间互不阻塞，且只删除本用例新增的回滚目录。
      cleanupErrors = await cleanupAc5Artifacts({
        spy,
        snapshot,
        beforeRollbacks,
        uploadPath,
        recipeId: recipe.id,
        backup
      });
    }
    if (cleanupErrors.length) {
      throw new Error(
        `AC5 清理失败：${cleanupErrors.join('；')}${testError ? '；原始错误：' + String(testError) : ''}`
      );
    }
    if (testError) throw testError;
  });
});
