import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const MARKER_PREFIX = 'upgrade-marker-';
const SCHEMA_RELATIVE_PATH = 'app/server/prisma/schema.prisma';
const MIGRATIONS_RELATIVE_PATH = 'app/server/prisma/migrations';

const SQLITE_STATE_SCRIPT = [
  "const { DatabaseSync } = require('node:sqlite');",
  'const databasePath = process.argv[1];',
  'const markerValue = process.argv[2];',
  'const db = new DatabaseSync(databasePath);',
  'if (markerValue !== undefined) {',
  "  db.prepare('INSERT INTO Settings (id, appName, updatedAt) VALUES (1, ?, CURRENT_TIMESTAMP)').run(markerValue);",
  '}',
  "const settingsRow = db.prepare('SELECT appName FROM Settings WHERE id = 1').get();",
  'const migrations = db',
  "  .prepare('SELECT migration_name AS name, finished_at FROM _prisma_migrations ORDER BY migration_name')",
  '  .all();',
  'db.close();',
  'process.stdout.write(JSON.stringify({ appName: settingsRow ? settingsRow.appName : null, migrations }));'
].join('\n');

function fail(message) {
  throw new Error(`[Windows release upgrade test] ${message}`);
}

function log(message) {
  console.log(`[UPGRADE] ${message}`);
}

function parsePackageArgument(argumentsList) {
  const flagIndex = argumentsList.indexOf('--package');
  if (flagIndex !== -1) {
    return argumentsList[flagIndex + 1];
  }
  const prefixed = argumentsList.find((argument) => argument.startsWith('--package='));
  return prefixed === undefined ? undefined : prefixed.slice('--package='.length);
}

function toPackagePath(packageRoot, relativePath) {
  return join(packageRoot, ...relativePath.split('/'));
}

function robocopyDirectory(source, destination) {
  const result = spawnSync(
    'robocopy',
    [source, destination, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:2'],
    { encoding: 'utf8' }
  );
  if (result.error) {
    fail(`无法启动 robocopy：${result.error.message}`);
  }
  if ((result.status ?? 0) >= 8) {
    fail(`robocopy 复制发行包失败（退出码 ${result.status}）：${result.stderr || result.stdout || '无输出'}`);
  }
}

function runPackageNode(runtimeNode, argumentsList, options = {}) {
  const result = spawnSync(runtimeNode, argumentsList, { encoding: 'utf8', ...options });
  if (result.error) {
    fail(`无法执行包内 runtime/node.exe：${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`包内 node 执行失败（退出码 ${result.status}）：${result.stderr || result.stdout || '无输出'}`);
  }
  return result.stdout.trim();
}

function runMigrateDeploy(runtimeNode, prismaCli, schemaPath, workingDirectory, databaseUrl, label) {
  const result = spawnSync(runtimeNode, [prismaCli, 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: workingDirectory,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8'
  });
  if (result.error) {
    fail(`${label}：无法执行包内 Prisma CLI：${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${label}：prisma migrate deploy 退出码 ${result.status}：${result.stderr || result.stdout || '无输出'}`);
  }
  log(`${label}：prisma migrate deploy 成功`);
}

function readDatabaseState(runtimeNode, workingDirectory, databaseFilePath, markerValue) {
  const argumentsList = ['-e', SQLITE_STATE_SCRIPT, databaseFilePath];
  if (markerValue !== undefined) {
    argumentsList.push(markerValue);
  }
  const stdout = runPackageNode(runtimeNode, argumentsList, { cwd: workingDirectory });
  try {
    return JSON.parse(stdout);
  } catch {
    return fail(`无法解析包内 node:sqlite 的状态输出：${stdout.slice(0, 400)}`);
  }
}

function assertMigrationsFinished(state, expectedNames, phase) {
  const recorded = Array.isArray(state.migrations) ? state.migrations : [];
  const recordedNames = recorded.map((row) => row.name).sort();
  const expected = [...expectedNames].sort();
  if (recordedNames.length !== expected.length || recordedNames.some((name, index) => name !== expected[index])) {
    fail(
      `${phase}：_prisma_migrations 记录 ${JSON.stringify(recordedNames)} 与预期 ${JSON.stringify(expected)} 不一致`
    );
  }
  for (const row of recorded) {
    if (row.finished_at === null || row.finished_at === undefined) {
      fail(`${phase}：migration ${row.name} 未完成（finished_at 为空）`);
    }
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[UPGRADE] SKIP：升级链路测试依赖包内 runtime/node.exe，只能在 Windows 上执行。');
    return;
  }

  const packageRoot = resolve(parsePackageArgument(process.argv.slice(2)) ?? '');
  if (!existsSync(join(packageRoot, 'release-manifest.json'))) {
    fail(
      `用法：node scripts/test-release-upgrade.mjs --package <release 包目录>；未找到 ${join(packageRoot, 'release-manifest.json')}`
    );
  }

  const manifest = JSON.parse(await readFile(join(packageRoot, 'release-manifest.json'), 'utf8'));
  const prismaCliRelativePath = manifest?.prisma?.cli?.path;
  if (typeof prismaCliRelativePath !== 'string' || prismaCliRelativePath.length === 0) {
    fail('release-manifest.json 未声明 prisma.cli.path，无法定位包内 Prisma CLI');
  }

  const runtimeNode = toPackagePath(packageRoot, 'runtime/node.exe');
  const prismaCli = toPackagePath(packageRoot, prismaCliRelativePath);
  const schemaPath = toPackagePath(packageRoot, SCHEMA_RELATIVE_PATH);
  const migrationsDirectory = toPackagePath(packageRoot, MIGRATIONS_RELATIVE_PATH);
  for (const [label, path] of [
    ['runtime/node.exe', runtimeNode],
    ['Prisma CLI', prismaCli],
    ['Prisma schema', schemaPath],
    ['Prisma migrations', migrationsDirectory]
  ]) {
    if (!existsSync(path)) {
      fail(`正式包缺少 ${label}：${path}`);
    }
  }

  const migrationNames = readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (migrationNames.length < 2) {
    fail(`至少需要 2 个 migration 才能验证升级链路，实际只有 ${migrationNames.length} 个`);
  }
  const [firstMigrationName] = migrationNames;

  log(`目标发行包：${packageRoot}`);
  log(`发现 ${migrationNames.length} 个 migration，旧库将只应用第一个：${firstMigrationName}`);

  const scratchRoot = await mkdtemp(join(tmpdir(), 'dafan-upgrade-'));
  const scratchPackage = join(scratchRoot, 'package');
  try {
    log(`scratch 目录：${scratchRoot}（正在复制发行包，包含 node_modules，请稍候）`);
    robocopyDirectory(packageRoot, scratchPackage);
    for (const name of ['data', 'logs']) {
      rmSync(join(scratchPackage, name), { recursive: true, force: true });
    }
    mkdirSync(join(scratchPackage, 'data'), { recursive: true });
    log('scratch 就绪：已复制发行包并重置 data/，模拟用户用旧 data 换新包前的干净状态');

    const scratchRuntimeNode = toPackagePath(scratchPackage, 'runtime/node.exe');
    const scratchPrismaCli = toPackagePath(scratchPackage, prismaCliRelativePath);
    const scratchSchemaPath = toPackagePath(scratchPackage, SCHEMA_RELATIVE_PATH);
    const scratchMigrationsDirectory = toPackagePath(scratchPackage, MIGRATIONS_RELATIVE_PATH);

    const legacyPrismaDirectory = join(scratchRoot, 'legacy-prisma');
    const legacyMigrationsDirectory = join(legacyPrismaDirectory, 'migrations');
    mkdirSync(legacyMigrationsDirectory, { recursive: true });
    copyFileSync(scratchSchemaPath, join(legacyPrismaDirectory, 'schema.prisma'));
    copyFileSync(
      join(scratchMigrationsDirectory, 'migration_lock.toml'),
      join(legacyMigrationsDirectory, 'migration_lock.toml')
    );
    cpSync(join(scratchMigrationsDirectory, firstMigrationName), join(legacyMigrationsDirectory, firstMigrationName), {
      recursive: true
    });

    const databaseFilePath = join(scratchPackage, 'data', 'app.db');
    const databaseUrl = `file:${databaseFilePath.split('\\').join('/')}`;
    const markerValue = `${MARKER_PREFIX}${Date.now()}`;

    log(`步骤 1/5：构造旧版库（隔离 prisma 目录，仅应用 ${firstMigrationName}）`);
    runMigrateDeploy(
      scratchRuntimeNode,
      scratchPrismaCli,
      join(legacyPrismaDirectory, 'schema.prisma'),
      legacyPrismaDirectory,
      databaseUrl,
      '旧版库'
    );

    log('步骤 2/5：向旧库 Settings.appName 写入标记数据');
    const legacyState = readDatabaseState(scratchRuntimeNode, scratchPackage, databaseFilePath, markerValue);
    if (legacyState.appName !== markerValue) {
      fail(`标记数据写入失败：Settings.appName=${JSON.stringify(legacyState.appName)}`);
    }
    assertMigrationsFinished(legacyState, [firstMigrationName], '旧版库');
    log(`旧库就绪：Settings.appName=${markerValue}，_prisma_migrations 仅含 ${firstMigrationName}`);

    log('步骤 3/5：模拟 start.bat 启动时的 migrate deploy（完整 migrations，覆盖升级）');
    runMigrateDeploy(
      scratchRuntimeNode,
      scratchPrismaCli,
      scratchSchemaPath,
      legacyPrismaDirectory,
      databaseUrl,
      '完整迁移'
    );

    log('步骤 4/5：断言全部迁移完成且标记数据保留');
    const upgradedState = readDatabaseState(scratchRuntimeNode, scratchPackage, databaseFilePath);
    if (upgradedState.appName !== markerValue) {
      fail(`升级后标记数据丢失：Settings.appName=${JSON.stringify(upgradedState.appName)}`);
    }
    log(`标记数据保留：Settings.appName=${markerValue}`);
    assertMigrationsFinished(upgradedState, migrationNames, '完整迁移');
    log(`${migrationNames.length} 个 migration 的 finished_at 均非空`);

    log('步骤 5/5：再次 migrate deploy 验证幂等');
    runMigrateDeploy(
      scratchRuntimeNode,
      scratchPrismaCli,
      scratchSchemaPath,
      legacyPrismaDirectory,
      databaseUrl,
      '幂等重跑'
    );
    const finalState = readDatabaseState(scratchRuntimeNode, scratchPackage, databaseFilePath);
    if (finalState.appName !== markerValue) {
      fail(`幂等重跑后标记数据丢失：Settings.appName=${JSON.stringify(finalState.appName)}`);
    }
    assertMigrationsFinished(finalState, migrationNames, '幂等重跑后');

    log(`升级链路测试通过：旧 data/app.db + 新包 migrate deploy = 迁移完整且数据不丢（${packageRoot}）`);
  } finally {
    log(`清理 scratch 目录：${scratchRoot}`);
    await rm(scratchRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 }).catch((error) => {
      console.warn(
        `[UPGRADE] WARN：scratch 清理失败（可手动删除）：${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
}

try {
  await main();
} catch (error) {
  console.error(`[UPGRADE] FAIL：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
