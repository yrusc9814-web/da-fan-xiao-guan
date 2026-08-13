import { existsSync } from 'node:fs';
import { rm, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const releaseRoot = resolve(process.argv[2] ?? resolve(projectRoot, 'release', '搭饭小馆'));
const port = 18787;

function fail(message) {
  throw new Error(`[Windows release smoke] ${message}`);
}

function manifestPath(relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || isAbsolute(relativePath)) {
    fail(`${label} 必须是发行目录内的相对路径`);
  }
  const path = resolve(releaseRoot, relativePath);
  const pathFromRelease = relative(releaseRoot, path);
  if (pathFromRelease === '' || pathFromRelease.startsWith('..') || isAbsolute(pathFromRelease)) {
    fail(`${label} 指向发行目录外：${relativePath}`);
  }
  return path;
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
      if (response.status === 200 && response.headers.get('content-type')?.includes(expectedContentType)) {
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

const manifest = JSON.parse(await readFile(manifestPath('release-manifest.json', 'release-manifest.json'), 'utf8'));
const runtimeNode = manifestPath('runtime/node.exe', 'runtime/node.exe');
const prismaCli = manifestPath(manifest?.prisma?.cli?.path, 'prisma.cli');
const prismaSchema = manifestPath('app/server/prisma/schema.prisma', 'Prisma schema');
const serverEntry = manifestPath(manifest?.entrypoints?.server?.path, 'entrypoints.server');
const clientEntry = manifestPath(manifest?.entrypoints?.client?.path, 'entrypoints.client');
if (![runtimeNode, prismaCli, prismaSchema, serverEntry, clientEntry].every(existsSync)) {
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
      `(async()=>{const {createRequire}=require('node:module');const {resolve}=require('node:path');const req=createRequire(resolve(process.cwd(),'app/server/package.json'));const sharp=req('sharp');const image=await sharp({create:{width:1,height:1,channels:4,background:{r:244,g:127,b:159,alpha:1}}}).png().toBuffer();const signature=Buffer.from([137,80,78,71,13,10,26,10]);if(image.length===0||!image.subarray(0,8).equals(signature))throw new Error('sharp native PNG operation failed');console.log('Sharp native smoke passed');})().catch(error=>{console.error(error);process.exit(1)})`
    ],
    environment
  );
  run(runtimeNode, [prismaCli, 'migrate', 'deploy', '--schema', prismaSchema], environment);
  run(
    runtimeNode,
    [
      '-e',
      `(async()=>{const {createRequire}=require('node:module');const {resolve}=require('node:path');const req=createRequire(resolve(process.cwd(),'app/server/package.json'));const {PrismaClient}=req('@prisma/client');const prisma=new PrismaClient();await prisma.$queryRawUnsafe('SELECT 1');await prisma.$disconnect();console.log('Prisma SQLite connection smoke passed')})().catch(async error=>{console.error(error);process.exit(1)})`
    ],
    environment
  );

  server = spawn(runtimeNode, [serverEntry, '--app-id=dafan-xiaoguan-release-smoke'], {
    cwd: releaseRoot,
    env: environment,
    stdio: 'ignore'
  });
  await fetchWhenReady(`http://127.0.0.1:${port}/api/v1/health`, 'application/json');
  await fetchWhenReady(`http://127.0.0.1:${port}/`, 'text/html');
  console.log(`Windows release smoke passed: ${releaseRoot}`);
} finally {
  await stopProcess(server);
  await rm(resolve(releaseRoot, 'data'), { recursive: true, force: true });
  await rm(resolve(releaseRoot, 'logs'), { recursive: true, force: true });
}
