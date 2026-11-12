import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

export const repository = resolve(import.meta.dirname, '..');
export const isolationRoot = 'D:\\Vanta-pro\\google2-isolation-20261003-r1';
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
export function assertFreshBuild() {
  const receipt = JSON.parse(readFileSync(resolve(isolationRoot, 'evidence/build-receipt.json'), 'utf8'));
  verifyBuildReceipt(receipt);
}
export function isolatedEnvironment(input = process.env) {
  if (input.DAFAN_ISOLATION_ROOT !== isolationRoot || realpathSync(isolationRoot) !== isolationRoot)
    throw new Error('immutable isolation root mismatch');
  if (input.NODE_ENV !== 'production') throw new Error('isolated service requires explicit NODE_ENV=production');
  if (input.HOST !== '127.0.0.1') throw new Error('isolated service requires HOST=127.0.0.1');
  if (!/^\d+$/.test(input.PORT ?? '') || Number(input.PORT) < 1 || Number(input.PORT) > 65535)
    throw new Error('explicit valid PORT required');
  for (const name of ['DAFAN_DATABASE_PATH', 'DAFAN_UPLOADS_PATH', 'DAFAN_BACKUPS_PATH'])
    if (!input[name]) throw new Error(`${name} required`);
  return { ...input };
}
export async function configuration(env, built = false) {
  const paths = await import(
    built ? '../dist-server/server/src/database/paths.js' : '../app/server/src/database/paths.ts'
  );
  const checked = paths.validateStoragePaths(paths.resolveStoragePaths(env), isolationRoot);
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
