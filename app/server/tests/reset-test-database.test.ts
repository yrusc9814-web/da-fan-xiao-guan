import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '../../..');
const script = resolve(projectRoot, 'scripts/reset-test-database.mjs');
const allowedDatabase = resolve(projectRoot, 'data/test-reset-guard.db');

function reset(databaseUrl: string) {
  return spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl }
  });
}

describe('测试数据库重置保护', () => {
  afterAll(async () => {
    await rm(allowedDatabase, { force: true });
  });

  it('只允许删除 data 目录内的 test*.db', () => {
    writeFileSync(allowedDatabase, 'temporary test database');
    const result = reset(`file:${allowedDatabase}`);
    expect(result.status).toBe(0);
    expect(existsSync(allowedDatabase)).toBe(false);
  });

  it.each([
    ['开发数据库', `file:${resolve(projectRoot, 'data/app.db')}`],
    ['data 目录外数据库', 'file:/private/tmp/test-outside.db']
  ])('拒绝删除%s', (_, databaseUrl) => {
    const result = reset(databaseUrl);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('拒绝重置非测试数据库');
  });
});
