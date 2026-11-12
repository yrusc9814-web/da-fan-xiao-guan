import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { isolationRoot, repository } from './isolation-gate.mjs';
import { assertPortAvailable } from './check-isolated-port.mjs';
const evidence = resolve(isolationRoot, 'evidence');
// van128：独立验收副本运行时允许显式注入 forward 基线（测试夹具基线，repo=当前仓库）；
// 缺省仍为固定隔离根的正式基线，缺省行为不变。注入缺失/无效时由 ENOENT 与各断言 fail-closed，
// 无静默回退。changed/added/removed/readErrors 断言全部保留不变。
const baselinePath = process.env.DAFAN_FORWARD_BASELINE
  ? resolve(process.env.DAFAN_FORWARD_BASELINE)
  : resolve(evidence, 'formal-baseline-forward.json');
test('root test environment replaces production DB override and refuses Browser storage/reset', async () => {
  const { testEnvironment } = await import('./test-storage-environment.mjs');
  const env = {
    ...process.env,
    DAFAN_ISOLATION_ROOT: isolationRoot,
    NODE_ENV: 'production',
    DATABASE_URL: `file:${isolationRoot}/data/app.db`,
    DAFAN_DATABASE_PATH: resolve(isolationRoot, 'data/app.db'),
    TEST_DATABASE_URL: `file:${isolationRoot}/data/test-forward.db`,
    DAFAN_UPLOADS_PATH: resolve(isolationRoot, 'test-forward/uploads'),
    DAFAN_BACKUPS_PATH: resolve(isolationRoot, 'test-forward/backups')
  };
  const checked = await testEnvironment(env);
  assert.equal(checked.NODE_ENV, 'test');
  assert.equal(checked.DAFAN_DATABASE_PATH, resolve(isolationRoot, 'data/test-forward.db'));
  assert.equal(checked.DATABASE_URL, checked.TEST_DATABASE_URL);
  await assert.rejects(testEnvironment({ ...env, TEST_DATABASE_URL: env.DATABASE_URL }), /independent test/);
  await assert.rejects(
    testEnvironment({ ...env, DAFAN_UPLOADS_PATH: resolve(isolationRoot, 'data/uploads') }),
    /Browser uploads/
  );
  const db = resolve(isolationRoot, 'data/app.db');
  const before = readFileSync(db);
  const reset = spawnSync(process.execPath, ['scripts/reset-test-database.mjs'], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...env, TEST_DATABASE_URL: `file:${db}`, DATABASE_URL: `file:${db}` }
  });
  assert.equal(reset.status, 1);
  assert.match(reset.stderr, /拒绝重置非测试数据库/);
  assert.deepEqual(readFileSync(db), before);
});
test('forward snapshot detects changed, added and removed fingerprints without modifying formal storage', () => {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  assert.equal(baseline.schemaVersion, 2);
  assert.equal(baseline.repo, repository);
  assert.equal(baseline.status, 'PASS');
  const fixture = mkdtempSync(join(tmpdir(), 'dafan-forward-snapshot-'));
  try {
    mkdirSync(join(fixture, 'scripts'));
    mkdirSync(join(fixture, 'data/uploads'), { recursive: true });
    mkdirSync(join(fixture, 'data/backups'));
    const snapshot = join(fixture, 'scripts/snapshot-formal-storage.mjs');
    copyFileSync(resolve(repository, 'scripts/snapshot-formal-storage.mjs'), snapshot);
    writeFileSync(join(fixture, 'data/app.db'), 'synthetic snapshot database');
    const present = join(fixture, 'data/uploads/present.txt');
    writeFileSync(present, 'synthetic upload');
    const captured = join(fixture, 'baseline.json');
    const capture = spawnSync(process.execPath, [snapshot, '--capture-forward', captured], {
      cwd: fixture,
      encoding: 'utf8'
    });
    assert.equal(capture.status, 0, capture.stderr || capture.stdout);
    const changed = JSON.parse(readFileSync(captured, 'utf8'));
    changed.db.sha256 = '0'.repeat(64);
    changed.uploads.push({
      path: join(fixture, 'data/uploads/nonexistent-negative-fixture'),
      exists: true,
      size: 1,
      mtimeUtc: changed.db.mtimeUtc,
      sha256: '0'.repeat(64)
    });
    assert.ok(changed.uploads.length > 1);
    changed.uploads.splice(0, 1);
    const token = randomUUID();
    const input = resolve(evidence, `forward-negative-baseline-${token}.json`);
    const output = resolve(evidence, `forward-negative-comparison-${token}.json`);
    writeFileSync(input, JSON.stringify(changed), { flag: 'wx' });
    const result = spawnSync(process.execPath, [snapshot, input, output], {
      cwd: fixture,
      encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.comparisonComplete, true);
    assert.equal(report.readErrors.length, 0);
    assert.ok(report.changed.length && report.added.length && report.removed.length);
    assert.equal(readFileSync(present, 'utf8'), 'synthetic upload');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
test('port preflight refuses occupied loopback port and does not kill owner', async () => {
  const owner = createServer();
  await new Promise((accept, reject) => {
    owner.once('error', reject);
    owner.listen(0, '127.0.0.1', accept);
  });
  const port = owner.address().port;
  try {
    await assert.rejects(assertPortAvailable('127.0.0.1', port), { code: 'EADDRINUSE' });
    assert.equal(owner.listening, true);
  } finally {
    await new Promise((accept) => owner.close(accept));
  }
  await assertPortAvailable('127.0.0.1', port);
});
