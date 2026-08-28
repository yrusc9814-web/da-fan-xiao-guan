import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const schemaDirectory = resolve(projectRoot, 'app/server/prisma');

export const defaultDatabaseUrl = 'file:../../../data/app.db';

export function filePathFromDatabaseUrl(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith('file:')) {
    return null;
  }

  const databasePath = databaseUrl.slice('file:'.length);
  return databasePath.startsWith('/') ? databasePath : resolve(schemaDirectory, databasePath);
}

function resolveFileUrlPath(databaseUrl: string): string {
  const databasePath = databaseUrl.slice('file:'.length);
  const queryOrFragmentIndex = databasePath.search(/[?#]/);
  const rawPath = queryOrFragmentIndex === -1 ? databasePath : databasePath.slice(0, queryOrFragmentIndex);

  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    decodedPath = rawPath;
  }

  return isAbsolute(decodedPath) ? resolve(decodedPath) : resolve(schemaDirectory, decodedPath);
}

/**
 * 计算同一个数据库 URL 可能指向的候选文件路径集合（解析策略并集，fail-closed）。
 *
 * 策略 1（naive）：沿用历史解析——截断 query/fragment → decodeURIComponent → 绝对路径直接使用、
 * 相对路径基于 schema 目录补全。覆盖 `file:relative`、`file:/abs`、`?query`、`#fragment` 等形态。
 *
 * 策略 2（WHATWG）：与 Node/Prisma 实际使用的 WHATWG file URL 语义保持一致。覆盖
 * 三斜杠 `file:///D:/...`、`file://D:/...`、`file://localhost/...`、百分号编码盘符
 * `file:///%44%3A/...` 等 naive 解析（尤其 Windows path.resolve）会算错、
 * 而数据库引擎却能解析到真实文件的形态。其中 fileURLToPath 拒绝的
 * `//D:/...`（host 归一化后重复斜杠紧邻盘符，如 `file://localhost//D:/...`）形态，
 * 由"盘符前斜杠恢复"子策略补齐：部分解析器折叠斜杠后仍会落到真实文件。
 *
 * 危险判定取候选并集：任一候选命中开发库即判危险——宁可误杀，不可放行。
 */
function collectCandidateDatabasePaths(databaseUrl: string): string[] {
  const candidates: string[] = [resolveFileUrlPath(databaseUrl)];

  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol === 'file:') {
      try {
        candidates.push(fileURLToPath(parsed));
      } catch {
        // fileURLToPath 拒绝 `//D:/...` 等形态（File URL path must be absolute），由恢复候选兜底
      }

      let decodedPathname = parsed.pathname;
      try {
        decodedPathname = decodeURIComponent(parsed.pathname);
      } catch {
        // 坏百分号编码时保持原样，由后续匹配兜底
      }

      const driveLetterRecovery = /^\/+([A-Za-z]:.*)$/.exec(decodedPathname);
      if (driveLetterRecovery) {
        candidates.push(resolve(driveLetterRecovery[1]));
      }
    }
  } catch {
    // 非 WHATWG 合法 URL（非法主机名、坏百分号编码等）时忽略，由 naive 分支兜底判定
  }

  return candidates;
}

function isSameDatabaseFile(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);

  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function assertSafeTestDatabaseUrl(databaseUrl: string | undefined): asserts databaseUrl is string {
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error(
      '[测试数据库安全闸] NODE_ENV=test 时必须显式设置 TEST_DATABASE_URL（检测到缺失或空值）。' +
        '为防止测试误连开发数据库 data/app.db，已在任何数据库连接建立前中止。' +
        '请使用仓库根目录 npm test，或显式设置 TEST_DATABASE_URL，例如 file:../../../data/test.db。'
    );
  }

  if (!databaseUrl.toLowerCase().startsWith('file:')) {
    return;
  }

  const developmentDatabasePath = filePathFromDatabaseUrl(defaultDatabaseUrl)!;
  const targetsDevelopmentDatabase = collectCandidateDatabasePaths(databaseUrl).some((candidate) =>
    isSameDatabaseFile(candidate, developmentDatabasePath)
  );

  if (targetsDevelopmentDatabase) {
    throw new Error(
      `[测试数据库安全闸] 该 TEST_DATABASE_URL 解析到了开发数据库 ${developmentDatabasePath}，测试禁止连接开发库。` +
        '请改用独立测试库，例如 file:../../../data/test.db。'
    );
  }
}

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NODE_ENV === 'test') {
    const testUrl = env.TEST_DATABASE_URL;
    assertSafeTestDatabaseUrl(testUrl);
    if (!testUrl.startsWith('file:')) {
      return testUrl;
    }
    const absolutePath = filePathFromDatabaseUrl(testUrl);
    return absolutePath ? `file:${absolutePath}` : testUrl;
  }

  const rawUrl = env.DATABASE_URL ?? defaultDatabaseUrl;
  if (!rawUrl.startsWith('file:')) {
    return rawUrl;
  }
  const absolutePath = filePathFromDatabaseUrl(rawUrl);
  return absolutePath ? `file:${absolutePath}` : rawUrl;
}
