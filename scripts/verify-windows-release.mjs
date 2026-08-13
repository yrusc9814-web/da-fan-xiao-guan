import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
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
  'start.bat',
  'stop.bat',
  'README.txt',
  'package.json',
  'package-lock.json'
];

function fail(message) {
  throw new Error(`[Windows release verification] ${message}`);
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
  return { path, relativePath: pathFromRelease.split('\\').join('/') };
}

function assertExists(relativePath, label = relativePath) {
  const { path } = manifestPath(relativePath, label);
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

function descriptorList(manifest) {
  return [
    ['entrypoints.server', manifest?.entrypoints?.server],
    ['entrypoints.client', manifest?.entrypoints?.client],
    ['prisma.cli', manifest?.prisma?.cli],
    ['prisma.queryEngine', manifest?.prisma?.queryEngine],
    ['prisma.schemaEngine', manifest?.prisma?.schemaEngine],
    ['sharp.package.packageJson', manifest?.sharp?.package?.packageJson],
    ['sharp.nativePackage.packageJson', manifest?.sharp?.nativePackage?.packageJson],
    ['sharp.nativeAddon', manifest?.sharp?.nativeAddon],
    ...(manifest?.sharp?.bundledLibvips ?? []).map((item, index) => [`sharp.bundledLibvips[${index}]`, item]),
    ['sharp.libvipsPackage.packageJson', manifest?.sharp?.libvipsPackage?.packageJson],
    ...(manifest?.sharp?.libvipsPackage?.files ?? []).map((item, index) => [
      `sharp.libvipsPackage.files[${index}]`,
      item
    ])
  ];
}

function descriptorPath(label, descriptor, fileRecords) {
  if (!descriptor || typeof descriptor !== 'object') {
    fail(`manifest 缺少 ${label}`);
  }
  const { relativePath } = manifestPath(descriptor.path, label);
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256 ?? '')) {
    fail(`${label} 包含无效的 SHA-256`);
  }
  if (fileRecords[relativePath] !== descriptor.sha256) {
    fail(`${label} 的 SHA-256 与 files 记录不一致`);
  }
  return relativePath;
}

if (releaseRoot === projectRoot) {
  fail(`发行目录不能是项目根目录：${releaseRoot}`);
}

for (const relativePath of [...manifestFilePaths, 'release-manifest.json']) {
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
if (startScript.includes('node_modules\\prisma') || !startScript.includes('release-manifest.json')) {
  fail('正式 start.bat 不得硬编码 Prisma CLI 的 node_modules 路径，必须读取 release-manifest.json');
}

const manifest = JSON.parse(await readFile(assertExists('release-manifest.json'), 'utf8'));
if (
  manifest?.formatVersion !== 2 ||
  manifest?.target?.platform !== 'win32' ||
  manifest?.target?.arch !== 'x64' ||
  manifest?.node?.version !== expectedNodeVersion ||
  manifest?.node?.executableSha256 !== expectedNodeExecutableSha256
) {
  fail('release-manifest.json 未声明预期的 Windows x64 Node runtime');
}

const fileRecords = manifest.files;
if (!fileRecords || typeof fileRecords !== 'object' || Array.isArray(fileRecords)) {
  fail('release-manifest.json 缺少 files 记录');
}
for (const [relativePath, expectedHash] of Object.entries(fileRecords)) {
  const { relativePath: normalizedPath } = manifestPath(relativePath, `files.${relativePath}`);
  if (normalizedPath !== relativePath) {
    fail(`files 使用了非规范路径：${relativePath}`);
  }
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    fail(`files 包含无效的 SHA-256：${relativePath}`);
  }
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

const descriptorPaths = descriptorList(manifest).map(([label, descriptor]) =>
  descriptorPath(label, descriptor, fileRecords)
);
const expectedManifestFilePaths = [
  ...new Set([
    ...manifestFilePaths,
    ...manifest.prisma.migrations.map((migrationName) => `app/server/prisma/migrations/${migrationName}/migration.sql`),
    ...descriptorPaths
  ])
].sort();
const manifestRecordPaths = Object.keys(fileRecords).sort();
if (
  expectedManifestFilePaths.length !== manifestRecordPaths.length ||
  expectedManifestFilePaths.some((relativePath, index) => relativePath !== manifestRecordPaths[index])
) {
  fail('release-manifest.json 的关键文件集合不完整或包含意外文件');
}
for (const relativePath of expectedManifestFilePaths) {
  if ((await sha256(assertExists(relativePath))) !== fileRecords[relativePath]) {
    fail(`关键文件的 SHA-256 与 release-manifest.json 不一致：${relativePath}`);
  }
}

if (manifest?.sharp?.package?.name !== 'sharp' || typeof manifest?.sharp?.package?.version !== 'string') {
  fail('release-manifest.json 未声明 Sharp 包元数据');
}
if (
  manifest?.sharp?.nativePackage?.name !== '@img/sharp-win32-x64' ||
  typeof manifest?.sharp?.nativePackage?.version !== 'string'
) {
  fail('release-manifest.json 未声明 Windows Sharp native 包元数据');
}
if (
  manifest?.sharp?.libvipsPackage?.name !== '@img/sharp-libvips-win32-x64' ||
  typeof manifest?.sharp?.libvipsPackage?.version !== 'string'
) {
  fail('release-manifest.json 未声明 Windows Sharp libvips 包元数据');
}
if (!manifest.sharp.nativeAddon.path.toLowerCase().endsWith('.node')) {
  fail('Sharp native addon 不是 .node 文件');
}
if (!manifest.sharp.bundledLibvips.some((item) => item.path.toLowerCase().endsWith('.dll'))) {
  fail('Sharp Windows native 包未声明 libvips DLL');
}
if (!manifest.sharp.libvipsPackage.files.some((item) => item.path.toLowerCase().endsWith('.dll'))) {
  fail('Sharp Windows libvips 包未声明 DLL');
}

const runtimeIdentity =
  process.platform === 'win32'
    ? run(runtimeNode, ['-p', '`${process.platform}:${process.arch}:${process.version}`'])
    : null;
if (runtimeIdentity !== null && runtimeIdentity !== `win32:x64:${expectedNodeVersion}`) {
  fail(`runtime/node.exe 不是预期的 Windows x64 Node ${expectedNodeVersion}：${runtimeIdentity}`);
}
if (process.platform === 'win32') {
  const prismaCli = assertExists(manifest.prisma.cli.path);
  run(runtimeNode, [prismaCli, 'version']);
}

console.log(`Windows release verification passed: ${releaseRoot}`);
