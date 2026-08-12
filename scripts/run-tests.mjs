import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? 'file:../../../data/test.db';
const environment = {
  ...process.env,
  DATABASE_URL: testDatabaseUrl,
  TEST_DATABASE_URL: testDatabaseUrl,
  NODE_ENV: 'test'
};

function npmCliPath() {
  const executableDirectory = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    resolve(executableDirectory, 'node_modules/npm/bin/npm-cli.js'),
    resolve(executableDirectory, '../lib/node_modules/npm/bin/npm-cli.js')
  ];
  const npmCli = candidates.find((candidate) => candidate && existsSync(candidate));

  if (!npmCli) {
    throw new Error('找不到 npm-cli.js，无法以跨平台方式运行测试工作区命令');
  }

  return npmCli;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`测试子进程退出码为 ${result.status ?? 1}`);
  }
}

async function fingerprint(path) {
  try {
    const [contents, metadata] = await Promise.all([readFile(path), stat(path)]);
    return {
      hash: createHash('sha256').update(contents).digest('hex'),
      mtimeMs: metadata.mtimeMs,
      size: metadata.size
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

const applicationDatabase = resolve(projectRoot, 'data/app.db');
const applicationDatabaseBefore = await fingerprint(applicationDatabase);
let testFailure;

try {
  const npmCli = npmCliPath();
  run(process.execPath, ['scripts/setup-test-database.mjs']);
  run(process.execPath, [npmCli, 'run', 'test:client']);
  run(process.execPath, [npmCli, '--workspace', '@dafan/server', 'run', 'test']);
} catch (error) {
  testFailure = error;
}

const applicationDatabaseAfter = await fingerprint(applicationDatabase);
if (JSON.stringify(applicationDatabaseAfter) !== JSON.stringify(applicationDatabaseBefore)) {
  throw new Error('测试修改了开发数据库 data/app.db');
}
if (testFailure) {
  throw testFailure;
}
