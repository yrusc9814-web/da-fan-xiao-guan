import { afterAll, describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
