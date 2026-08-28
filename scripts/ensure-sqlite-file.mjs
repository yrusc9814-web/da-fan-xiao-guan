import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDirectory = resolve(projectRoot, 'app/server/prisma');
const databaseUrl = process.env.DATABASE_URL ?? 'file:../../../data/app.db';

// 本脚本在 prisma.config 的数据库守卫之前运行（npm run prisma:migrate 等链路 ensure 在前），
// 一旦 mkdir/open 就已经对目标文件产生写窗口。因此 NODE_ENV=test 且未显式提供 DATABASE_URL、
// 即将回退到开发库 data/app.db 时，必须在这里先于任何文件操作中止。
if (process.env.NODE_ENV === 'test' && process.env.DATABASE_URL === undefined) {
  throw new Error(
    '[测试数据库安全闸] NODE_ENV=test 环境禁止把建库目标回退到开发数据库 data/app.db。' +
      '请显式设置 DATABASE_URL / TEST_DATABASE_URL（例如 file:../../../data/test.db）；' +
      '官方测试链路请使用仓库根目录 npm test。'
  );
}

if (databaseUrl.startsWith('file:')) {
  const rawPath = databaseUrl.slice('file:'.length);
  const databasePath = rawPath.startsWith('/') ? rawPath : resolve(schemaDirectory, rawPath);

  // NODE_ENV=test 时，即使显式提供了 DATABASE_URL，也禁止把它解析到开发库本身。
  if (process.env.NODE_ENV === 'test') {
    const developmentDatabasePath = resolve(projectRoot, 'data/app.db');
    const resolvedDatabasePath = resolve(databasePath);
    const isDevelopmentDatabase =
      process.platform === 'win32'
        ? resolvedDatabasePath.toLowerCase() === developmentDatabasePath.toLowerCase()
        : resolvedDatabasePath === developmentDatabasePath;

    if (isDevelopmentDatabase) {
      throw new Error(
        `[测试数据库安全闸] NODE_ENV=test 环境禁止对开发数据库 ${developmentDatabasePath} 建库或写入。` +
          '请把 DATABASE_URL 指向独立测试库，例如 file:../../../data/test.db；官方测试链路请使用仓库根目录 npm test。'
      );
    }
  }

  await mkdir(dirname(databasePath), { recursive: true });
  const handle = await open(databasePath, 'a');
  await handle.close();
}
