import { PrismaClient } from '@prisma/client';

import '../config/env.js';
import {
  assertIsolatedPath,
  assertSafeTestDatabaseUrl,
  filePathFromDatabaseUrl,
  resolveStoragePaths
} from './paths.js';

export function createPrismaClient(databaseUrl = resolveStoragePaths().databaseUrl): PrismaClient {
  if (process.env.DAFAN_ISOLATION_ROOT !== undefined) {
    const path = filePathFromDatabaseUrl(databaseUrl);
    if (!path) throw new Error('隔离模式仅支持 SQLite');
    assertIsolatedPath(path);
  }
  if (process.env.NODE_ENV === 'test') {
    assertSafeTestDatabaseUrl(databaseUrl);
  }
  return new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl
      }
    }
  });
}

export const prisma = createPrismaClient();

export async function disconnectPrisma(client: PrismaClient = prisma): Promise<void> {
  await client.$disconnect();
}
