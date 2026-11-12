import { basename, resolve } from 'node:path';
import {
  assertDistinctTestStoragePaths,
  assertSafeTestDatabaseUrl,
  assertTestStorageOutsideFormalBoundary,
  resolveStoragePaths,
  validateStoragePaths
} from '../../src/database/paths.js';

// 服务端 vitest 必须在 NODE_ENV=test 下运行：vitest 只在 NODE_ENV 未设置时才自动置为 'test'
// （??= 语义不会覆盖 shell 里已固定的值）。若 NODE_ENV=development/production 直跑 vitest，
// 即使 TEST_DATABASE_URL 安全，client.ts 的模块级单例也会走非 test 分支静默连接
// DATABASE_URL/默认的开发库 data/app.db，因此必须在加载任何数据库模块前拦截。
if (process.env.NODE_ENV !== 'test') {
  const actualNodeEnv = process.env.NODE_ENV ?? '（未设置）';
  throw new Error(
    `[测试数据库安全闸] 服务端 vitest 必须在 NODE_ENV=test 下运行，实际收到 NODE_ENV=${actualNodeEnv}。` +
      '非 test 环境会导致测试进程走开发分支静默连接开发数据库 data/app.db，已立即中止。' +
      '官方测试链路请使用仓库根目录 npm test。'
  );
}

assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
if (process.env.DAFAN_ISOLATION_ROOT !== undefined) {
  const root = process.env.DAFAN_ISOLATION_ROOT;
  const paths = validateStoragePaths(resolveStoragePaths(), root);
  if (!/^test(?:[-_.][a-z0-9_-]*)?\.db$/i.test(basename(paths.databaseRealPath)))
    throw new Error('isolated tests require independent test*.db');
  for (const path of [paths.uploadsRealPath, paths.backupsRealPath]) {
    if (
      [resolve(root, 'data/uploads'), resolve(root, 'data/backups')].some(
        (value) => value.toLowerCase() === path.toLowerCase()
      )
    )
      throw new Error('isolated tests cannot use Browser storage');
  }
} else {
  // 未显式提供隔离 root 的测试进程同样禁止回落正式存储：paths.ts 的默认
  // uploads/backups 是正式 data/uploads|backups，缺失显式覆盖时 backup restore
  // 等写入型测试会对正式 uploads 执行 rm+rename 目录替换。官方 npm test 由
  // scripts/test-storage-environment.mjs 注入 OS 临时目录下的一次性 scratch。
  // 边界判定统一走 paths.ts 的安全闸模型：父子目录、交叉配置、路径规范化
  // （设备前缀、符号链接、大小写、冗余分隔符）与"包含正式存储的祖先目录"全部拒绝。
  const storageEntries = (['DAFAN_UPLOADS_PATH', 'DAFAN_BACKUPS_PATH'] as const).map((name) => ({
    name,
    path: process.env[name]
  }));
  for (const { name, path } of storageEntries) {
    if (path === undefined || path.trim() === '')
      throw new Error(
        `[测试存储安全闸] NODE_ENV=test 且未设置 DAFAN_ISOLATION_ROOT 时必须显式设置 ${name}。` +
          '缺失时会回落到正式存储 data/uploads|backups，backup restore 等写入型测试会写入并重建正式目录。' +
          '请使用仓库根目录 npm test（自动注入一次性 scratch）。'
      );
  }
  assertTestStorageOutsideFormalBoundary(storageEntries.map(({ name, path }) => ({ name, path: path! })));
  assertDistinctTestStoragePaths(storageEntries.map(({ name, path }) => ({ name, path: path! })));
}
