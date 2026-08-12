import { createWriteStream } from 'node:fs';
import { readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZipArchive } from 'archiver';

import { buildApp } from '../src/app.js';
import { createTestPrismaClient } from '../src/database/test-database.js';
import { backupResourceLimits, createBackup, restoreBackup } from '../src/modules/backup/service.js';
import { setPin } from '../src/modules/settings/service.js';

const database = createTestPrismaClient();
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

function multipartPayload(boundary: string, filename: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

async function createZip(path: string, entries: Array<{ name: string; content: Buffer }>): Promise<void> {
  const output = createWriteStream(path);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.pipe(output);
  for (const entry of entries) archive.append(entry.content, { name: entry.name });
  await archive.finalize();
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
  });
}

describe('备份恢复', () => {
  beforeAll(async () => {
    await database.$connect();
    await database.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    app = await buildApp({ database, logger: false });
  });
  afterAll(async () => {
    try {
      await database.settings.updateMany({
        where: { id: 1 },
        data: { pinEnabled: false, pinHash: null, version: { increment: 1 } }
      });
    } finally {
      try {
        await app?.close();
      } finally {
        await database.$disconnect();
      }
    }
  });

  it('真实备份后可恢复旧数据，损坏 ZIP 不破坏当前数据', async () => {
    const recipe = await database.recipe.create({ data: { name: '备份状态A' } });
    const backup = await createBackup(database);
    const temporary = await mkdtemp(join(tmpdir(), 'dafan-broken-backup-'));
    try {
      await database.recipe.update({ where: { id: recipe.id }, data: { name: '备份状态B' } });
      await restoreBackup(database, backup.zipPath);
      expect((await database.recipe.findUniqueOrThrow({ where: { id: recipe.id } })).name).toBe('备份状态A');

      await database.recipe.update({ where: { id: recipe.id }, data: { name: '备份状态C' } });
      const broken = Buffer.from(await readFile(backup.zipPath));
      broken[Math.floor(broken.length / 2)]! ^= 255;
      const brokenPath = join(temporary, 'broken.zip');
      await writeFile(brokenPath, broken);
      await expect(restoreBackup(database, brokenPath)).rejects.toBeTruthy();
      expect((await database.recipe.findUniqueOrThrow({ where: { id: recipe.id } })).name).toBe('备份状态C');
    } finally {
      await backup.cleanup();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('普通 PIN session 不能恢复，正确二次授权可以且 token 一次使用', async () => {
    const current = await database.settings.findUniqueOrThrow({ where: { id: 1 } });
    await setPin(database, current.version, '8642', true);
    const verified = (
      await app!.inject({ method: 'POST', url: '/api/v1/settings/pin/verify', payload: { pin: '8642' } })
    ).json().data;
    const backup = await createBackup(database);
    try {
      const boundary = '----dafan-backup-test';
      const body = multipartPayload(boundary, 'backup.zip', await readFile(backup.zipPath));
      const ordinary = await app!.inject({
        method: 'POST',
        url: '/api/v1/backups/restore',
        headers: { 'x-app-pin-token': verified.token, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body
      });
      expect(ordinary.statusCode).toBe(401);
      expect(ordinary.json().error.code).toBe('HIGH_RISK_AUTHORIZATION_REQUIRED');

      const authorization = await app!.inject({
        method: 'POST',
        url: '/api/v1/settings/high-risk/authorize',
        headers: { 'x-app-pin-token': verified.token },
        payload: { action: 'RESTORE', pin: '8642' }
      });
      expect(authorization.statusCode).toBe(200);
      const restored = await app!.inject({
        method: 'POST',
        url: '/api/v1/backups/restore',
        headers: {
          'x-app-pin-token': verified.token,
          'x-high-risk-token': authorization.json().data.token,
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        payload: body
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().data.restored).toBe(true);
    } finally {
      await backup.cleanup();
    }
  });

  it('拒绝超过单个上传文件展开限制的 ZIP', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'dafan-oversized-backup-'));
    const zipPath = join(temporary, 'oversized.zip');
    try {
      await createZip(zipPath, [
        {
          name: 'uploads/oversized.png',
          content: Buffer.alloc(backupResourceLimits.uploadFileBytes + 1)
        }
      ]);
      await expect(restoreBackup(database, zipPath)).rejects.toMatchObject({ statusCode: 413 });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
