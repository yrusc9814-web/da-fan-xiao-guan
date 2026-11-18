import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// tests -> server -> app -> repo 根
const repoRoot = resolve(import.meta.dirname, '../../..');
const serverRoot = resolve(import.meta.dirname, '..');
const formalUploads = resolve(repoRoot, 'data/uploads');
const formalBackups = resolve(repoRoot, 'data/backups');
const formalDb = resolve(repoRoot, 'data/app.db');
const win32 = process.platform === 'win32';

interface FormalDatabaseFingerprint {
  hash: string;
  size: number;
  mtimeMs: number;
}

/**
 * 只读探测正式库：仅记录 sha256/size/mtime，不解析业务内容、不打开写句柄、不创建目录或文件。
 * 全新 clone / CI 未初始化时 data/app.db 不存在，返回 null；后续断言要求它仍为 null，
 * 因此本文件既不要求正式库存在，也禁止测试过程创建或修改它。
 */
function formalDatabaseFingerprint(): FormalDatabaseFingerprint | null {
  try {
    const contents = readFileSync(formalDb);
    const metadata = statSync(formalDb);
    return {
      hash: createHash('sha256').update(contents).digest('hex'),
      size: metadata.size,
      mtimeMs: metadata.mtimeMs
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// 模块加载（任何用例执行前）采集基线指纹。
const formalDatabaseBefore = formalDatabaseFingerprint();

// 探测进程绝不写入正式存储：guard 只做路径判定；runner 探测的安全闸在创建任何目录前拒绝。
// 唯一允许 runner 触碰的是"已存在目录"（mkdir 为 no-op）与临时 fixture 内部。
const fixture = mkdtempSync(join(tmpdir(), 'boundary-iso-test-'));
const okUploads = join(fixture, 'ok-uploads');
const okBackups = join(fixture, 'ok-backups');
const sameDir = join(fixture, 'same-dir');
const isolatedRoot = join(fixture, 'iso-root');
mkdirSync(okUploads, { recursive: true });
mkdirSync(okBackups, { recursive: true });
mkdirSync(sameDir, { recursive: true });
mkdirSync(resolve(isolatedRoot, 'data/uploads'), { recursive: true });
mkdirSync(resolve(isolatedRoot, 'data/backups'), { recursive: true });
const junctionToUploads = join(fixture, 'junction-to-uploads');
symlinkSync(formalUploads, junctionToUploads, win32 ? 'junction' : 'dir');
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

const baseEnv: NodeJS.ProcessEnv = { ...process.env };
delete baseEnv.DAFAN_UPLOADS_PATH;
delete baseEnv.DAFAN_BACKUPS_PATH;
delete baseEnv.DAFAN_ISOLATION_ROOT;

function runGuard(envOverrides: NodeJS.ProcessEnv) {
  // 相对入口 + cwd=server：避免非 ASCII 绝对路径作为 tsx 主入口触发模块解析错误
  return spawnSync(process.execPath, ['--import', 'tsx/esm', 'tests/setup/test-env-guard.ts'], {
    cwd: serverRoot,
    encoding: 'utf8',
    env: {
      ...baseEnv,
      NODE_ENV: 'test',
      TEST_DATABASE_URL: 'file:../../../data/test.db',
      DAFAN_UPLOADS_PATH: okUploads,
      DAFAN_BACKUPS_PATH: okBackups,
      ...envOverrides
    }
  });
}

interface ProbeOutcome {
  rejected: boolean;
  message: string | null;
  env: { uploads: string; backups: string } | null;
}

// runner 探测：独立子进程导入 scripts/test-storage-environment.mjs 并执行命名场景
function runTestEnvironmentProbe(scenario: string, envOverrides: NodeJS.ProcessEnv = {}): ProbeOutcome {
  const probePath = join(fixture, 'boundary-probe.mjs');
  writeFileSync(
    probePath,
    [
      "import { pathToFileURL } from 'node:url';",
      'const { testEnvironment } = await import(pathToFileURL(process.env.BOUNDARY_PROBE_TARGET).href);',
      'const out = { rejected: false, message: null, env: null };',
      'try {',
      '  const env = await testEnvironment(JSON.parse(process.env.BOUNDARY_PROBE_INPUT));',
      '  out.env = { uploads: env.DAFAN_UPLOADS_PATH, backups: env.DAFAN_BACKUPS_PATH };',
      '} catch (error) {',
      '  out.rejected = true;',
      '  out.message = error.message;',
      '}',
      "console.log('BOUNDARY-PROBE-JSON:' + JSON.stringify(out));"
    ].join('\n')
  );
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', probePath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...baseEnv,
      BOUNDARY_PROBE_TARGET: resolve(repoRoot, 'scripts/test-storage-environment.mjs'),
      BOUNDARY_PROBE_INPUT: JSON.stringify(envOverrides)
    }
  });
  const line = (result.stdout ?? '').split('\n').find((value) => value.startsWith('BOUNDARY-PROBE-JSON:'));
  expect(
    { status: result.status, stderr: result.stderr, line },
    `runner probe scenario ${scenario} must complete`
  ).toBeTruthy();
  return JSON.parse(line!.slice('BOUNDARY-PROBE-JSON:'.length)) as ProbeOutcome;
}

describe('测试存储正式边界（统一安全闸：显式配置/父子目录/交叉配置/路径规范化 全部不可绕过）', () => {
  it('guard 对照组：合法独立 scratch 放行', () => {
    const valid = runGuard({ DAFAN_UPLOADS_PATH: okUploads, DAFAN_BACKUPS_PATH: okBackups });
    expect(valid.status, valid.stderr).toBe(0);
  });

  const guardRejections: Array<{ id: string; env: NodeJS.ProcessEnv }> = [
    { id: '正式 uploads 子目录（已存在）', env: { DAFAN_UPLOADS_PATH: join(formalUploads, 'thumbnails') } },
    {
      id: '正式 uploads 子目录（不存在）',
      env: { DAFAN_UPLOADS_PATH: join(formalUploads, '__boundary_probe_child__') }
    },
    { id: '包含正式存储的祖先目录 data', env: { DAFAN_UPLOADS_PATH: resolve(repoRoot, 'data') } },
    { id: '交叉配置：uploads 指向正式 backups', env: { DAFAN_UPLOADS_PATH: formalBackups } },
    { id: '交叉配置：uploads 与 backups 同一路径', env: { DAFAN_UPLOADS_PATH: sameDir, DAFAN_BACKUPS_PATH: sameDir } },
    { id: '指向正式 uploads 的 junction', env: { DAFAN_UPLOADS_PATH: junctionToUploads } },
    {
      id: '测试库 URL 落入正式 uploads',
      env: { TEST_DATABASE_URL: `file:${formalUploads.replace(/\\/g, '/')}/boundary-probe.db` }
    }
  ];
  if (win32) {
    guardRejections.push(
      { id: '设备前缀 \\\\?\\ 形式的正式 uploads', env: { DAFAN_UPLOADS_PATH: '\\\\?\\' + formalUploads } },
      { id: '大小写改写的正式 uploads', env: { DAFAN_UPLOADS_PATH: resolve(repoRoot, 'data', 'UploadS') } }
    );
  }
  guardRejections.push({ id: '冗余尾分隔符的正式 uploads', env: { DAFAN_UPLOADS_PATH: formalUploads + sep } });

  it.each(guardRejections)('guard 拒绝：$id', ({ env }) => {
    const result = runGuard(env);
    expect(result.status, `应拒绝：${JSON.stringify(env)}\n${result.stderr}`).not.toBe(0);
    expect(result.stderr).toMatch(/测试存储安全闸|测试数据库安全闸/);
  });

  it('runner 拒绝显式正式子目录且绝不创建该目录（fail-closed 先于任何写入）', () => {
    const child = join(formalUploads, '__boundary_probe_child__');
    const outcome = runTestEnvironmentProbe('explicit-child', { DAFAN_UPLOADS_PATH: child });
    expect(outcome.rejected).toBe(true);
    expect(outcome.message).toContain('测试存储安全闸');
    expect(existsSync(child), '安全闸拒绝前不得在正式 uploads 内创建目录').toBe(false);
  });

  it('runner 拒绝交叉配置与 uploads=backups 同路径', () => {
    const cross = runTestEnvironmentProbe('explicit-cross', { DAFAN_UPLOADS_PATH: formalBackups });
    expect(cross.rejected).toBe(true);
    expect(cross.message).toContain('测试存储安全闸');

    const same = runTestEnvironmentProbe('explicit-same-dir', {
      DAFAN_UPLOADS_PATH: sameDir,
      DAFAN_BACKUPS_PATH: sameDir
    });
    expect(same.rejected).toBe(true);
    expect(same.message).toContain('测试存储安全闸');
  });

  it('runner 尊重合法显式 scratch；缺省注入 OS 临时目录一次性 scratch', () => {
    const kept = runTestEnvironmentProbe('explicit-valid', {
      DAFAN_UPLOADS_PATH: okUploads,
      DAFAN_BACKUPS_PATH: okBackups
    });
    expect(kept.rejected).toBe(false);
    expect(resolve(kept.env!.uploads)).toBe(resolve(okUploads));
    expect(resolve(kept.env!.backups)).toBe(resolve(okBackups));

    const defaults = runTestEnvironmentProbe('defaults');
    expect(defaults.rejected).toBe(false);
    for (const value of [defaults.env!.uploads, defaults.env!.backups]) {
      expect(resolve(value).startsWith(tmpdir())).toBe(true);
      expect(resolve(value)).not.toBe(resolve(formalUploads));
      expect(resolve(value)).not.toBe(resolve(formalBackups));
    }
  });

  it('隔离 root 分支同样拒绝落入 Browser uploads 的路径（含子目录与同路径交叉）', () => {
    const rootChild = runTestEnvironmentProbe('root-child', {
      DAFAN_ISOLATION_ROOT: isolatedRoot,
      TEST_DATABASE_URL: `file:${resolve(isolatedRoot, 'data/test.db').replace(/\\/g, '/')}`,
      DAFAN_UPLOADS_PATH: resolve(isolatedRoot, 'data/uploads/__boundary_probe_child__'),
      DAFAN_BACKUPS_PATH: resolve(isolatedRoot, 'test-forward/backups')
    });
    expect(rootChild.rejected).toBe(true);
    expect(rootChild.message).toContain('测试存储安全闸');
    expect(existsSync(resolve(isolatedRoot, 'data/uploads/__boundary_probe_child__'))).toBe(false);

    const rootSame = runTestEnvironmentProbe('root-same', {
      DAFAN_ISOLATION_ROOT: isolatedRoot,
      TEST_DATABASE_URL: `file:${resolve(isolatedRoot, 'data/test.db').replace(/\\/g, '/')}`,
      DAFAN_UPLOADS_PATH: resolve(isolatedRoot, 'test-forward/uploads'),
      DAFAN_BACKUPS_PATH: resolve(isolatedRoot, 'test-forward/uploads')
    });
    expect(rootSame.rejected).toBe(true);
    expect(rootSame.message).toContain('测试存储安全闸');
  });

  it('正式存储自检：测试执行后正式 uploads/backups 内不得出现探测残留，正式库仅被哈希读取且指纹不变', () => {
    expect(existsSync(join(formalUploads, '__boundary_probe_child__'))).toBe(false);
    expect(existsSync(join(formalBackups, '__boundary_probe_child__'))).toBe(false);
    expect(existsSync(join(formalUploads, 'boundary-probe.db'))).toBe(false);
    // 不再要求正式库存在：全新 clone / CI（无预存 data/app.db）必须可运行；存在时必须保持逐字节与元数据不变。
    const formalDatabaseAfter = formalDatabaseFingerprint();
    expect(
      formalDatabaseAfter,
      `正式库指纹必须与模块加载时一致；before=${JSON.stringify(formalDatabaseBefore)}，after=${JSON.stringify(formalDatabaseAfter)}`
    ).toEqual(formalDatabaseBefore);
  });
});
