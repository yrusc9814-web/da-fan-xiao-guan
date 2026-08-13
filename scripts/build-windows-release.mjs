import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const releaseRoot = resolve(projectRoot, 'release', '搭饭小馆');
const nodeVersion = 'v22.23.2';
const nodeArchiveName = `node-${nodeVersion}-win-x64.zip`;
const nodeArchiveUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeArchiveName}`;
const nodeArchiveSha256 = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97';
const nodeExecutableSha256 = '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4';
const maximumArchiveSize = 100 * 1024 * 1024;
const manifestFilePaths = [
  'runtime/node.exe',
  'dist-server/server/src/server.js',
  'app/client/dist/index.html',
  'app/server/prisma/schema.prisma',
  'app/server/prisma/migrations/migration_lock.toml',
  'app/server/src/database/paths.ts',
  'prisma.config.ts',
  'scripts/ensure-sqlite-file.mjs',
  'node_modules/prisma/build/index.js',
  'node_modules/@prisma/client/default.js',
  'node_modules/.prisma/client/query_engine-windows.dll.node',
  'node_modules/@prisma/engines/schema-engine-windows.exe',
  'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
  'start.bat',
  'stop.bat',
  'README.txt',
  'package.json',
  'package-lock.json'
];

function fail(message) {
  throw new Error(`[Windows release build] ${message}`);
}

function run(command, argumentsList, options = {}) {
  const result = spawnSync(command, argumentsList, {
    cwd: releaseRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options
  });

  if (result.error) {
    fail(`无法执行 ${basename(command)}：${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${basename(command)} 退出码为 ${result.status}`);
  }
}

function npmCliPath() {
  const executableDirectory = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    resolve(executableDirectory, 'node_modules/npm/bin/npm-cli.js'),
    resolve(executableDirectory, '../lib/node_modules/npm/bin/npm-cli.js')
  ];
  const npmCli = candidates.find((candidate) => candidate && existsSync(candidate));

  if (!npmCli) {
    fail('找不到 npm-cli.js，无法以跨平台方式运行发行包依赖命令');
  }

  return npmCli;
}

function assertSourceExists(relativePath) {
  const source = resolve(projectRoot, relativePath);
  if (!existsSync(source)) {
    fail(`缺少构建输入：${relativePath}。请先运行 npm run build。`);
  }
  return source;
}

async function copyIntoRelease(relativePath) {
  const source = assertSourceExists(relativePath);
  const destination = resolve(releaseRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function migrationNames() {
  const migrationsDirectory = resolve(releaseRoot, 'app', 'server', 'prisma', 'migrations');
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    fail('正式包中没有 Prisma migrations');
  }
  for (const name of names) {
    if (!existsSync(resolve(migrationsDirectory, name, 'migration.sql'))) {
      fail(`Prisma migration 缺少 migration.sql：${name}`);
    }
  }
  return names;
}

async function criticalFileHashes(migrations) {
  const relativePaths = [
    ...manifestFilePaths,
    ...migrations.map((migrationName) => `app/server/prisma/migrations/${migrationName}/migration.sql`)
  ];
  const entries = await Promise.all(
    relativePaths.map(async (relativePath) => {
      const path = resolve(releaseRoot, relativePath);
      if (!existsSync(path)) {
        fail(`无法写入发行清单，缺少关键文件：${relativePath}`);
      }
      return [relativePath, await sha256(path)];
    })
  );
  return Object.fromEntries(entries);
}

async function downloadOfficialNodeArchive(destination) {
  const response = await fetch(nodeArchiveUrl);
  if (!response.ok || !response.body) {
    fail(`无法下载 Node 官方 runtime：${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumArchiveSize) {
    fail(`Node runtime ZIP 超过允许大小：${contentLength}`);
  }

  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.byteLength > maximumArchiveSize) {
    fail(`Node runtime ZIP 超过允许大小：${archive.byteLength}`);
  }
  await writeFile(destination, archive);

  if ((await sha256(destination)) !== nodeArchiveSha256) {
    fail(`Node 官方 ZIP 的 SHA-256 不匹配 ${nodeVersion} Windows x64 发布清单`);
  }
}

function assertWindowsX64() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    fail('只能在 Windows x64 上构建正式 Windows 包；不会在当前平台伪造 node.exe。');
  }
}

async function main() {
  assertWindowsX64();

  for (const relativePath of [
    'dist-server/server/src/server.js',
    'app/client/dist/index.html',
    'app/server/prisma/schema.prisma',
    'app/server/prisma/migrations/migration_lock.toml'
  ]) {
    assertSourceExists(relativePath);
  }

  const pathFromProject = relative(projectRoot, releaseRoot);
  if (pathFromProject.startsWith('..') || pathFromProject === '') {
    fail(`拒绝写入项目外的发行目录：${releaseRoot}`);
  }

  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(releaseRoot, { recursive: true });

  for (const relativePath of [
    'README.txt',
    'start.bat',
    'stop.bat',
    'package.json',
    'package-lock.json',
    'prisma.config.ts',
    'app/client/package.json',
    'app/client/dist',
    'app/server/package.json',
    'app/server/prisma',
    'app/server/src/database/paths.ts',
    'dist-server',
    'scripts/ensure-sqlite-file.mjs'
  ]) {
    await copyIntoRelease(relativePath);
  }

  const temporaryDirectory = resolve(releaseRoot, '.release-tmp');
  const archivePath = resolve(temporaryDirectory, nodeArchiveName);
  const extractedDirectory = resolve(temporaryDirectory, 'node');
  await mkdir(temporaryDirectory, { recursive: true });
  await downloadOfficialNodeArchive(archivePath);
  run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${extractedDirectory}' -Force`
  ]);

  const extractedNode = resolve(extractedDirectory, `node-${nodeVersion}-win-x64`, 'node.exe');
  if (!existsSync(extractedNode)) {
    fail('Node 官方 ZIP 中缺少 runtime node.exe');
  }
  await mkdir(resolve(releaseRoot, 'runtime'), { recursive: true });
  await cp(extractedNode, resolve(releaseRoot, 'runtime', 'node.exe'));
  await rm(temporaryDirectory, { recursive: true, force: true });

  const runtimeNode = resolve(releaseRoot, 'runtime', 'node.exe');
  if ((await sha256(runtimeNode)) !== nodeExecutableSha256) {
    fail(`runtime/node.exe 的 SHA-256 不匹配 ${nodeVersion} Windows x64 官方文件`);
  }
  const runtimeIdentity = spawnSync(runtimeNode, ['-p', '`${process.platform}:${process.arch}:${process.version}`'], {
    cwd: releaseRoot,
    encoding: 'utf8'
  });
  if (runtimeIdentity.status !== 0 || runtimeIdentity.stdout.trim() !== `win32:x64:${nodeVersion}`) {
    fail(`runtime/node.exe 身份校验失败：${runtimeIdentity.stderr || runtimeIdentity.stdout || '无输出'}`);
  }

  const npmCli = npmCliPath();
  run(process.execPath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--fund=false'], {
    env: { ...process.env, NODE_ENV: 'production' }
  });
  run(process.execPath, [npmCli, 'ls', '--omit=dev', '--all', 'prisma', '@prisma/client', 'sharp'], {
    env: { ...process.env, NODE_ENV: 'production' }
  });
  run(runtimeNode, [
    resolve(releaseRoot, 'node_modules', 'prisma', 'build', 'index.js'),
    'generate',
    '--schema',
    resolve(releaseRoot, 'app', 'server', 'prisma', 'schema.prisma')
  ]);

  const migrations = await migrationNames();
  const files = await criticalFileHashes(migrations);

  await writeFile(
    resolve(releaseRoot, 'release-manifest.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        target: { platform: 'win32', arch: 'x64' },
        node: {
          version: nodeVersion,
          archiveUrl: nodeArchiveUrl,
          archiveSha256: nodeArchiveSha256,
          executableSha256: nodeExecutableSha256
        },
        prisma: { migrations },
        files
      },
      null,
      2
    )}\n`
  );

  run(process.execPath, [resolve(projectRoot, 'scripts', 'verify-windows-release.mjs'), releaseRoot]);
  console.log(`Windows release created: ${releaseRoot}`);
}

await main();
