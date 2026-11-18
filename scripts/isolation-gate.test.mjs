import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  configuration,
  isolatedEnvironment,
  isolationRoot,
  repository,
  requireIsolationRoot,
  resolveConfiguredIsolationRoot,
  verifyBuildReceipt
} from './isolation-gate.mjs';

// 所有夹具都建在一次性临时目录内；可用 DAFAN_ISOLATION_TEST_SCRATCH 指定父目录，
// 缺省为 OS 临时目录，绝不写入仓库 data/ 或既有隔离根。
const scratchParent = process.env.DAFAN_ISOLATION_TEST_SCRATCH ?? tmpdir();
mkdirSync(scratchParent, { recursive: true });
const scratch = mkdtempSync(join(scratchParent, 'dafan-gate-test-'));
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // 清理失败不改变测试判定；scratch 位于 DAFAN_ISOLATION_TEST_SCRATCH 下
  }
});

const root = join(scratch, 'root');
mkdirSync(join(root, 'data'), { recursive: true });
mkdirSync(join(root, 'evidence'), { recursive: true });
writeFileSync(join(root, 'data/app.db'), 'synthetic');

const env = {
  ...process.env,
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: '18877',
  DAFAN_ISOLATION_ROOT: root,
  DAFAN_DATABASE_PATH: join(root, 'data/app.db'),
  DATABASE_URL: `file:${join(root, 'data/app.db')}`,
  DAFAN_UPLOADS_PATH: join(root, 'data/uploads'),
  DAFAN_BACKUPS_PATH: join(root, 'data/backups')
};
mkdirSync(env.DAFAN_UPLOADS_PATH, { recursive: true });
mkdirSync(env.DAFAN_BACKUPS_PATH, { recursive: true });

test('unconfigured root keeps plain imports loadable and never falls back to a machine path', () => {
  assert.equal(resolveConfiguredIsolationRoot({}), undefined);
  const source = readFileSync(resolve(repository, 'scripts/isolation-gate.mjs'), 'utf8');
  assert.doesNotMatch(source, /google2-isolation-20261003-r1/);
  assert.doesNotMatch(source, /Vanta-pro/);
  // 模块在无 DAFAN_ISOLATION_ROOT 的子进程里仍可静态导入并导出 undefined
  const probe = spawnSync(
    process.execPath,
    ['-e', "import('./scripts/isolation-gate.mjs').then((m)=>{console.log(String(m.isolationRoot));})"],
    {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, DAFAN_ISOLATION_ROOT: '' }
    }
  );
  assert.equal(probe.status, 1);
  assert.match(probe.stderr, /DAFAN_ISOLATION_ROOT must be a non-empty absolute path/);
  const cleanEnv = { ...process.env };
  delete cleanEnv.DAFAN_ISOLATION_ROOT;
  const loadable = spawnSync(
    process.execPath,
    [
      '-e',
      "import('./scripts/isolation-gate.mjs').then((m)=>{console.log(JSON.stringify({root:m.isolationRoot??null,required:(()=>{try{m.requireIsolationRoot();return 'ok'}catch(e){return e.message}})()}));})"
    ],
    { cwd: repository, encoding: 'utf8', env: cleanEnv }
  );
  assert.equal(loadable.status, 0, loadable.stderr);
  const parsed = JSON.parse(loadable.stdout.trim());
  assert.equal(parsed.root, null);
  assert.match(parsed.required, /DAFAN_ISOLATION_ROOT is required/);
});

test('explicit root rejects blank, relative, missing, in-repo and symlinked values', () => {
  assert.throws(() => resolveConfiguredIsolationRoot({ DAFAN_ISOLATION_ROOT: '   ' }), /non-empty absolute path/);
  assert.throws(() => resolveConfiguredIsolationRoot({ DAFAN_ISOLATION_ROOT: 'relative/root' }), /absolute path/);
  assert.throws(
    () => resolveConfiguredIsolationRoot({ DAFAN_ISOLATION_ROOT: join(scratch, 'missing-root') }),
    /existing directory/
  );
  assert.throws(() => resolveConfiguredIsolationRoot({ DAFAN_ISOLATION_ROOT: repository }), /outside the repository/);
  assert.throws(
    () => resolveConfiguredIsolationRoot({ DAFAN_ISOLATION_ROOT: join(repository, 'data') }),
    /outside the repository/
  );
  const link = join(scratch, 'root-link');
  symlinkSync(root, link, 'junction');
  assert.throws(() => resolveConfiguredIsolationRoot({ DAFAN_ISOLATION_ROOT: link }), /symlink\/junction/);
});

test('configured root is resolved and reused, never silently substituted', () => {
  assert.equal(resolveConfiguredIsolationRoot({ DAFAN_ISOLATION_ROOT: root }), resolve(root));
  assert.equal(requireIsolationRoot({ DAFAN_ISOLATION_ROOT: root }), resolve(root));
  assert.throws(() => requireIsolationRoot({}), /DAFAN_ISOLATION_ROOT is required/);
  assert.throws(() => requireIsolationRoot({ DAFAN_ISOLATION_ROOT: '  ' }), /non-empty absolute path/);
});

test('gate requires explicit production, loopback and valid port under the configured root', () => {
  assert.equal(isolatedEnvironment(env).DAFAN_ISOLATION_ROOT, resolve(root));
  for (const change of [
    { HOST: '0.0.0.0' },
    { NODE_ENV: 'test' },
    { PORT: '' },
    { DAFAN_ISOLATION_ROOT: repository },
    { DAFAN_ISOLATION_ROOT: '' },
    { DAFAN_ISOLATION_ROOT: 'relative/root' }
  ])
    assert.throws(() => isolatedEnvironment({ ...env, ...change }));
  const ambient = { ...process.env, DAFAN_ISOLATION_ROOT: root };
  const other = join(scratch, 'other-root');
  mkdirSync(other);
  const saved = process.env.DAFAN_ISOLATION_ROOT;
  process.env.DAFAN_ISOLATION_ROOT = ambient.DAFAN_ISOLATION_ROOT;
  try {
    assert.throws(
      () => isolatedEnvironment({ ...env, DAFAN_ISOLATION_ROOT: other }),
      /immutable isolation root mismatch/
    );
  } finally {
    if (saved === undefined) delete process.env.DAFAN_ISOLATION_ROOT;
    else process.env.DAFAN_ISOLATION_ROOT = saved;
  }
});

test('configuration refuses to resolve without an explicit root', async () => {
  assert.equal(isolationRoot, resolveConfiguredIsolationRoot(process.env) ?? undefined);
  await assert.rejects(configuration({ ...env, DAFAN_ISOLATION_ROOT: '' }), /non-empty absolute path/);
  const withoutRoot = { ...env };
  delete withoutRoot.DAFAN_ISOLATION_ROOT;
  await assert.rejects(configuration(withoutRoot), /DAFAN_ISOLATION_ROOT is required/);
});

test('gate rejects stale source/artifact and missing receipt schema', () => {
  const files = { 'source.ts': 'abc', 'artifact.js': 'def' };
  verifyBuildReceipt({ schemaVersion: 1, repository, files }, files);
  assert.throws(
    () => verifyBuildReceipt({ schemaVersion: 1, repository, files }, { ...files, 'source.ts': 'changed' }),
    /stale build/
  );
  assert.throws(() => verifyBuildReceipt({}, files), /stale build/);
});

test('forward baseline resolution requires an explicit root and rejects blank/relative injection', async () => {
  const { resolveForwardBaseline } = await import('./formal-storage-gate.mjs');
  assert.throws(() => resolveForwardBaseline({}), /DAFAN_ISOLATION_ROOT is required/);
  assert.throws(
    () => resolveForwardBaseline({ DAFAN_ISOLATION_ROOT: root, DAFAN_FORWARD_BASELINE: 'relative.json' }),
    /non-empty absolute path/
  );
  assert.throws(
    () => resolveForwardBaseline({ DAFAN_ISOLATION_ROOT: root, DAFAN_FORWARD_BASELINE: '   ' }),
    /non-empty absolute path/
  );
  assert.equal(
    resolveForwardBaseline({ DAFAN_ISOLATION_ROOT: root }),
    resolve(root, 'evidence/formal-baseline-forward.json')
  );
});

test('isolated tooling fails fast and clearly when the root is unconfigured', () => {
  const cleanEnv = { ...process.env };
  delete cleanEnv.DAFAN_ISOLATION_ROOT;
  delete cleanEnv.DAFAN_FORWARD_BASELINE;
  const run = spawnSync(process.execPath, ['scripts/resolve-storage-paths.mjs'], {
    cwd: repository,
    encoding: 'utf8',
    env: cleanEnv
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /DAFAN_ISOLATION_ROOT is required/);
  assert.doesNotMatch(run.stderr + run.stdout, /google2-isolation-20261003-r1/);
});
