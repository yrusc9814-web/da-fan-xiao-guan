import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const releaseRoot = resolve(process.argv[2] ?? resolve(projectRoot, 'release', '搭饭小馆'));
const port = 18787;

function fail(message) {
  throw new Error(`[Windows release smoke] ${message}`);
}

function run(command, argumentsList, environment) {
  const result = spawnSync(command, argumentsList, {
    cwd: releaseRoot,
    env: environment,
    encoding: 'utf8'
  });
  if (result.error || result.status !== 0) {
    fail(`命令失败：${result.error?.message ?? result.stderr ?? result.stdout ?? '无输出'}`);
  }
}

async function fetchWhenReady(url, expectedContentType) {
  const deadline = Date.now() + 30000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok && response.headers.get('content-type')?.includes(expectedContentType)) {
        return response;
      }
      lastError = new Error(`${response.status} ${response.headers.get('content-type') ?? ''}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }

  fail(`服务未在 30 秒内就绪：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  child.kill();
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5000))
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

if (process.platform !== 'win32') {
  fail('只能在 Windows 上执行正式包 smoke；当前平台不模拟 Windows runtime。');
}

const runtimeNode = resolve(releaseRoot, 'runtime', 'node.exe');
const prismaCli = resolve(releaseRoot, 'node_modules', 'prisma', 'build', 'index.js');
const serverEntry = resolve(releaseRoot, 'dist-server', 'server', 'src', 'server.js');
if (![runtimeNode, prismaCli, serverEntry].every(existsSync)) {
  fail('正式包不完整，无法执行 smoke。');
}

const environment = {
  ...process.env,
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: String(port),
  DATABASE_URL: 'file:../../../data/smoke-app.db'
};
let server;

try {
  run(
    runtimeNode,
    [
      '-e',
      "import('sharp').then(({ default: sharp }) => sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 244, g: 127, b: 159, alpha: 1 } } }).png().toBuffer()).then((image) => { if (image.length === 0) throw new Error('sharp native image operation returned an empty buffer'); })"
    ],
    environment
  );
  run(runtimeNode, [prismaCli, 'migrate', 'deploy', '--schema', 'app/server/prisma/schema.prisma'], environment);

  server = spawn(runtimeNode, [serverEntry, '--app-id=dafan-xiaoguan-release-smoke'], {
    cwd: releaseRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await fetchWhenReady(`http://127.0.0.1:${port}/api/v1/health`, 'application/json');
  await fetchWhenReady(`http://127.0.0.1:${port}/`, 'text/html');
  console.log(`Windows release smoke passed: ${releaseRoot}`);
} finally {
  await stopProcess(server);
  await rm(resolve(releaseRoot, 'data'), { recursive: true, force: true });
  await rm(resolve(releaseRoot, 'logs'), { recursive: true, force: true });
}
