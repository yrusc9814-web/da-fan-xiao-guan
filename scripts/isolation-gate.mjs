import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const repository = resolve(import.meta.dirname, '..');

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isInside(root, value) {
  const rel = relative(root, value);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * 隔离根不再硬编码为原开发机路径，只能由 DAFAN_ISOLATION_ROOT 显式提供。
 * 未设置时返回 undefined，保证常规 import 与 npm test 仍可加载；
 * 一旦设置，必须是仓库外已存在的绝对目录，且本身不是 symlink/junction。
 * 不存在任何默认回退。
 */
export function resolveConfiguredIsolationRoot(source = process.env) {
  const raw = source.DAFAN_ISOLATION_ROOT;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '')
    throw new Error('DAFAN_ISOLATION_ROOT must be a non-empty absolute path');
  const value = raw.trim();
  if (!isAbsolute(value)) throw new Error(`DAFAN_ISOLATION_ROOT must be an absolute path: ${value}`);
  const normalized = resolve(value);
  if (isInside(repository, normalized))
    throw new Error(`DAFAN_ISOLATION_ROOT must be outside the repository: ${normalized}`);
  let real;
  try {
    real = realpathSync(normalized);
  } catch (error) {
    throw new Error(
      `DAFAN_ISOLATION_ROOT must be an existing directory: ${normalized} (${error.code ?? error.message})`
    );
  }
  if (!samePath(normalized, real) || lstatSync(normalized).isSymbolicLink())
    throw new Error(`DAFAN_ISOLATION_ROOT must not be a symlink/junction: ${normalized}`);
  if (!statSync(real).isDirectory()) throw new Error(`DAFAN_ISOLATION_ROOT must be a directory: ${normalized}`);
  return normalized;
}

export function requireIsolationRoot(source = process.env) {
  const root = resolveConfiguredIsolationRoot(source);
  if (root === undefined)
    throw new Error(
      'DAFAN_ISOLATION_ROOT is required for isolated tooling: set it to an existing absolute scratch directory outside the repository'
    );
  return root;
}

// 兼容旧导出名；未配置时为 undefined，显式配置时经过同样校验。
export const isolationRoot = resolveConfiguredIsolationRoot(process.env);

export function fingerprintBuild() {
  const files = {};
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        files[relative(repository, path).replaceAll('\\', '/')] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex');
      else throw new Error(`non-regular build input: ${path}`);
    }
  }
  for (const directory of ['app/server/src', 'app/shared', 'dist-server']) walk(resolve(repository, directory));
  for (const name of [
    'app/server/tsconfig.json',
    'app/server/tsconfig.build.json',
    'app/server/package.json',
    'scripts/clean-server-build.mjs',
    'scripts/isolation-gate.mjs',
    'scripts/formal-storage-gate.mjs',
    'scripts/snapshot-formal-storage.mjs',
    'scripts/check-isolated-port.mjs',
    'scripts/resolve-storage-paths.mjs',
    'scripts/start-isolated.mjs',
    'scripts/isolated-service.mjs'
  ]) {
    files[name] = createHash('sha256')
      .update(readFileSync(resolve(repository, name)))
      .digest('hex');
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
export function verifyBuildReceipt(receipt, files = fingerprintBuild()) {
  if (
    receipt.schemaVersion !== 1 ||
    receipt.repository !== repository ||
    JSON.stringify(receipt.files) !== JSON.stringify(files)
  ) {
    throw new Error('stale build: rerun node scripts/prepare-isolated-build.mjs');
  }
}
export function assertFreshBuild(source = process.env) {
  const receipt = JSON.parse(
    readFileSync(resolve(requireIsolationRoot(source), 'evidence/build-receipt.json'), 'utf8')
  );
  verifyBuildReceipt(receipt);
}
export function isolatedEnvironment(input = process.env) {
  const ambient = resolveConfiguredIsolationRoot(process.env);
  const root = requireIsolationRoot(input);
  if (ambient !== undefined && root !== ambient)
    throw new Error(`immutable isolation root mismatch: ${root} !== ${ambient}`);
  if (input.NODE_ENV !== 'production') throw new Error('isolated service requires explicit NODE_ENV=production');
  if (input.HOST !== '127.0.0.1') throw new Error('isolated service requires HOST=127.0.0.1');
  if (!/^\d+$/.test(input.PORT ?? '') || Number(input.PORT) < 1 || Number(input.PORT) > 65535)
    throw new Error('explicit valid PORT required');
  for (const name of ['DAFAN_DATABASE_PATH', 'DAFAN_UPLOADS_PATH', 'DAFAN_BACKUPS_PATH'])
    if (!input[name]) throw new Error(`${name} required`);
  return { ...input };
}
export async function configuration(env, built = false) {
  const root = requireIsolationRoot(env);
  const paths = await import(
    built ? '../dist-server/server/src/database/paths.js' : '../app/server/src/database/paths.ts'
  );
  const checked = paths.validateStoragePaths(paths.resolveStoragePaths(env), root);
  if (statSync(checked.databaseRealPath).nlink !== 1) throw new Error('DB hard link forbidden');
  return {
    root: checked.root,
    database: checked.databaseRealPath,
    uploads: checked.uploadsRealPath,
    backups: checked.backupsRealPath,
    temporary: paths.resolveIsolationTempDirectory(env),
    cwd: repository,
    host: env.HOST,
    port: Number(env.PORT),
    nodeEnv: env.NODE_ENV
  };
}
