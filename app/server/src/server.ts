import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { prisma } from './database/client.js';
import { ensureDailyBackup } from './modules/backup/service.js';

async function start(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  try {
    await app.listen({
      host: config.host,
      port: config.port
    });
    await ensureDailyBackup(prisma).catch((error: unknown) => app.log.error(error, '自动备份失败'));
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

void start();
