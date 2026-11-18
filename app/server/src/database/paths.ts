import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import '../config/env.js';
import { fileURLToPath } from 'node:url';
import type { Stats } from 'node:fs';

function isInside(root: string, value: string): boolean {
  const rel = relative(root, value);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export interface ResolvedStoragePaths {
  databaseUrl: string;
  databasePath: string | null;
  uploadsDirectory: string;
  backupsDirectory: string;
}

export interface ValidatedStoragePaths extends ResolvedStoragePaths {
  root: string;
  databaseRealPath: string;
  uploadsRealPath: string;
  backupsRealPath: string;
}

export function assertIsolatedPath(path: string, isolationRoot = process.env.DAFAN_ISOLATION_ROOT): void {
  if (isolationRoot === undefined) return;
  if (!isolationRoot.trim() || !isAbsolute(isolationRoot)) throw new Error('DAFAN_ISOLATION_ROOT 必须是非空绝对路径');
  const root = realpathSync(isolationRoot);
  if (!samePath(resolve(isolationRoot), root) || lstatSync(isolationRoot).isSymbolicLink()) {
    throw new Error('隔离根禁止 symlink/junction');
  }
  const candidate = resolve(path);
  if (!isInside(root, candidate)) throw new Error(`path escapes isolation root: ${candidate}`);
  let existing = candidate;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('无法解析隔离路径');
    existing = parent;
  }
  if (!isInside(root, realpathSync(existing))) throw new Error(`real path escapes isolation root: ${candidate}`);
  for (let current = existing; isInside(root, current) && !samePath(current, root); current = dirname(current)) {
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error(`隔离路径禁止 symlink/junction: ${current}`);
    if (metadata.isFile() && metadata.nlink > 1) throw new Error(`隔离文件禁止硬链接: ${current}`);
  }
}

function validateTree(directory: string, root: string): void {
  assertIsolatedPath(directory, root);
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    assertIsolatedPath(path, root);
    if (entry.isDirectory()) validateTree(path, root);
  }
}

export function validateStoragePaths(paths: ResolvedStoragePaths, isolationRoot: string): ValidatedStoragePaths {
  if (!isolationRoot.trim() || !isAbsolute(isolationRoot)) throw new Error('DAFAN_ISOLATION_ROOT 必须是非空绝对路径');
  const root = realpathSync(isolationRoot);
  for (const value of [paths.databasePath, paths.uploadsDirectory, paths.backupsDirectory]) {
    if (value) assertIsolatedPath(value, root);
  }
  if (!paths.databasePath) throw new Error('隔离启动仅支持本地 SQLite 数据库');
  const databaseRealPath = realpathSync(paths.databasePath);
  const uploadsRealPath = realpathSync(paths.uploadsDirectory);
  const backupsRealPath = realpathSync(paths.backupsDirectory);
  const dbStat: Stats = statSync(databaseRealPath);
  const uploadStat = statSync(uploadsRealPath);
  const backupStat = statSync(backupsRealPath);
  if (!dbStat.isFile()) throw new Error(`databasePath 不是文件: ${databaseRealPath}`);
  if (!uploadStat.isDirectory()) throw new Error(`uploadsDirectory 不是目录: ${uploadsRealPath}`);
  if (!backupStat.isDirectory()) throw new Error(`backupsDirectory 不是目录: ${backupsRealPath}`);
  if (dbStat.nlink > 1) throw new Error(`databasePath 存在硬链接 (nlink=${dbStat.nlink})`);
  const values = [databaseRealPath, uploadsRealPath, backupsRealPath];
  if (
    new Set(values.map((value) => (process.platform === 'win32' ? value.toLowerCase() : value))).size !== values.length
  ) {
    throw new Error('storage paths must be distinct');
  }
  for (const [name, value] of [
    ['databasePath', databaseRealPath],
    ['uploadsDirectory', uploadsRealPath],
    ['backupsDirectory', backupsRealPath]
  ] as const) {
    if (!isInside(root, value)) throw new Error(`${name} escapes isolation root: ${value}`);
  }
  validateTree(uploadsRealPath, root);
  validateTree(backupsRealPath, root);
  validateTree(resolve(root, '.tmp'), root);
  for (const suffix of ['-wal', '-shm', '-journal']) assertIsolatedPath(`${databaseRealPath}${suffix}`, root);
  return { ...paths, root, databaseRealPath, uploadsRealPath, backupsRealPath };
}

export function assertDatabaseEnvironment(env: NodeJS.ProcessEnv): void {
  const testValue = env.TEST_DATABASE_URL?.trim();
  const overrideValue = env.DAFAN_DATABASE_PATH?.trim();
  if (env.NODE_ENV === 'test' && (!testValue || testValue === '')) assertSafeTestDatabaseUrl(testValue);
  if (env.DAFAN_DATABASE_PATH !== undefined && (!overrideValue || !isAbsolute(overrideValue))) {
    throw new Error('DAFAN_DATABASE_PATH 必须是非空绝对路径');
  }
  if (overrideValue) {
    const selectedUrl = env.NODE_ENV === 'test' ? testValue : env.DATABASE_URL;
    if (selectedUrl !== undefined) {
      const selectedPath = filePathFromDatabaseUrl(selectedUrl);
      if (!selectedPath || !samePath(resolve(overrideValue), resolve(selectedPath))) {
        throw new Error('DAFAN_DATABASE_PATH 与数据库 URL 冲突');
      }
    }
  }
  if (env.DAFAN_ISOLATION_ROOT !== undefined) {
    if (!overrideValue || !env.DAFAN_UPLOADS_PATH || !env.DAFAN_BACKUPS_PATH) {
      throw new Error('隔离模式要求显式设置全部 storage overrides');
    }
  }
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const schemaDirectory = resolve(projectRoot, 'app/server/prisma');

export const defaultDatabaseUrl = 'file:../../../data/app.db';

const defaultUploadsDirectory = resolve(projectRoot, 'data/uploads');
const defaultBackupsDirectory = resolve(projectRoot, 'data/backups');

function configuredDirectory(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  if (value === undefined) return fallback;
  const raw = value.trim();
  if (raw === '') throw new Error(`${name} 不能是空路径`);
  if (!isAbsolute(raw)) throw new Error(`${name} 必须是绝对路径`);
  const candidate = resolve(raw);
  assertIsolatedPath(candidate, env.DAFAN_ISOLATION_ROOT);
  return candidate;
}

export function resolveUploadsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return configuredDirectory(env, 'DAFAN_UPLOADS_PATH', defaultUploadsDirectory);
}

export function resolveBackupsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return configuredDirectory(env, 'DAFAN_BACKUPS_PATH', defaultBackupsDirectory);
}

export function resolveStoragePaths(env: NodeJS.ProcessEnv = process.env): ResolvedStoragePaths {
  const databaseUrl = resolveDatabaseUrl(env);
  const paths = {
    databaseUrl,
    databasePath: filePathFromDatabaseUrl(databaseUrl),
    uploadsDirectory: resolveUploadsDirectory(env),
    backupsDirectory: resolveBackupsDirectory(env)
  };
  if (env.DAFAN_ISOLATION_ROOT !== undefined) validateStoragePaths(paths, env.DAFAN_ISOLATION_ROOT);
  return paths;
}

export const storageConfigEnvNames = ['DAFAN_DATABASE_PATH', 'DAFAN_UPLOADS_PATH', 'DAFAN_BACKUPS_PATH'] as const;

export function resolveIsolationTempDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DAFAN_ISOLATION_ROOT === undefined) return tmpdir();
  const path = configuredDirectory(env, 'DAFAN_ISOLATION_ROOT', projectRoot);
  const temporary = resolve(path, '.tmp');
  assertIsolatedPath(temporary, path);
  return temporary;
}

/**
 * 恢复暂存/回滚目录必须与正式数据库同卷（backup service 的 assertSameStorageVolume）。
 * 显式隔离 root 时沿用隔离临时目录；NODE_ENV=test 且无隔离 root 时取实际测试库父目录，
 * 使外部 TEST_DATABASE_URL（如 os.tmpdir 下独立 test*.db）不必与仓库 data 同盘。
 * 测试分支复用既有安全闸（resolveDatabaseUrl → assertDatabaseEnvironment /
 * assertSafeTestDatabaseUrl），缺失/危险 URL 或非本地 SQLite 一律 fail-closed，
 * 绝不回落到正式 data 目录。非 test 保持仓库 data 默认行为。
 */
export function resolveRestoreTempDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DAFAN_ISOLATION_ROOT !== undefined) return resolveIsolationTempDirectory(env);
  if (env.NODE_ENV === 'test') {
    const databasePath = filePathFromDatabaseUrl(resolveDatabaseUrl(env));
    if (!databasePath) throw new Error('恢复暂存区仅支持本地 SQLite 测试数据库');
    return dirname(databasePath);
  }
  return resolve(projectRoot, 'data');
}

export function filePathFromDatabaseUrl(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith('file:')) {
    return null;
  }

  const databasePath = databaseUrl.slice('file:'.length);
  if (databasePath.startsWith('//')) return fileURLToPath(databaseUrl);
  return isAbsolute(databasePath) ? resolve(databasePath) : resolve(schemaDirectory, databasePath);
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

/** 链接展开的最大层数：超过视为循环/异常，fail-closed。 */
const MAX_COMPARABLE_LINK_HOPS = 32;

/** 去掉 Windows 扩展路径前缀（\\?\ / \\?\UNC\），链接目标可能带此前缀。 */
function stripWindowsDevicePrefix(path: string): string {
  if (process.platform !== 'win32') return path;
  if (/^\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\\?\\/i.test(path)) return path.slice(4);
  return path;
}

/**
 * 找到从 `path` 向上最近的"可确定真实位置"的层级，并把解析结果拼回剩余片段。
 *
 * 与 `existsSync` 逐级上溯的区别：悬空 symlink/junction（目标尚不存在）`existsSync` 为 false，
 * 但它本身是 `lstat` 可见的链接，且 `readlink` 仍能给出目标——这正是正式目录尚未创建时
 * 唯一的线索。跳过它会得到"普通不存在路径"，从而把测试路径误判为与正式范围无关。
 *
 * 返回 null 表示一路到根都没有可解析层级（例如盘符不存在），由调用方按字符串形式保守比较。
 * 链接存在但无法可靠读取/解析时直接抛错（fail-closed），绝不退回"看起来无关"的结果。
 */
function expandNearestResolvable(path: string): string | null {
  const suffix: string[] = [];
  let current = path;
  for (;;) {
    let metadata: Stats | null;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new Error(`[测试存储安全闸] 无法解析路径（访问失败 ${code ?? 'unknown'}）：${current}`);
      }
      metadata = null;
    }

    if (metadata) {
      const rest = suffix.slice().reverse();
      if (metadata.isSymbolicLink()) {
        let target: string;
        try {
          target = readlinkSync(current);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          throw new Error(`[测试存储安全闸] 无法读取链接目标（${code ?? 'unknown'}）：${current}`);
        }
        const resolvedTarget = stripWindowsDevicePrefix(target);
        const targetPath = isAbsolute(resolvedTarget)
          ? resolve(resolvedTarget)
          : resolve(dirname(current), resolvedTarget);
        if (comparableKey(targetPath) === comparableKey(current)) {
          throw new Error(`[测试存储安全闸] 路径链接指向自身，无法可靠解析：${current}`);
        }
        return rest.length === 0 ? targetPath : resolve(targetPath, ...rest);
      }
      let real: string;
      try {
        real = realpathSync(current);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new Error(`[测试存储安全闸] 无法解析真实路径（${code ?? 'unknown'}）：${current}`);
      }
      return rest.length === 0 ? real : resolve(real, ...rest);
    }

    const parent = dirname(current);
    if (parent === current) return null;
    suffix.push(basename(current));
    current = parent;
  }
  return null;
}

/**
 * 统一路径规范化（比较用）：去掉 Windows 扩展路径前缀（\\?\ / \\?\UNC\）→ resolve →
 * 逐层展开链接（含目标尚不存在的悬空 symlink/junction）与 8.3 短名后拼回剩余片段，
 * Windows 下统一小写。任何字符串形态的路径改写（大小写、斜杠、冗余段、设备前缀、
 * 链接重定向、短名）都被归一到同一形式，防止安全闸被"换一种写法"绕过。
 *
 * 悬空链接必须按其目标规范化：正式目录尚未创建时，经悬空链接写入的路径在目录创建后
 * 就是正式范围内部路径，若此处跳过链接就会 fail-open。链接层级过深或成环视为无法可靠
 * 解析，直接抛错（fail-closed）。普通不存在路径仍按最近的已存在祖先规范化。
 */
function canonicalizeComparablePath(path: string): string {
  const raw = stripWindowsDevicePrefix(path.trim());
  let candidate = resolve(raw);
  const seen = new Set<string>([comparableKey(candidate)]);
  for (let hop = 0; hop < MAX_COMPARABLE_LINK_HOPS; hop += 1) {
    const expanded = expandNearestResolvable(candidate);
    if (expanded === null) break;
    const key = comparableKey(expanded);
    if (key === comparableKey(candidate)) break;
    if (seen.has(key)) {
      throw new Error(`[测试存储安全闸] 路径链接存在循环，无法可靠解析：${path.trim()}`);
    }
    seen.add(key);
    candidate = expanded;
    if (hop === MAX_COMPARABLE_LINK_HOPS - 1) {
      throw new Error(`[测试存储安全闸] 路径链接层级过深，无法可靠解析：${path.trim()}`);
    }
  }
  return comparableKey(candidate);
}

/** 比较键：Windows 下大小写不敏感；链接目标已展开，剩余差异仅是字符串书写形式。 */
function comparableKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** 已规范化（resolve 过、必要时已小写）路径之间的包含判定。 */
function isInsideCanonical(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export interface TestStoragePathEntry {
  name: string;
  path: string;
}

export interface FormalStorageRange {
  label: string;
  path: string;
}

/** 正式存储边界（仓库默认路径，与运行环境变量无关——被保护的是正式数据本身）。 */
export function formalStorageRanges(): FormalStorageRange[] {
  return [
    { label: '正式数据库', path: filePathFromDatabaseUrl(defaultDatabaseUrl)! },
    { label: '正式 uploads 目录', path: defaultUploadsDirectory },
    { label: '正式 backups 目录', path: defaultBackupsDirectory }
  ];
}

/**
 * 测试存储统一安全闸（fail-closed）：任何测试可写路径与任一正式存储范围
 * 相等、落入其内、或反过来包含它（rm+rename 目录替换会连带摧毁正式数据）都拒绝。
 * 比较基于 canonicalizeComparablePath，覆盖父子目录、交叉配置、路径规范化、
 * 符号链接重定向等全部绕过形态。错误消息携带原始大小写路径，便于定位。
 */
export function assertTestStorageOutsideFormalBoundary(
  candidates: TestStoragePathEntry[],
  ranges: FormalStorageRange[] = formalStorageRanges()
): void {
  const canonicalRanges = ranges.map((range) => ({ ...range, canonical: canonicalizeComparablePath(range.path) }));
  for (const { name, path } of candidates) {
    if (path === undefined || path === null || path.trim() === '') throw new Error(`[测试存储安全闸] ${name} 不能为空`);
    if (!isAbsolute(path.trim())) throw new Error(`[测试存储安全闸] ${name} 必须是绝对路径，收到：${path}`);
    const displayed = resolve(path.trim());
    const canonical = canonicalizeComparablePath(path);
    for (const range of canonicalRanges) {
      const contained =
        canonical === range.canonical ||
        isInsideCanonical(canonical, range.canonical) ||
        isInsideCanonical(range.canonical, canonical);
      if (contained)
        throw new Error(
          `[测试存储安全闸] ${name} 解析到 ${displayed}，落入或包含${range.label}（${range.path}），测试禁止写入正式存储`
        );
    }
  }
}

/** 多个测试存储路径彼此必须独立（fail-closed）：uploads 与 backups 解析到同一路径时拒绝。 */
export function assertDistinctTestStoragePaths(entries: TestStoragePathEntry[]): void {
  const canonical = entries.map((entry) => ({ ...entry, canonical: canonicalizeComparablePath(entry.path) }));
  for (let i = 0; i < canonical.length; i += 1) {
    for (let j = i + 1; j < canonical.length; j += 1) {
      if (canonical[i].canonical === canonical[j].canonical)
        throw new Error(
          `[测试存储安全闸] ${canonical[i].name} 与 ${canonical[j].name} 解析到同一路径（${canonical[i].canonical}），测试存储必须彼此独立`
        );
    }
  }
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

  // 危险判定取候选并集，并覆盖全部正式存储范围：测试库文件既不能是开发库本身，
  // 也不能落入正式 uploads/backups 目录（会在正式范围内新建/覆盖文件）。
  const dangerousRanges = [
    filePathFromDatabaseUrl(defaultDatabaseUrl)!,
    defaultUploadsDirectory,
    defaultBackupsDirectory
  ].map((range) => canonicalizeComparablePath(range));
  const targetsDevelopmentStorage = collectCandidateDatabasePaths(databaseUrl).some((candidate) => {
    const canonicalCandidate = canonicalizeComparablePath(candidate);
    return dangerousRanges.some(
      (canonicalRange) => canonicalCandidate === canonicalRange || isInsideCanonical(canonicalCandidate, canonicalRange)
    );
  });

  if (targetsDevelopmentStorage) {
    throw new Error(
      `[测试数据库安全闸] 该 TEST_DATABASE_URL 解析到了正式存储范围（开发数据库 ${filePathFromDatabaseUrl(
        defaultDatabaseUrl
      )!} 或其 uploads/backups 目录），测试禁止写入。请改用独立测试库，例如 file:../../../data/test.db。`
    );
  }
}

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  assertDatabaseEnvironment(env);
  if (env.NODE_ENV === 'test') {
    const testUrl = env.TEST_DATABASE_URL;
    assertSafeTestDatabaseUrl(testUrl);
    if (!testUrl.startsWith('file:')) {
      return testUrl;
    }
    const absolutePath = filePathFromDatabaseUrl(testUrl);
    return absolutePath ? `file:${absolutePath}` : testUrl;
  }

  const overridePath = env.DAFAN_DATABASE_PATH;
  const overrideRaw = overridePath?.trim();
  if (overrideRaw !== undefined && overrideRaw !== '' && !isAbsolute(overrideRaw)) {
    throw new Error('DAFAN_DATABASE_PATH 必须是绝对路径');
  }
  const rawUrl =
    overrideRaw !== undefined && overrideRaw !== ''
      ? `file:${resolve(overrideRaw)}`
      : (env.DATABASE_URL ?? defaultDatabaseUrl);
  if (!rawUrl.startsWith('file:')) {
    return rawUrl;
  }
  const absolutePath = filePathFromDatabaseUrl(rawUrl);
  return absolutePath ? `file:${absolutePath}` : rawUrl;
}
