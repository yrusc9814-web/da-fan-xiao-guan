import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { ZipArchive } from 'archiver';
import unzipper, { type File as ZipEntry } from 'unzipper';

import { filePathFromDatabaseUrl, resolveDatabaseUrl } from '../../database/paths.js';
import { beginMaintenance, endMaintenance } from '../../plugins/maintenance.js';
import { clearPinSessions } from '../settings/service.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const uploadsDirectory = resolve(projectRoot, 'data/uploads');

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
    const directory = await mkdtemp(join(tmpdir(), 'dafan-backup-'));
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
  const directory = resolve(projectRoot, 'data/backups');
  await mkdir(directory, { recursive: true });
  const day = new Date().toLocaleDateString('sv-SE');
  const existing = (await readdir(directory)).find((name) => name.startsWith(`auto-${day}-`) && name.endsWith('.zip'));
  if (existing) return { created: false, path: resolve(directory, existing) };
  const backup = await createBackup(database);
  const target = resolve(directory, `auto-${day}-${Date.now()}.zip`);
  try {
    await copyFile(backup.zipPath, target);
  } finally {
    await backup.cleanup();
  }
  const backups = (await readdir(directory))
    .filter((name) => name.startsWith('auto-') && name.endsWith('.zip'))
    .sort()
    .reverse();
  for (const old of backups.slice(30)) await rm(resolve(directory, old), { force: true });
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
  const dataRoot = resolve(projectRoot, 'data');
  const stage = resolve(dataRoot, `.restore-${randomUUID()}`);
  const rollback = resolve(dataRoot, `.rollback-${randomUUID()}`);
  await mkdir(stage, { recursive: true });
  let maintenanceStarted = false;
  try {
    const extracted = await extractBackup(zipPath, stage);
    const manifest = parseManifest(await readFile(resolve(stage, 'backup-manifest.json'), 'utf8'));
    validateManifest(manifest, extracted);
    const stagedDatabase = resolve(stage, 'app.db');
    await stat(stagedDatabase);
    const check = (await import('../../database/client.js')).createPrismaClient(`file:${stagedDatabase}`);
    try {
      const integrity = await check.$queryRawUnsafe<Array<{ integrity_check: string }>>('PRAGMA integrity_check');
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('数据库完整性检查失败');
      const migrations = await check.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL'
      );
      if (!migrations.length) throw new Error('缺少数据库迁移记录');
    } finally {
      await check.$disconnect();
    }
    beforeMaintenance?.();
    await beginMaintenance(allowedInFlight);
    maintenanceStarted = true;
    const currentDatabase = databasePath();
    await database.$queryRawUnsafe('PRAGMA wal_checkpoint(FULL)');
    await database.$disconnect();
    await mkdir(rollback, { recursive: true });
    await copyFile(currentDatabase, resolve(rollback, 'app.db'));
    if (await stat(uploadsDirectory).catch(() => null))
      await cp(uploadsDirectory, resolve(rollback, 'uploads'), { recursive: true });
    try {
      await copyFile(stagedDatabase, currentDatabase);
      await rm(uploadsDirectory, { recursive: true, force: true });
      const stagedUploads = resolve(stage, 'uploads');
      if (await stat(stagedUploads).catch(() => null)) await rename(stagedUploads, uploadsDirectory);
      else await mkdir(uploadsDirectory, { recursive: true });
      await database.$connect();
      await database.$queryRawUnsafe('SELECT 1');
      await database.settings.findUnique({ where: { id: 1 } });
    } catch (error) {
      await database.$disconnect().catch(() => undefined);
      await copyFile(resolve(rollback, 'app.db'), currentDatabase);
      await rm(uploadsDirectory, { recursive: true, force: true });
      if (await stat(resolve(rollback, 'uploads')).catch(() => null)) {
        await cp(resolve(rollback, 'uploads'), uploadsDirectory, { recursive: true });
      }
      await database.$connect();
      throw error;
    }
    clearPinSessions();
    return { restored: true, restartRecommended: true };
  } finally {
    if (maintenanceStarted) endMaintenance();
    await rm(stage, { recursive: true, force: true });
    await rm(rollback, { recursive: true, force: true });
  }
}
