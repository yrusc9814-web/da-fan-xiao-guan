import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDirectory = resolve(projectRoot, 'app/server/prisma');
const databaseUrl = process.env.DATABASE_URL ?? 'file:../../../data/test.db';

if (databaseUrl.startsWith('file:')) {
  const rawPath = databaseUrl.slice('file:'.length);
  const databasePath = rawPath.startsWith('/') ? rawPath : resolve(schemaDirectory, rawPath);

  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-journal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
    rm(`${databasePath}-wal`, { force: true })
  ]);
}
