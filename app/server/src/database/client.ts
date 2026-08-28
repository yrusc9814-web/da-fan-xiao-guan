import { PrismaClient } from '@prisma/client';

import '../config/env.js';
import { assertSafeTestDatabaseUrl, resolveDatabaseUrl } from './paths.js';

export function createPrismaClient(databaseUrl = resolveDatabaseUrl()): PrismaClient {
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
