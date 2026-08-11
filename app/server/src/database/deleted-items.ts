import type { Prisma } from '@prisma/client';

export async function recordDeletedItem(transaction: Prisma.TransactionClient, entityType: string, entityId: string, deletedAt = new Date()): Promise<void> {
  const expiresAt = new Date(deletedAt);
  expiresAt.setDate(expiresAt.getDate() + 30);
  await transaction.deletedItem.upsert({
    where: { entityType_entityId: { entityType, entityId } },
    create: { entityType, entityId, deletedAt, expiresAt },
    update: { deletedAt, expiresAt }
  });
}
