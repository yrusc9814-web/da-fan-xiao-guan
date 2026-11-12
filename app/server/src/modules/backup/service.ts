import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, parse, posix, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PrismaClient } from '@prisma/client';
import { ZipArchive } from 'archiver';
import unzipper, { type File as ZipEntry } from 'unzipper';

import {
  assertIsolatedPath,
  filePathFromDatabaseUrl,
  resolveBackupsDirectory,
  resolveDatabaseUrl,
  resolveIsolationTempDirectory,
  resolveRestoreTempDirectory,
  resolveUploadsDirectory
} from '../../database/paths.js';
import { beginMaintenance, endMaintenance } from '../../plugins/maintenance.js';
import { clearPinSessions } from '../settings/service.js';

const uploadsDirectory = resolveUploadsDirectory();
const backupsDirectory = resolveBackupsDirectory();

export const backupResourceLimits = {
  zipUploadBytes: 1024 * 1024 * 1024,
  extractedBytes: 4 * 1024 * 1024 * 1024,
  entryCount: 10_100,
  databaseBytes: 1024 * 1024 * 1024,
  uploadFileBytes: 16 * 1024 * 1024,
  metadataFileBytes: 1024 * 1024
} as const;

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}
interface Manifest {
  backupVersion: 1;
  appVersion: string;
  createdAt: string;
  files: ManifestFile[];
}
interface ExtractedFile {
  size: number;
  sha256: string;
}

function hash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fileHash(path: string): Promise<ExtractedFile> {
  const digest = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    digest.update(buffer);
  }
  return { size, sha256: digest.digest('hex') };
}

async function filesUnder(root: string, prefix: string): Promise<Array<{ path: string; source: string }>> {
  const result: Array<{ path: string; source: string }> = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const absolute = join(directory, entry.name);
      assertIsolatedPath(absolute);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const relative = absolute
          .slice(root.length + 1)
          .split(sep)
          .join('/');
        result.push({ path: `${prefix}/${relative}`, source: absolute });
      }
    }
  }
  await walk(root);
  return result;
}

function databasePath(): string {
  const path = filePathFromDatabaseUrl(resolveDatabaseUrl());
  if (!path) throw Object.assign(new Error('仅支持备份本地 SQLite 数据库'), { statusCode: 409 });
  return path;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const migrationsDirectory = resolve(projectRoot, 'app/server/prisma/migrations');

function restoreValidationError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 422 });
}

function assertSameStorageVolume(paths: string[]): void {
  const roots = new Set(paths.map((path) => parse(resolve(path)).root.toLowerCase()));
  if (roots.size > 1) throw restoreValidationError('恢复暂存区、回滚区与正式数据必须位于同一磁盘卷');
}

async function localMigrationNames(): Promise<Set<string>> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}

async function deployStagedMigrations(stagedDatabase: string): Promise<void> {
  const cli = resolve(projectRoot, 'node_modules/prisma/build/index.js');
  const environment = { ...process.env };
  delete environment.DAFAN_ISOLATION_ROOT;
  delete environment.DAFAN_DATABASE_PATH;
  delete environment.DAFAN_UPLOADS_PATH;
  delete environment.DAFAN_BACKUPS_PATH;
  environment.NODE_ENV = 'production';
  environment.DATABASE_URL = `file:${stagedDatabase}`;
  environment.TEST_DATABASE_URL = `file:${stagedDatabase}`;
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(process.execPath, [cli, 'migrate', 'deploy'], {
      cwd: projectRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectProcess(restoreValidationError('暂存库迁移超时，已拒绝恢复'));
    }, 30_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectProcess(error);
      else resolveProcess();
    };
    child.once('error', (error) => finish(restoreValidationError(`暂存库迁移启动失败：${error.message}`)));
    child.once('close', (code) => {
      if (code === 0) finish();
      else finish(restoreValidationError(`暂存库迁移失败（退出码 ${code ?? 'unknown'}）`));
    });
  });
}

async function auditStagedDatabase(stagedDatabase: string): Promise<void> {
  const knownMigrations = await localMigrationNames();
  let check: PrismaClient | undefined;
  try {
    const clientModule = await import('../../database/client.js');
    const connect = () => (check = clientModule.createPrismaClient(`file:${stagedDatabase}`));
    connect();
    const table = await check!.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'"
    );
    if (table.length !== 1) throw restoreValidationError('暂存数据库缺少 Prisma 迁移表');
    let migrations = await check!.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: string | null; rolled_back_at: string | null }>
    >('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations');
    const validateMigrations = () => {
      if (!migrations.some((migration) => migration.finished_at !== null)) throw restoreValidationError('暂存数据库没有已完成迁移');
      if (migrations.some((migration) => migration.finished_at === null && migration.rolled_back_at === null))
        throw restoreValidationError('暂存数据库包含未完成或失败迁移');
      const unknown = migrations.filter((migration) => !knownMigrations.has(migration.migration_name));
      if (unknown.length) throw restoreValidationError('暂存数据库包含未知未来迁移');
    };
    validateMigrations();
    const completed = new Set(migrations.filter((migration) => migration.finished_at !== null).map((migration) => migration.migration_name));
    if (completed.size < knownMigrations.size) {
      await check!.$disconnect();
      check = undefined;
      await deployStagedMigrations(stagedDatabase);
      connect();
      migrations = await check!.$queryRawUnsafe<Array<{ migration_name: string; finished_at: string | null; rolled_back_at: string | null }>>(
        'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations'
      );
      validateMigrations();
      if (new Set(migrations.filter((migration) => migration.finished_at !== null).map((migration) => migration.migration_name)).size < knownMigrations.size)
        throw restoreValidationError('暂存数据库迁移未达到当前版本');
    }
    const integrity = await check!.$queryRawUnsafe<Array<{ integrity_check: string }>>('PRAGMA integrity_check');
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw restoreValidationError('数据库完整性检查失败');
    const foreignKeys = await check!.$queryRawUnsafe<Array<Record<string, unknown>>>('PRAGMA foreign_key_check');
    if (foreignKeys.length) throw restoreValidationError('数据库外键检查失败');
    await check!.settings.findUnique({ where: { id: 1 } });
    await check!.ingredient.count();
    await check!.recipe.count();
    await check!.shoppingList.findFirst({ include: { items: true } });
    await check!.mealPlan.count();
    await check!.mealRecord.count();
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode === 422) throw error;
    throw restoreValidationError(`暂存数据库预检失败：${error instanceof Error ? error.message : '未知错误'}`);
  } finally {
    await check?.$disconnect().catch(() => undefined);
  }
}

let backupQueue: Promise<void> = Promise.resolve();
async function withBackupLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = backupQueue;
  let release!: () => void;
  backupQueue = new Promise<void>((resolveQueue) => {
    release = resolveQueue;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function sqliteString(value: string): string {
  return value.replaceAll("'", "''");
}

export async function createBackup(database: PrismaClient) {
  return withBackupLock(async () => {
    databasePath();
    const tempRoot = resolveIsolationTempDirectory();
    await mkdir(tempRoot, { recursive: true });
    const directory = await mkdtemp(join(tempRoot, 'dafan-backup-'));
    const zipPath = join(directory, `搭饭小馆-${new Date().toLocaleDateString('sv-SE')}.zip`);
    const databaseCopy = join(directory, 'app.db');
    try {
      await database.$executeRawUnsafe(`VACUUM INTO '${sqliteString(databaseCopy)}'`);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const settings = await database.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const config = Buffer.from(
      JSON.stringify(
        {
          appName: settings.appName,
          subtitle: settings.subtitle,
          defaultPort: settings.defaultPort,
          autoBackupEnabled: settings.autoBackupEnabled,
          createdAt: new Date().toISOString()
        },
        null,
        2
      )
    );
    const sources = [{ path: 'app.db', source: databaseCopy }, ...(await filesUnder(uploadsDirectory, 'uploads'))];
    const files: ManifestFile[] = [];
    for (const item of sources) files.push({ path: item.path, ...(await fileHash(item.source)) });
    files.push({ path: 'config.json', size: config.byteLength, sha256: hash(config) });
    const manifest: Manifest = { backupVersion: 1, appVersion: '1.0.0', createdAt: new Date().toISOString(), files };
    const output = createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.pipe(output);
    for (const item of sources) archive.file(item.source, { name: item.path });
    archive.append(config, { name: 'config.json' });
    archive.append(JSON.stringify(manifest, null, 2), { name: 'backup-manifest.json' });
    await archive.finalize();
    await new Promise<void>((resolveOutput, rejectOutput) => {
      output.on('close', resolveOutput);
      output.on('error', rejectOutput);
    });
    return {
      zipPath,
      filename: zipPath.split(sep).at(-1)!,
      cleanup: () => rm(directory, { recursive: true, force: true })
    };
  });
}

export async function ensureDailyBackup(database: PrismaClient) {
  const settings = await database.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  if (!settings.autoBackupEnabled) return { created: false };
  const directory = backupsDirectory;
  await mkdir(directory, { recursive: true });
  const day = new Date().toLocaleDateString('sv-SE');
  const existing = (await readdir(directory)).find((name) => name.startsWith(`auto-${day}-`) && name.endsWith('.zip'));
  if (existing) return { created: false, path: resolve(directory, existing) };
  const backup = await createBackup(database);
  const target = resolve(directory, `auto-${day}-${Date.now()}.zip`);
  try {
    assertIsolatedPath(target);
    await copyFile(backup.zipPath, target);
  } finally {
    await backup.cleanup();
  }
  const backups = (await readdir(directory))
    .filter((name) => name.startsWith('auto-') && name.endsWith('.zip'))
    .sort()
    .reverse();
  for (const old of backups.slice(30)) {
    assertIsolatedPath(resolve(directory, old));
    await rm(resolve(directory, old), { force: true });
  }
  return { created: true, path: target };
}

function safeEntryPath(value: string): boolean {
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  const segments = normalized.split('/').filter(Boolean);
  const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  return (
    Boolean(normalized) &&
    !normalized.startsWith('/') &&
    !normalized.startsWith('../') &&
    !normalized.includes('/../') &&
    !/^[A-Za-z]:/.test(normalized) &&
    segments.every((segment) => !segment.includes(':') && !/[. ]$/.test(segment) && !windowsReserved.test(segment))
  );
}

function allowedEntryPath(path: string): boolean {
  return ['backup-manifest.json', 'config.json', 'app.db'].includes(path) || path.startsWith('uploads/');
}

function maximumSizeFor(path: string): number {
  if (path === 'app.db') return backupResourceLimits.databaseBytes;
  if (path === 'backup-manifest.json' || path === 'config.json') return backupResourceLimits.metadataFileBytes;
  return backupResourceLimits.uploadFileBytes;
}

function isSymbolicLink(entry: ZipEntry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
}

async function extractEntry(
  entry: ZipEntry,
  target: string,
  maximumBytes: number,
  addToTotal: (bytes: number) => void
): Promise<ExtractedFile> {
  const digest = createHash('sha256');
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      try {
        if (size > maximumBytes) throw Object.assign(new Error(`备份文件过大：${entry.path}`), { statusCode: 413 });
        addToTotal(chunk.byteLength);
        digest.update(chunk);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    }
  });
  await pipeline(entry.stream() as Readable, limiter, createWriteStream(target, { flags: 'wx' }));
  return { size, sha256: digest.digest('hex') };
}

async function extractBackup(zipPath: string, stage: string): Promise<Map<string, ExtractedFile>> {
  const directory = await unzipper.Open.file(zipPath);
  if (directory.files.length > backupResourceLimits.entryCount) {
    throw Object.assign(new Error('备份包文件数量过多'), { statusCode: 413 });
  }
  const seen = new Set<string>();
  let declaredTotal = 0;
  let actualTotal = 0;
  for (const entry of directory.files) {
    if (!safeEntryPath(entry.path)) throw Object.assign(new Error('备份包包含不安全路径'), { statusCode: 422 });
    if (entry.type === 'Directory') continue;
    if (!allowedEntryPath(entry.path))
      throw Object.assign(new Error(`备份包包含未知文件：${entry.path}`), { statusCode: 422 });
    const canonicalPath = entry.path.toLocaleLowerCase('en-US');
    if (seen.has(canonicalPath))
      throw Object.assign(new Error(`备份包包含重复文件：${entry.path}`), { statusCode: 422 });
    seen.add(canonicalPath);
    if (isSymbolicLink(entry) || (entry.flags & 1) !== 0) {
      throw Object.assign(new Error(`备份包包含不支持的文件：${entry.path}`), { statusCode: 422 });
    }
    if (
      !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0 ||
      entry.uncompressedSize > maximumSizeFor(entry.path)
    ) {
      throw Object.assign(new Error(`备份文件大小无效：${entry.path}`), { statusCode: 413 });
    }
    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > backupResourceLimits.extractedBytes) {
      throw Object.assign(new Error('备份包解压后总大小超过限制'), { statusCode: 413 });
    }
  }
  const extracted = new Map<string, ExtractedFile>();
  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    const target = resolve(stage, ...entry.path.split('/'));
    if (!target.startsWith(`${stage}${sep}`)) throw Object.assign(new Error('备份包路径越界'), { statusCode: 422 });
    await mkdir(dirname(target), { recursive: true });
    extracted.set(
      entry.path,
      await extractEntry(entry, target, maximumSizeFor(entry.path), (bytes) => {
        actualTotal += bytes;
        if (actualTotal > backupResourceLimits.extractedBytes) {
          throw Object.assign(new Error('备份包实际解压大小超过限制'), { statusCode: 413 });
        }
      })
    );
  }
  return extracted;
}

function parseManifest(value: string): Manifest {
  const manifest = JSON.parse(value) as Partial<Manifest>;
  if (manifest.backupVersion !== 1 || !Array.isArray(manifest.files)) {
    throw Object.assign(new Error('备份清单版本不受支持'), { statusCode: 422 });
  }
  return manifest as Manifest;
}

function validateManifest(manifest: Manifest, extracted: Map<string, ExtractedFile>): void {
  const listed = new Set<string>();
  for (const file of manifest.files) {
    if (!safeEntryPath(file.path) || !allowedEntryPath(file.path) || file.path === 'backup-manifest.json') {
      throw Object.assign(new Error('备份清单路径无效'), { statusCode: 422 });
    }
    const canonicalPath = file.path.toLocaleLowerCase('en-US');
    if (listed.has(canonicalPath))
      throw Object.assign(new Error(`备份清单包含重复文件：${file.path}`), { statusCode: 422 });
    listed.add(canonicalPath);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw Object.assign(new Error(`备份清单内容无效：${file.path}`), { statusCode: 422 });
    }
    const actual = extracted.get(file.path);
    if (!actual || actual.size !== file.size || actual.sha256 !== file.sha256) {
      throw Object.assign(new Error(`备份文件校验失败：${file.path}`), { statusCode: 422 });
    }
  }
  const actualDataFiles = [...extracted.keys()].filter((path) => path !== 'backup-manifest.json');
  if (
    !listed.has('app.db') ||
    !listed.has('config.json') ||
    actualDataFiles.some((path) => !listed.has(path.toLocaleLowerCase('en-US')))
  ) {
    throw Object.assign(new Error('备份清单与压缩包内容不一致'), { statusCode: 422 });
  }
}

export async function restoreBackup(
  database: PrismaClient,
  zipPath: string,
  allowedInFlight = 0,
  beforeMaintenance?: () => void
) {
  return withBackupLock(async () => {
    const dataRoot = resolveRestoreTempDirectory();
    const stage = resolve(dataRoot, `.restore-${randomUUID()}`);
    const rollback = resolve(dataRoot, `.rollback-${randomUUID()}`);
    const currentDatabase = databasePath();
    assertSameStorageVolume([stage, rollback, currentDatabase]);
    await mkdir(stage, { recursive: true });
    let maintenanceStarted = false;
    let switchedHealthy = false;
    let rolledBackHealthy = false;
    const sidecars = ['-wal', '-shm'];
    const copySidecars = async (source: string, target: string) => {
      for (const suffix of sidecars) {
        if (await stat(`${source}${suffix}`).catch(() => null)) await copyFile(`${source}${suffix}`, `${target}${suffix}`);
      }
    };
    const removeSidecars = async (path: string) => {
      for (const suffix of sidecars) await rm(`${path}${suffix}`, { force: true });
    };
    try {
      const extracted = await extractBackup(zipPath, stage);
      const manifest = parseManifest(await readFile(resolve(stage, 'backup-manifest.json'), 'utf8'));
      validateManifest(manifest, extracted);
      const stagedDatabase = resolve(stage, 'app.db');
      await stat(stagedDatabase);
      await auditStagedDatabase(stagedDatabase);

      // 所有预检完成后才消费高风险授权、进入维护态，保证无效备份不会消耗授权或阻断服务。
      beforeMaintenance?.();
      await beginMaintenance(allowedInFlight);
      maintenanceStarted = true;
      await database.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
      await database.$disconnect();
      await mkdir(rollback, { recursive: true });
      await copyFile(currentDatabase, resolve(rollback, 'app.db'));
      await copySidecars(currentDatabase, resolve(rollback, 'app.db'));
      const existingUploads = await stat(uploadsDirectory).catch(() => null);
      if (existingUploads) await cp(uploadsDirectory, resolve(rollback, 'uploads'), { recursive: true });

      try {
        await removeSidecars(currentDatabase);
        await copyFile(stagedDatabase, currentDatabase);
        await rm(uploadsDirectory, { recursive: true, force: true });
        const stagedUploads = resolve(stage, 'uploads');
        if (await stat(stagedUploads).catch(() => null)) await rename(stagedUploads, uploadsDirectory);
        else await mkdir(uploadsDirectory, { recursive: true });
        await database.$connect();
        await database.$queryRawUnsafe('SELECT 1');
        await database.settings.findUnique({ where: { id: 1 } });
        await database.shoppingList.count();
        switchedHealthy = true;
      } catch (switchError) {
        await database.$disconnect().catch(() => undefined);
        try {
          await removeSidecars(currentDatabase);
          await copyFile(resolve(rollback, 'app.db'), currentDatabase);
          await copySidecars(resolve(rollback, 'app.db'), currentDatabase);
          await rm(uploadsDirectory, { recursive: true, force: true });
          if (await stat(resolve(rollback, 'uploads')).catch(() => null)) {
            await cp(resolve(rollback, 'uploads'), uploadsDirectory, { recursive: true });
          } else await mkdir(uploadsDirectory, { recursive: true });
          await database.$connect();
          await database.$queryRawUnsafe('SELECT 1');
          await database.settings.findUnique({ where: { id: 1 } });
          await database.shoppingList.count();
          rolledBackHealthy = true;
        } catch (rollbackError) {
          throw Object.assign(new Error(`恢复切换失败且回滚未完成，rollback 目录已保留：${rollbackError instanceof Error ? rollbackError.message : '未知错误'}`), { statusCode: 503 });
        }
        throw switchError;
      }
      clearPinSessions();
      return { restored: true, restartRecommended: true };
    } finally {
      await rm(stage, { recursive: true, force: true });
      if (switchedHealthy || rolledBackHealthy) await rm(rollback, { recursive: true, force: true });
      if (maintenanceStarted && (switchedHealthy || rolledBackHealthy)) endMaintenance();
    }
  });
}
