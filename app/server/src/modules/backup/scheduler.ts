import type { PrismaClient } from '@prisma/client';

import { ensureDailyBackup } from './service.js';

export const automaticBackupCheckIntervalMs = 60 * 60 * 1000;

export function startAutomaticBackupScheduler(
  database: PrismaClient,
  options: {
    environment: string;
    intervalMs?: number;
    run?: (database: PrismaClient) => Promise<unknown>;
    onError?: (error: unknown) => void;
  }
): () => void {
  const run = options.run ?? ensureDailyBackup;
  let running = false;
  let stopped = false;
  const check = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await run(database);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  void check();
  if (options.environment === 'test')
    return () => {
      stopped = true;
    };
  const timer = setInterval(() => {
    void check();
  }, options.intervalMs ?? automaticBackupCheckIntervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
