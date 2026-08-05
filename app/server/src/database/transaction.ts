import type { PrismaClient, Prisma } from '@prisma/client';

import { prisma } from './client.js';

export async function withTransaction<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  client: PrismaClient = prisma
): Promise<T> {
  return client.$transaction(operation);
}
