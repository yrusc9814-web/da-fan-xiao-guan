import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { prisma } from './database/client.js';
import { startAutomaticBackupScheduler } from './modules/backup/scheduler.js';

async function start(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });
  let stopAutomaticBackups: () => void = () => undefined;
  app.addHook('onClose', async () => {
    stopAutomaticBackups();
  });

  try {
    await app.listen({
      host: config.host,
      port: config.port
    });
    stopAutomaticBackups = startAutomaticBackupScheduler(prisma, {
      environment: config.environment,
      onError: (error) => app.log.error(error, '自动备份失败')
    });
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

void start();
