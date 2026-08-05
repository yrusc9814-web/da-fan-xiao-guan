import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
dotenv.config({ path: resolve(projectRoot, '.env') });

export interface AppConfig {
  appName: '搭饭小馆';
  version: '0.1.0';
  host: string;
  port: number;
  environment: string;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 8787);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT 必须是 1 到 65535 之间的整数');
  }

  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    appName: '搭饭小馆',
    version: '0.1.0',
    host: env.HOST ?? '0.0.0.0',
    port: parsePort(env.PORT),
    environment: env.NODE_ENV ?? 'development'
  };
}
