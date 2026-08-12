import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const releaseRoot = resolve(process.argv[2] ?? resolve(projectRoot, 'release', '搭饭小馆'));
const expectedNodeVersion = 'v22.23.2';
const expectedNodeExecutableSha256 = '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4';
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
  throw new Error(`[Windows release verification] ${message}`);
}

function assertInsideProject(path, label) {
  const pathFromProject = relative(projectRoot, path);
  if (pathFromProject.startsWith('..') || pathFromProject === '') {
    fail(`${label} 必须位于项目目录内：${path}`);
  }
}

function assertExists(relativePath) {
  const path = resolve(releaseRoot, relativePath);
  if (!existsSync(path)) {
    fail(`缺少必需文件：${relativePath}`);
  }
  return path;
}

function run(command, argumentsList, options = {}) {
  const result = spawnSync(command, argumentsList, {
    cwd: releaseRoot,
    encoding: 'utf8',
    ...options
  });

  if (result.error) {
    fail(`无法执行 ${basename(command)}：${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${basename(command)} 退出码为 ${result.status}：${result.stderr || result.stdout || '无输出'}`);
  }
  return result.stdout.trim();
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

assertInsideProject(releaseRoot, '发行目录');

for (const relativePath of [
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
  'package-lock.json',
  'release-manifest.json'
]) {
  assertExists(relativePath);
}

const migrationsDirectory = assertExists('app/server/prisma/migrations');

const runtimeNode = assertExists('runtime/node.exe');
if ((await sha256(runtimeNode)) !== expectedNodeExecutableSha256) {
  fail(`runtime/node.exe 的 SHA-256 不匹配 Node ${expectedNodeVersion} Windows x64 官方文件`);
}

const startScript = await readFile(assertExists('start.bat'), 'utf8');
if (startScript.includes('%%~$PATH:I') || startScript.includes('for %%I in (node.exe)')) {
  fail('正式 start.bat 不得回退到系统 PATH 中的 node.exe');
}
if (!startScript.includes('runtime\\node.exe')) {
  fail('正式 start.bat 未引用包内 runtime\\node.exe');
}

const manifest = JSON.parse(await readFile(assertExists('release-manifest.json'), 'utf8'));
if (
  manifest?.target?.platform !== 'win32' ||
  manifest?.target?.arch !== 'x64' ||
  manifest?.node?.version !== expectedNodeVersion ||
  manifest?.node?.executableSha256 !== expectedNodeExecutableSha256
) {
  fail('release-manifest.json 未声明预期的 Windows x64 Node runtime');
}

if (!Array.isArray(manifest?.prisma?.migrations) || manifest.prisma.migrations.length === 0) {
  fail('release-manifest.json 未声明 Prisma migrations');
}
for (const migrationName of manifest.prisma.migrations) {
  if (typeof migrationName !== 'string' || migrationName.includes('/') || migrationName.includes('\\')) {
    fail('release-manifest.json 包含无效的 Prisma migration 名称');
  }
  assertExists(`app/server/prisma/migrations/${migrationName}/migration.sql`);
}

const packagedMigrations = readdirSync(migrationsDirectory, { withFileTypes: true }).filter((entry) =>
  entry.isDirectory()
);
if (packagedMigrations.length !== manifest.prisma.migrations.length) {
  fail('正式包中的 Prisma migration 目录数量与发行清单不一致');
}

const expectedManifestFilePaths = [
  ...manifestFilePaths,
  ...manifest.prisma.migrations.map((migrationName) => `app/server/prisma/migrations/${migrationName}/migration.sql`)
].sort();
const manifestRecordPaths = Object.keys(manifest.files ?? {}).sort();
if (
  expectedManifestFilePaths.length !== manifestRecordPaths.length ||
  expectedManifestFilePaths.some((relativePath, index) => relativePath !== manifestRecordPaths[index])
) {
  fail('release-manifest.json 的关键文件集合不完整或包含意外文件');
}
for (const relativePath of expectedManifestFilePaths) {
  const expectedHash = manifest.files[relativePath];
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    fail(`release-manifest.json 包含无效的 SHA-256：${relativePath}`);
  }
  if ((await sha256(assertExists(relativePath))) !== expectedHash) {
    fail(`关键文件的 SHA-256 与 release-manifest.json 不一致：${relativePath}`);
  }
}

for (const prismaEngineDirectory of ['node_modules/.prisma/client', 'node_modules/@prisma/engines']) {
  const packagedEngineFiles = readdirSync(resolve(releaseRoot, prismaEngineDirectory), { recursive: true });
  if (packagedEngineFiles.some((entry) => entry.toLowerCase().includes('darwin'))) {
    fail(`Windows 正式包包含 macOS Prisma engine：${prismaEngineDirectory}`);
  }
}

if (process.platform === 'win32') {
  const runtimeIdentity = run(runtimeNode, ['-p', '`${process.platform}:${process.arch}:${process.version}`']);
  if (runtimeIdentity !== `win32:x64:${expectedNodeVersion}`) {
    fail(`runtime/node.exe 不是预期的 Windows x64 Node ${expectedNodeVersion}：${runtimeIdentity}`);
  }
  run(runtimeNode, [resolve(releaseRoot, 'node_modules', 'prisma', 'build', 'index.js'), 'version']);
}

console.log(`Windows release verification passed: ${releaseRoot}`);
