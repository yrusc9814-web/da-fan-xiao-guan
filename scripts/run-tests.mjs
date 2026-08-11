import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? 'file:../../../data/test.db';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const environment = {
  ...process.env,
  DATABASE_URL: testDatabaseUrl,
  TEST_DATABASE_URL: testDatabaseUrl,
  NODE_ENV: 'test'
};

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ['scripts/setup-test-database.mjs']);
run(npmCommand, ['run', 'test:client']);
run(npmCommand, ['--workspace', '@dafan/server', 'run', 'test']);
