import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prismaCli = resolve(projectRoot, 'node_modules/prisma/build/index.js');
const { testEnvironment } = await import('./test-storage-environment.mjs');
const environment = await testEnvironment();

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(prismaCli)) {
  throw new Error('找不到本地 Prisma CLI，请先运行 npm ci 或 npm install');
}

run(process.execPath, ['scripts/reset-test-database.mjs']);
run(process.execPath, ['scripts/ensure-sqlite-file.mjs']);
run(process.execPath, [prismaCli, 'migrate', 'deploy']);
