import { rm } from 'node:fs/promises';

import { createPrismaClient } from './client.js';
import { filePathFromDatabaseUrl } from './paths.js';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? 'file:../../../data/test.db';

export function createTestPrismaClient() {
  return createPrismaClient(`file:${filePathFromDatabaseUrl(testDatabaseUrl) ?? testDatabaseUrl}`);
}

export async function cleanupTestDatabase(databaseUrl = testDatabaseUrl): Promise<void> {
  const databasePath = filePathFromDatabaseUrl(databaseUrl);

  if (!databasePath) {
    return;
  }

  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-journal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
    rm(`${databasePath}-wal`, { force: true })
  ]);
}
