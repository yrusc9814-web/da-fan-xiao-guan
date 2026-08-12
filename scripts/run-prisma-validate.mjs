import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prismaCli = resolve(projectRoot, 'node_modules/prisma/build/index.js');
const environment = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'file:../../../data/app.db'
};

if (!existsSync(prismaCli)) {
  throw new Error('找不到本地 Prisma CLI，请先运行 npm ci 或 npm install');
}

const result = spawnSync(process.execPath, [prismaCli, 'validate'], {
  cwd: projectRoot,
  env: environment,
  stdio: 'inherit'
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
