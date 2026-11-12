import { rm } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = resolve(projectRoot, 'data');
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'file:../../../data/test.db';

if (!databaseUrl.startsWith('file:')) {
  throw new Error('测试数据库必须使用 file: SQLite URL');
}

const { register } = await import('tsx/esm/api');
register();
const paths = await import('../app/server/src/database/paths.ts');
paths.assertSafeTestDatabaseUrl(databaseUrl);
const databasePath = paths.filePathFromDatabaseUrl(databaseUrl);
if (!databasePath) throw new Error('test database must be local');
const filename = basename(databasePath);
const root = process.env.DAFAN_ISOLATION_ROOT;
if (root !== undefined) {
  paths.assertIsolatedPath(databasePath, root);
  for (const suffix of ['-journal', '-shm', '-wal']) paths.assertIsolatedPath(databasePath + suffix, root);
  const env = { ...process.env, NODE_ENV: 'test', TEST_DATABASE_URL: databaseUrl, DAFAN_DATABASE_PATH: databasePath };
  paths.resolveStoragePaths(env);
}
if (
  (!root && !databasePath.startsWith(`${dataDirectory}${sep}`)) ||
  !/^test(?:[-_.][a-z0-9_-]*)?\.db$/i.test(filename)
) {
  throw new Error(`拒绝重置非测试数据库：${databasePath}`);
}

await Promise.all([
  rm(databasePath, { force: true }),
  rm(`${databasePath}-journal`, { force: true }),
  rm(`${databasePath}-shm`, { force: true }),
  rm(`${databasePath}-wal`, { force: true })
]);
