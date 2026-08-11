import { createPrismaClient } from '../app/server/src/database/client.ts';
import { seedDevelopmentData } from '../app/server/src/database/seed.ts';

const database = createPrismaClient();

try {
  await seedDevelopmentData(database);
  console.log('开发 Seed 已幂等完成');
} finally {
  await database.$disconnect();
}
