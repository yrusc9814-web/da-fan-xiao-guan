import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  assertDistinctTestStoragePaths,
  assertTestStorageOutsideFormalBoundary,
  type FormalStorageRange
} from '../src/database/paths.js';

/**
 * T-008-R6：悬空 symlink/junction 的 fail-open 回归测试。
 *
 * 漏洞触发条件：测试存储安全闸比较路径时会跳过"不存在的层级"去找已存在祖先做 realpath。
 * 当正式目录尚未创建（fresh clone 的 data/uploads 不存在）时，一个指向该正式目录的
 * junction 也"不存在"（existsSync=false），于是被当成普通不存在路径，比较结果落在正式范围
 * 之外 → 放行；一旦正式目录随后被创建，写入就落进正式存储。
 *
 * 本文件只创建 os.tmpdir() 下的一次性 fixture，正式范围通过显式 ranges 参数注入，
 * 不读取/写入仓库 data，也不依赖 formalStorageRanges() 或任何本机绝对路径。
 */
const win32 = process.platform === 'win32';
const linkKind = win32 ? 'junction' : 'dir';
const fixture = mkdtempSync(join(tmpdir(), 'dangling-link-boundary-'));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

/** 模拟"正式存储"：目标目录/文件故意不创建，代表 fresh clone 的初始状态。 */
const formalData = join(fixture, 'formal', 'data');
const formalUploads = join(formalData, 'uploads');
const formalBackups = join(formalData, 'backups');
const formalDatabase = join(formalData, 'app.db');
mkdirSync(formalData, { recursive: true });

const formalRanges: FormalStorageRange[] = [
  { label: '正式数据库', path: formalDatabase },
  { label: '正式 uploads 目录', path: formalUploads },
  { label: '正式 backups 目录', path: formalBackups }
];

const danglingUploads = join(fixture, 'dangling-uploads');
symlinkSync(formalUploads, danglingUploads, linkKind);
const danglingBackups = join(fixture, 'dangling-backups');
symlinkSync(formalBackups, danglingBackups, linkKind);
const danglingDatabase = join(fixture, 'dangling-database');
symlinkSync(formalDatabase, danglingDatabase, linkKind);

const guard = (name: string, path: string) => () =>
  assertTestStorageOutsideFormalBoundary([{ name, path }], formalRanges);

describe('悬空链接指向尚不存在的正式范围', () => {
  it('前置条件：链接本身存在、目标尚未创建（正是 fail-open 的触发条件）', () => {
    expect(lstatSync(danglingUploads).isSymbolicLink()).toBe(true);
    expect(existsSync(danglingUploads)).toBe(false);
    expect(existsSync(formalUploads)).toBe(false);
    expect(readlinkSync(danglingUploads)).toBe(formalUploads);
  });

  it('链接自身即正式 uploads 时拒绝', () => {
    expect(guard('DAFAN_UPLOADS_PATH', danglingUploads)).toThrow(/正式 uploads 目录/);
  });

  it('链接下的不存在子目录拒绝（正式目录稍后创建后就是正式内部路径）', () => {
    expect(guard('DAFAN_UPLOADS_PATH', join(danglingUploads, 'nested'))).toThrow(/正式 uploads 目录/);
  });

  it('链接 + 深层不存在后缀拒绝', () => {
    expect(guard('DAFAN_BACKUPS_PATH', join(danglingBackups, 'a', 'b', 'c'))).toThrow(/正式 backups 目录/);
  });

  it('链接指向正式数据库文件时拒绝（databasePath 面）', () => {
    expect(guard('databasePath', join(danglingDatabase, 'test.db'))).toThrow(/正式数据库/);
  });

  it('悬空链接链（outer → inner → 正式 uploads）同样拒绝', () => {
    const inner = join(fixture, 'chain-inner');
    const outer = join(fixture, 'chain-outer');
    symlinkSync(formalUploads, inner, linkKind);
    symlinkSync(inner, outer, linkKind);
    expect(guard('DAFAN_UPLOADS_PATH', join(outer, 'x'))).toThrow(/正式 uploads 目录/);
  });

  it('assertDistinctTestStoragePaths 不把悬空链接与其目标判为独立', () => {
    expect(() =>
      assertDistinctTestStoragePaths([
        { name: 'uploads', path: danglingUploads },
        { name: 'backups', path: formalUploads }
      ])
    ).toThrow(/解析到同一路径/);
  });

  it.runIf(win32)('大小写改写正式范围时仍拒绝', () => {
    expect(() =>
      assertTestStorageOutsideFormalBoundary(
        [{ name: 'DAFAN_UPLOADS_PATH', path: join(danglingUploads, 'x') }],
        [{ label: '正式 uploads 目录', path: formalUploads.toUpperCase() }]
      )
    ).toThrow(/正式 uploads 目录/);
  });

  it.runIf(win32)('Windows 设备前缀改写时仍拒绝', () => {
    expect(() =>
      assertTestStorageOutsideFormalBoundary(
        [{ name: 'DAFAN_UPLOADS_PATH', path: `\\\\?\\${join(danglingUploads, 'x')}` }],
        [{ label: '正式 uploads 目录', path: `\\\\?\\${formalUploads}` }]
      )
    ).toThrow(/正式 uploads 目录/);
  });
});

describe('无法可靠解析的链接 fail-closed', () => {
  it('自指链接抛错而不是当作不存在路径', () => {
    const selfLink = join(fixture, 'self-link');
    symlinkSync(selfLink, selfLink, linkKind);
    expect(guard('DAFAN_UPLOADS_PATH', join(selfLink, 'x'))).toThrow(/无法可靠解析/);
  });

  it('链接环抛错而不是无限循环', () => {
    const ringA = join(fixture, 'ring-a');
    const ringB = join(fixture, 'ring-b');
    symlinkSync(ringB, ringA, linkKind);
    symlinkSync(ringA, ringB, linkKind);
    expect(guard('DAFAN_UPLOADS_PATH', join(ringA, 'deep', 'path'))).toThrow(/无法可靠解析/);
  });
});

describe('不引入误杀', () => {
  it('合法普通不存在目录（多级、无链接）仍放行', () => {
    const scratch = join(fixture, 'scratch', 'not-yet-created', 'uploads');
    expect(guard('DAFAN_UPLOADS_PATH', scratch)).not.toThrow();
  });

  it('悬空链接指向正式范围之外时放行', () => {
    const outsideDangling = join(fixture, 'outside-dangling');
    symlinkSync(join(fixture, 'nowhere', 'outside'), outsideDangling, linkKind);
    expect(guard('DAFAN_UPLOADS_PATH', join(outsideDangling, 'x'))).not.toThrow();
  });

  it('目标存在的有效链接仍按 realpath 判定（子目录拒绝、范围外放行）', () => {
    const liveTarget = join(fixture, 'live-target');
    mkdirSync(liveTarget, { recursive: true });
    const liveLink = join(fixture, 'live-link');
    symlinkSync(liveTarget, liveLink, linkKind);
    const liveRanges: FormalStorageRange[] = [{ label: '真实 uploads', path: liveTarget }];
    expect(() =>
      assertTestStorageOutsideFormalBoundary(
        [{ name: 'DAFAN_UPLOADS_PATH', path: join(liveLink, 'child') }],
        liveRanges
      )
    ).toThrow(/真实 uploads/);

    const outsideTarget = join(fixture, 'outside-target');
    mkdirSync(outsideTarget, { recursive: true });
    const outsideLink = join(fixture, 'outside-link');
    symlinkSync(outsideTarget, outsideLink, linkKind);
    expect(() =>
      assertTestStorageOutsideFormalBoundary([{ name: 'DAFAN_UPLOADS_PATH', path: join(outsideLink, 'x') }], liveRanges)
    ).not.toThrow();
  });

  it('正式范围之外的普通已存在目录放行', () => {
    const plain = join(fixture, 'plain-existing');
    mkdirSync(plain, { recursive: true });
    expect(guard('DAFAN_UPLOADS_PATH', plain)).not.toThrow();
  });
});
