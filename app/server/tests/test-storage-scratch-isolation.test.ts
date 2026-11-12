import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { resolveBackupsDirectory, resolveUploadsDirectory } from '../src/database/paths.js';

// tests -> server -> app -> repo 根
const repoRoot = resolve(import.meta.dirname, '../../..');
const serverRoot = resolve(import.meta.dirname, '..');
const formalUploads = resolve(repoRoot, 'data/uploads');
const formalBackups = resolve(repoRoot, 'data/backups');
const samePath = (left: string, right: string) =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

const fixture = mkdtempSync(join(tmpdir(), 'scratch-iso-test-'));
const operatorUploads = join(fixture, 'operator-uploads');
const operatorBackups = join(fixture, 'operator-backups');
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

// 探测脚本在独立子进程中运行：无 DAFAN_* 继承干扰，testEnvironment 的真实默认行为可观测
const probePath = join(fixture, 'scratch-probe.mjs');
writeFileSync(
  probePath,
  [
    "import { pathToFileURL } from 'node:url';",
    'const { testEnvironment } = await import(pathToFileURL(process.env.SCRATCH_PROBE_TARGET).href);',
    'const out = { defaults: null, explicitKept: null, formalRejected: null };',
    'out.defaults = await testEnvironment({});',
    'out.explicitKept = await testEnvironment({ DAFAN_UPLOADS_PATH: process.env.SCRATCH_PROBE_CUSTOM });',
    'try {',
    '  await testEnvironment({ DAFAN_UPLOADS_PATH: process.env.SCRATCH_PROBE_FORMAL_UPLOADS });',
    '} catch (error) {',
    '  out.formalRejected = error.message;',
    '}',
    "console.log('PROBE-JSON:' + JSON.stringify(out));"
  ].join('\n')
);

const baseEnv = { ...process.env };
delete baseEnv.DAFAN_UPLOADS_PATH;
delete baseEnv.DAFAN_BACKUPS_PATH;
delete baseEnv.DAFAN_ISOLATION_ROOT;

interface ProbeResult {
  defaults: {
    NODE_ENV: string;
    TEST_DATABASE_URL: string;
    DAFAN_UPLOADS_PATH: string;
    DAFAN_BACKUPS_PATH: string;
  };
  explicitKept: { DAFAN_UPLOADS_PATH: string };
  formalRejected: string | null;
}

function runProbe(): ProbeResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', probePath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...baseEnv,
      SCRATCH_PROBE_TARGET: resolve(repoRoot, 'scripts/test-storage-environment.mjs'),
      SCRATCH_PROBE_CUSTOM: operatorUploads,
      SCRATCH_PROBE_FORMAL_UPLOADS: formalUploads
    }
  });
  const line = (result.stdout ?? '').split('\n').find((line) => line.startsWith('PROBE-JSON:'));
  expect({ status: result.status, stderr: result.stderr, line }, 'probe subprocess must succeed').toBeTruthy();
  return JSON.parse(line!.slice('PROBE-JSON:'.length)) as ProbeResult;
}

function runGuard(envOverrides: NodeJS.ProcessEnv) {
  // 相对入口 + cwd=server：避免非 ASCII 绝对路径作为 tsx 主入口触发模块解析错误
  return spawnSync(process.execPath, ['--import', 'tsx/esm', 'tests/setup/test-env-guard.ts'], {
    cwd: serverRoot,
    encoding: 'utf8',
    env: { ...baseEnv, TEST_DATABASE_URL: 'file:../../../data/test.db', ...envOverrides }
  });
}

describe('测试存储 scratch 隔离（未显式提供 isolation root 时也不得触碰正式 uploads/backups）', () => {
  it('testEnvironment 无 root 时默认注入一次性 scratch，绝不解析到正式 uploads/backups', () => {
    const probe = runProbe();
    expect(probe.defaults.NODE_ENV).toBe('test');
    expect(probe.defaults.TEST_DATABASE_URL).toBe('file:../../../data/test.db');
    for (const value of [probe.defaults.DAFAN_UPLOADS_PATH, probe.defaults.DAFAN_BACKUPS_PATH]) {
      expect(existsSync(value)).toBe(true);
      expect(statSync(value).isDirectory()).toBe(true);
      expect(samePath(resolve(value), formalUploads)).toBe(false);
      expect(samePath(resolve(value), formalBackups)).toBe(false);
      expect(resolve(value).startsWith(tmpdir())).toBe(true);
    }
    expect(samePath(resolve(probe.defaults.DAFAN_UPLOADS_PATH), resolve(probe.defaults.DAFAN_BACKUPS_PATH))).toBe(
      false
    );
  });

  it('操作者显式提供的 scratch 被尊重；显式正式路径 fail-closed 拒绝', () => {
    const probe = runProbe();
    expect(samePath(resolve(probe.explicitKept.DAFAN_UPLOADS_PATH), resolve(operatorUploads))).toBe(true);
    expect(probe.formalRejected).toContain('测试存储安全闸');
    expect(probe.formalRejected).toContain(formalUploads);
  });

  it('test-env-guard 在缺失显式 scratch 或指向正式存储时拒绝运行，合法 scratch 放行', () => {
    const missing = runGuard({});
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('测试存储安全闸');
    expect(missing.stderr).toContain('DAFAN_UPLOADS_PATH');

    const formal = runGuard({ DAFAN_UPLOADS_PATH: formalUploads, DAFAN_BACKUPS_PATH: operatorBackups });
    expect(formal.status).not.toBe(0);
    expect(formal.stderr).toContain('测试存储安全闸');

    const valid = runGuard({ DAFAN_UPLOADS_PATH: operatorUploads, DAFAN_BACKUPS_PATH: operatorBackups });
    expect(valid.status).toBe(0);
  });

  it('官方测试进程内 uploads/backups 解析为 runner 注入的 scratch；写入型服务（backup restore 的 rm+rename）只作用于该 scratch', () => {
    const uploads = resolveUploadsDirectory();
    const backups = resolveBackupsDirectory();
    expect(samePath(uploads, formalUploads)).toBe(false);
    expect(samePath(backups, formalBackups)).toBe(false);
    expect(process.env.DAFAN_UPLOADS_PATH).toBeTruthy();
    expect(samePath(resolve(process.env.DAFAN_UPLOADS_PATH!), uploads)).toBe(true);
    expect(process.env.DAFAN_BACKUPS_PATH).toBeTruthy();
    expect(samePath(resolve(process.env.DAFAN_BACKUPS_PATH!), backups)).toBe(true);
    expect(existsSync(uploads)).toBe(true);
    expect(existsSync(backups)).toBe(true);
  });
});
