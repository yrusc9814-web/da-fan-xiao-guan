import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { failure, success } from '../../shared/http.js';
import {
  consumeReservedHighRiskAuthorization,
  releaseHighRiskAuthorization,
  reserveHighRiskAuthorization
} from '../settings/service.js';
import { clearUploadSessionCookie } from '../settings/routes.js';
import { backupResourceLimits, createBackup, restoreBackup } from './service.js';

export async function registerBackupRoutes(app: FastifyInstance, database: PrismaClient) {
  app.get('/api/v1/backups/export', async (_request, reply) => {
    const backup = await createBackup(database);
    reply.raw.once('close', () => void backup.cleanup());
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(backup.filename)}`)
      .send(createReadStream(backup.zipPath));
  });

  app.post(
    '/api/v1/backups/restore',
    { bodyLimit: backupResourceLimits.zipUploadBytes + 1024 * 1024 },
    async (request, reply) => {
      const token = request.headers['x-high-risk-token'] as string | undefined;
      const reservation = reserveHighRiskAuthorization(token, 'RESTORE');
      let authorizationConsumed = false;
      const directory = await mkdtemp(join(tmpdir(), 'dafan-restore-upload-'));
      const zipPath = join(directory, 'backup.zip');
      try {
        const part = await request.file({ limits: { fileSize: backupResourceLimits.zipUploadBytes, files: 1 } });
        if (!part) return reply.code(400).send(failure('VALIDATION_ERROR', '请选择 ZIP 备份文件'));
        if (!part.filename.toLowerCase().endsWith('.zip')) {
          part.file.resume();
          return reply.code(422).send(failure('INVALID_FILE', '仅支持 ZIP 备份文件'));
        }
        await pipeline(part.file, createWriteStream(zipPath, { flags: 'wx' }));
        if (part.file.truncated) return reply.code(413).send(failure('FILE_TOO_LARGE', '备份 ZIP 超过上传大小限制'));
        // restoreBackup 内部会 clearPinSessions() 使服务端会话全部失效，这里顺带让浏览器丢弃 upload cookie
        clearUploadSessionCookie(reply);
        return success(
          await restoreBackup(database, zipPath, 1, () => {
            consumeReservedHighRiskAuthorization(token, 'RESTORE', reservation);
            authorizationConsumed = true;
          })
        );
      } finally {
        if (!authorizationConsumed) releaseHighRiskAuthorization(token, reservation);
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
}
