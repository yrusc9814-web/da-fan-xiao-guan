import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  configuration,
  isolatedEnvironment,
  isolationRoot,
  repository,
  verifyBuildReceipt
} from './isolation-gate.mjs';
const env = {
  ...process.env,
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: '18877',
  DAFAN_ISOLATION_ROOT: isolationRoot,
  DAFAN_DATABASE_PATH: `${isolationRoot}\\data\\app.db`,
  DATABASE_URL: `file:${isolationRoot}\\data\\app.db`,
  DAFAN_UPLOADS_PATH: `${isolationRoot}\\data\\uploads`,
  DAFAN_BACKUPS_PATH: `${isolationRoot}\\data\\backups`
};
test('gate requires immutable scratch, explicit production and loopback', () => {
  assert.deepEqual(isolatedEnvironment(env), env);
  for (const change of [{ HOST: '0.0.0.0' }, { NODE_ENV: 'test' }, { PORT: '' }, { DAFAN_ISOLATION_ROOT: repository }])
    assert.throws(() => isolatedEnvironment({ ...env, ...change }));
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
test('actual source and built resolvers agree without connecting DB', async () => {
  assert.deepEqual(await configuration(env), await configuration(env, true));
  await assert.rejects(
    configuration({
      ...env,
      DAFAN_DATABASE_PATH: `${repository}\\data\\app.db`,
      DATABASE_URL: `file:${repository}\\data\\app.db`
    })
  );
});
test('strict snapshot refuses incomplete initial baseline', () => {
  const output = `${isolationRoot}\\evidence\\snapshot-negative-${process.pid}.json`;
  const run = spawnSync(
    process.execPath,
    ['scripts/snapshot-formal-storage.mjs', `${isolationRoot}\\evidence\\baseline.json`, output],
    { cwd: repository, env, encoding: 'utf8' }
  );
  assert.equal(run.status, 1);
  assert.match(run.stdout, /baseline.db missing complete fingerprint/);
});
