import type { PrismaClient } from '@prisma/client';

export interface DatabaseHealth {
  status: 'ok' | 'error';
  provider: 'sqlite';
}

export async function checkDatabaseHealth(client: PrismaClient): Promise<DatabaseHealth> {
  try {
    await client.$queryRaw`SELECT 1`;
    return {
      status: 'ok',
      provider: 'sqlite'
    };
  } catch {
    return {
      status: 'error',
      provider: 'sqlite'
    };
  }
}
