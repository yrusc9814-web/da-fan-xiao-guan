import { register } from 'tsx/esm/api';
import { mkdir, mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
register();
const paths = await import('../app/server/src/database/paths.ts');

/**
 * 无显式隔离 root 时的 uploads/backups 测试存储解析：
 * 缺省注入 OS 临时目录下的一次性 scratch（每轮唯一），绝不回落 paths.ts 的正式默认
 * data/uploads|backups —— 否则 backup restore 等写入型测试会对正式 uploads 执行
 * 目录替换（rm+rename）。操作者显式提供的绝对路径被尊重，但统一安全闸
 * （assertTestStorageOutsideFormalBoundary）会在创建任何目录之前 fail-closed 拒绝
 * 一切落入或包含正式存储边界的路径：父子目录、交叉配置（uploads↔backups）、
 * 路径规范化（\\?\ 前缀、符号链接/junction、大小写、冗余分隔符）均不可绕过。
 */
async function resolveTestScratchDirectory(explicit, name) {
  if (explicit !== undefined && explicit.trim() !== '') {
    paths.assertTestStorageOutsideFormalBoundary([{ name, path: explicit }]);
    const candidate = resolve(explicit.trim());
    await mkdir(candidate, { recursive: true });
    return candidate;
  }
  const scratch = join(
    await mkdtemp(join(tmpdir(), 'dafan-test-storage-')),
    name === 'DAFAN_UPLOADS_PATH' ? 'uploads' : 'backups'
  );
  await mkdir(scratch, { recursive: true });
  paths.assertTestStorageOutsideFormalBoundary([{ name, path: scratch }]);
  return scratch;
}

export async function testEnvironment(input = process.env) {
  const root = input.DAFAN_ISOLATION_ROOT;
  const url = input.TEST_DATABASE_URL ?? 'file:../../../data/test.db';
  const env = { ...input, NODE_ENV: 'test', DATABASE_URL: url, TEST_DATABASE_URL: url };
  if (root !== undefined) {
    const db = paths.filePathFromDatabaseUrl(url);
    if (!db || !/^test(?:[-_.][a-z0-9_-]*)?\.db$/i.test(basename(db)))
      throw new Error('isolated tests require an independent test*.db, never Browser app.db');
    env.DAFAN_DATABASE_PATH = db;
    for (const name of ['DAFAN_UPLOADS_PATH', 'DAFAN_BACKUPS_PATH'])
      if (!env[name]) throw new Error(`explicit isolated test ${name} required`);
    for (const path of [db, env.DAFAN_UPLOADS_PATH, env.DAFAN_BACKUPS_PATH]) paths.assertIsolatedPath(path, root);
    // 隔离 root 分支同样禁止指向 Browser 存储范围：除相等比较外，统一安全闸
    // 再拦截"落入或包含 Browser uploads/backups"的全部规范化绕过形态
    paths.assertTestStorageOutsideFormalBoundary(
      [
        { name: 'DAFAN_DATABASE_PATH', path: db },
        { name: 'DAFAN_UPLOADS_PATH', path: env.DAFAN_UPLOADS_PATH },
        { name: 'DAFAN_BACKUPS_PATH', path: env.DAFAN_BACKUPS_PATH }
      ],
      [
        { label: 'Browser uploads 目录', path: resolve(root, 'data/uploads') },
        { label: 'Browser backups 目录', path: resolve(root, 'data/backups') }
      ]
    );
    paths.assertDistinctTestStoragePaths([
      { name: 'DAFAN_UPLOADS_PATH', path: env.DAFAN_UPLOADS_PATH },
      { name: 'DAFAN_BACKUPS_PATH', path: env.DAFAN_BACKUPS_PATH }
    ]);
    await mkdir(resolve(db, '..'), { recursive: true });
    await mkdir(env.DAFAN_UPLOADS_PATH, { recursive: true });
    await mkdir(env.DAFAN_BACKUPS_PATH, { recursive: true });
    const handle = await open(db, 'a');
    await handle.close();
    paths.validateStoragePaths(paths.resolveStoragePaths(env), root);
  } else {
    paths.assertSafeTestDatabaseUrl(url);
    const uploads = await resolveTestScratchDirectory(input.DAFAN_UPLOADS_PATH, 'DAFAN_UPLOADS_PATH');
    const backups = await resolveTestScratchDirectory(input.DAFAN_BACKUPS_PATH, 'DAFAN_BACKUPS_PATH');
    paths.assertDistinctTestStoragePaths([
      { name: 'DAFAN_UPLOADS_PATH', path: uploads },
      { name: 'DAFAN_BACKUPS_PATH', path: backups }
    ]);
    env.DAFAN_UPLOADS_PATH = uploads;
    env.DAFAN_BACKUPS_PATH = backups;
  }
  return env;
}
