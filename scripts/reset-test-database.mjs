import { rm } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDirectory = resolve(projectRoot, 'app/server/prisma');
const dataDirectory = resolve(projectRoot, 'data');
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'file:../../../data/test.db';

if (!databaseUrl.startsWith('file:')) {
  throw new Error('测试数据库必须使用 file: SQLite URL');
}

const rawPath = databaseUrl.slice('file:'.length);
const databasePath = resolve(rawPath.startsWith('/') ? rawPath : resolve(schemaDirectory, rawPath));
const filename = basename(databasePath);
if (!databasePath.startsWith(`${dataDirectory}${sep}`) || !/^test(?:[-_.][a-z0-9_-]*)?\.db$/i.test(filename)) {
  throw new Error(`拒绝重置非测试数据库：${databasePath}`);
}

await Promise.all([
  rm(databasePath, { force: true }),
  rm(`${databasePath}-journal`, { force: true }),
  rm(`${databasePath}-shm`, { force: true }),
  rm(`${databasePath}-wal`, { force: true })
]);
