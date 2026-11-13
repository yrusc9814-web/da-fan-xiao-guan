import { afterAll, describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertIsolatedPath,
  defaultDatabaseUrl,
  filePathFromDatabaseUrl,
  resolveDatabaseUrl,
  resolveIsolationTempDirectory,
  resolveRestoreTempDirectory,
  resolveStoragePaths,
  validateStoragePaths
} from '../src/database/paths.js';

const explicitRoot = process.env.DAFAN_ISOLATION_ROOT;
const fixturePrefix = resolve(explicitRoot ?? tmpdir(), 'resolver-test-');
if (explicitRoot !== undefined) assertIsolatedPath(fixturePrefix, explicitRoot);
const fixture = mkdtempSync(fixturePrefix);
const scratch = explicitRoot ?? fixture;
const db = resolve(fixture, 'db.sqlite');
const uploads = resolve(fixture, 'uploads');
const backups = resolve(fixture, 'backups');
writeFileSync(db, 'fixture, never connect');
mkdirSync(uploads);
mkdirSync(backups);
const isolated = {
  NODE_ENV: 'production',
  DATABASE_URL: `file:${db}`,
  DAFAN_DATABASE_PATH: db,
  DAFAN_UPLOADS_PATH: uploads,
  DAFAN_BACKUPS_PATH: backups,
  DAFAN_ISOLATION_ROOT: scratch
};
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe('storage isolation actual resolver', () => {
  it('allocates an exclusive fixture beneath the explicit root or portable system tmpdir', () => {
    expect(dirname(fixture)).toBe(resolve(explicitRoot ?? tmpdir()));
    expect(scratch).toBe(explicitRoot ?? fixture);
    assertIsolatedPath(fixture, scratch);
  });
  it('preserves default production DB/uploads/backups and temp behavior', () => {
    const paths = resolveStoragePaths({ NODE_ENV: 'production' });
    const root = resolve(import.meta.dirname, '../../..');
    expect(paths.databasePath).toBe(resolve(root, 'data/app.db'));
    expect(paths.databasePath).toBe(filePathFromDatabaseUrl(defaultDatabaseUrl));
    expect(paths.uploadsDirectory).toBe(resolve(root, 'data/uploads'));
    expect(paths.backupsDirectory).toBe(resolve(root, 'data/backups'));
    expect(resolveRestoreTempDirectory({})).toBe(resolve(root, 'data'));
  });
  it('derives the test restore staging directory from the default data/test.db parent', () => {
    const projectRoot = resolve(import.meta.dirname, '../../..');
    const defaultTestUrl = 'file:../../../data/test.db';
    expect(resolveRestoreTempDirectory({ NODE_ENV: 'test', TEST_DATABASE_URL: defaultTestUrl })).toBe(
      dirname(filePathFromDatabaseUrl(defaultTestUrl)!)
    );
    expect(resolveRestoreTempDirectory({ NODE_ENV: 'test', TEST_DATABASE_URL: defaultTestUrl })).toBe(
      resolve(projectRoot, 'data')
    );
  });
  it('uses the external os.tmpdir test database parent even across volumes', () => {
    const externalDb = resolve(tmpdir(), `test-external-${process.pid}-${Date.now()}.db`);
    const staging = resolveRestoreTempDirectory({
      NODE_ENV: 'test',
      TEST_DATABASE_URL: `file:${externalDb}`
    });
    expect(staging).toBe(dirname(externalDb));
    expect(staging).toBe(resolve(tmpdir()));
    if (process.platform === 'win32') {
      const sameVolume = (left: string, right: string) =>
        parse(left).root.toLowerCase() === parse(right).root.toLowerCase();
      const repoData = resolve(import.meta.dirname, '../../..', 'data');
      expect(sameVolume(staging, externalDb)).toBe(true);
      // 跨盘（如 C 盘 tmpdir 与 D 盘仓库）时暂存区跟随实际测试库所在卷，而非仓库 data 所在卷
      expect(sameVolume(staging, repoData)).toBe(sameVolume(externalDb, repoData));
    }
  });
  it('fails closed for test restore staging without a test database URL', () => {
    expect(() => resolveRestoreTempDirectory({ NODE_ENV: 'test' })).toThrow('安全闸');
    expect(() => resolveRestoreTempDirectory({ NODE_ENV: 'test', TEST_DATABASE_URL: '  ' })).toThrow('安全闸');
  });
  it('fails closed for test restore staging pointing at formal storage ranges', () => {
    const projectRoot = resolve(import.meta.dirname, '../../..');
    for (const dangerous of [
      defaultDatabaseUrl,
      `file:${resolve(projectRoot, 'data/uploads/rogue.db')}`,
      `file:${resolve(projectRoot, 'data/backups/rogue.db')}`
    ])
      expect(() => resolveRestoreTempDirectory({ NODE_ENV: 'test', TEST_DATABASE_URL: dangerous })).toThrow('安全闸');
  });
  it('rejects test DAFAN_DATABASE_PATH conflicting with the test database URL', () => {
    const externalDb = resolve(tmpdir(), `test-conflict-${process.pid}-${Date.now()}.db`);
    expect(() =>
      resolveRestoreTempDirectory({
        NODE_ENV: 'test',
        TEST_DATABASE_URL: `file:${externalDb}`,
        DAFAN_DATABASE_PATH: resolve(fixture, 'other.db')
      })
    ).toThrow('冲突');
  });
  it('keeps production defaults and isolation root restore staging behavior', () => {
    const projectRoot = resolve(import.meta.dirname, '../../..');
    expect(resolveRestoreTempDirectory({ NODE_ENV: 'production' })).toBe(resolve(projectRoot, 'data'));
    expect(resolveRestoreTempDirectory({})).toBe(resolve(projectRoot, 'data'));
    expect(resolveRestoreTempDirectory(isolated)).toBe(resolve(scratch, '.tmp'));
    expect(
      resolveRestoreTempDirectory({
        ...isolated,
        NODE_ENV: 'test',
        TEST_DATABASE_URL: `file:${db}`,
        DATABASE_URL: defaultDatabaseUrl
      })
    ).toBe(resolve(scratch, '.tmp'));
  });
  it('uses all explicit overrides and scratch temporary path', () => {
    expect(resolveStoragePaths(isolated)).toEqual({
      databaseUrl: `file:${db}`,
      databasePath: db,
      uploadsDirectory: uploads,
      backupsDirectory: backups
    });
    expect(resolveIsolationTempDirectory(isolated)).toBe(resolve(scratch, '.tmp'));
  });
  it('retains test safety gate and test URL priority', () => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test' })).toThrow('安全闸');
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: defaultDatabaseUrl })).toThrow('安全闸');
    expect(
      resolveDatabaseUrl({
        ...isolated,
        NODE_ENV: 'test',
        DATABASE_URL: defaultDatabaseUrl,
        TEST_DATABASE_URL: `file:${db}`
      })
    ).toBe(`file:${db}`);
  });
  it('rejects production and test override conflicts', () => {
    expect(() => resolveStoragePaths({ ...isolated, DATABASE_URL: defaultDatabaseUrl })).toThrow('冲突');
    expect(() =>
      resolveStoragePaths({ ...isolated, NODE_ENV: 'test', TEST_DATABASE_URL: `file:${resolve(fixture, 'other.db')}` })
    ).toThrow('冲突');
  });
  for (const key of ['DAFAN_DATABASE_PATH', 'DAFAN_UPLOADS_PATH', 'DAFAN_BACKUPS_PATH', 'DAFAN_ISOLATION_ROOT']) {
    for (const value of ['', ' ', 'relative/path'])
      it(`rejects ${key}=${JSON.stringify(value)}`, () => {
        expect(() => resolveStoragePaths({ ...isolated, [key]: value })).toThrow();
      });
  }
  it('rejects root escapes and incomplete isolated overrides', () => {
    expect(() => validateStoragePaths(resolveStoragePaths({ NODE_ENV: 'production' }), scratch)).toThrow();
    expect(() => resolveStoragePaths({ DAFAN_ISOLATION_ROOT: scratch })).toThrow();
    expect(() => assertIsolatedPath(resolve(scratch, '../outside/new-file'), scratch)).toThrow();
  });
  it('rejects DB hard links', () => {
    const target = resolve(fixture, 'hard.db');
    linkSync(db, target);
    try {
      expect(() => resolveStoragePaths(isolated)).toThrow('硬链接');
    } finally {
      rmSync(target);
    }
  });
  it('rejects nested junctions even pointing inside scratch', () => {
    const target = resolve(uploads, 'junction');
    symlinkSync(backups, target, 'junction');
    try {
      expect(() => resolveStoragePaths(isolated)).toThrow('symlink/junction');
    } finally {
      rmSync(target);
    }
  });
});
