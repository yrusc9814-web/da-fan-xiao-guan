import { assertSafeTestDatabaseUrl } from '../../src/database/paths.js';

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
