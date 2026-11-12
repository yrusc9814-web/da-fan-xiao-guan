import { createReadStream } from 'node:fs';
import { mkdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';

import multipart from '@fastify/multipart';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';

import type { UploadAssetDto } from '../../../../shared/types/domain.js';
import { failure, success } from '../../shared/http.js';
import { assertIsolatedPath, resolveUploadsDirectory } from '../../database/paths.js';

const uploadsDirectory = resolveUploadsDirectory();
const thumbnailsDirectory = resolve(uploadsDirectory, 'thumbnails');
const maxUploadBytes = 8 * 1024 * 1024;

const contentTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

const formatExtensions: Record<'jpeg' | 'png' | 'webp', string> = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp'
};

function safeUploadPath(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }

  decoded = decoded.replaceAll('\\', '/');
  const segments = decoded.split('/');
  if (
    !decoded ||
    decoded.startsWith('/') ||
    decoded.includes('\0') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null;
  }

  const candidate = resolve(uploadsDirectory, ...segments);
  return candidate === uploadsDirectory || !candidate.startsWith(`${uploadsDirectory}${sep}`) ? null : candidate;
}

function toDto(asset: {
  id: string;
  filename: string;
  thumbnailPath: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  createdAt: Date;
}): UploadAssetDto {
  return {
    id: asset.id,
    url: `/uploads/${asset.filename}`,
    thumbnailUrl: asset.thumbnailPath ? `/uploads/${asset.thumbnailPath}` : null,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    createdAt: asset.createdAt.toISOString()
  };
}

/**
 * 解析 MealRecord.photosJson（规范 JSON 字符串数组）。返回 null 表示“无多图列表”，
 * 非数组/含非字符串/坏 JSON 视为数据损坏 → 抛错快速失败，绝不静默当成“无人引用”。
 */
function parsePhotosJson(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw Object.assign(new Error('MealRecord.photosJson 数据损坏：不是合法 JSON'), { statusCode: 500 });
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw Object.assign(new Error('MealRecord.photosJson 数据损坏：不是字符串数组'), { statusCode: 500 });
  }
  return parsed as string[];
}

/**
 * 上传资产是否被业务数据引用。
 *
 * 修复点（Google2 第二轮）：旧实现只匹配各实体单一 imagePath 列，多图记录的第 2/3 张
 * 会被误判为“无人引用”从而连文件一起删除。现在：
 *   * MealRecord 同时检查 imagePath（旧单图）与 photosJson（多图有序数组）中的每一张；
 *   * photosJson 用正规 JSON 解析后逐项精确比对，绝不用 LIKE '%name%' 拼接（避免子串误判与注入）；
 *   * 坏 JSON / 非数组结构抛错（fail-closed），不会把用户图片当成可删除；
 *   * 旧单图字段语义完全保留（旧记录 / 旧字段继续保护其图片）。
 */
async function isReferenced(
  database: PrismaClient,
  asset: { filename: string; thumbnailPath: string | null }
): Promise<boolean> {
  const paths = [`/uploads/${asset.filename}`, asset.filename];
  if (asset.thumbnailPath) paths.push(`/uploads/${asset.thumbnailPath}`, asset.thumbnailPath);
  const pathSet = new Set(paths);
  const [recipes, stores, records] = await Promise.all([
    database.recipe.count({ where: { deletedAt: null, imagePath: { in: paths } } }),
    database.store.count({ where: { deletedAt: null, imagePath: { in: paths } } }),
    database.mealRecord.findMany({
      where: { deletedAt: null, NOT: { photosJson: null } },
      select: { imagePath: true, photosJson: true }
    })
  ]);
  if (recipes + stores > 0) return true;

  const singleImageRecords = await database.mealRecord.count({
    where: { deletedAt: null, imagePath: { in: paths } }
  });
  if (singleImageRecords > 0) return true;

  // 多图：只解析本资产相关的 photosJson 列（逐条精确比对，容量为本地个人库规模）。
  for (const record of records) {
    const photos = parsePhotosJson(record.photosJson as string);
    if (photos.some((photo) => pathSet.has(photo) || pathSet.has(photo.replace(/^\/uploads\//, '')))) {
      return true;
    }
  }
  return false;
}

export async function registerUploadRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  assertIsolatedPath(thumbnailsDirectory);
  await mkdir(thumbnailsDirectory, { recursive: true });
  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: maxUploadBytes
    }
  });

  app.post('/api/v1/uploads/images', async (request, reply) => {
    try {
      const part = await request.file();
      if (!part) return reply.code(400).send(failure('VALIDATION_ERROR', '请选择图片文件'));

      const declaredExtension = extname(part.filename).toLowerCase();
      if (!contentTypes[declaredExtension] || contentTypes[declaredExtension] !== part.mimetype) {
        part.file.resume();
        return reply.code(422).send(failure('INVALID_FILE', '图片扩展名与 MIME 类型不匹配'));
      }

      const input = await part.toBuffer();
      const image = sharp(input, { failOn: 'error' }).rotate();
      const metadata = await image.metadata();
      if (!metadata.format || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
        return reply.code(422).send(failure('INVALID_FILE', '仅支持 JPG、PNG 或 WEBP 图片'));
      }

      const format = metadata.format as 'jpeg' | 'png' | 'webp';
      const actualMime = contentTypes[formatExtensions[format]];
      if (actualMime !== part.mimetype) {
        return reply.code(422).send(failure('INVALID_FILE', '图片实际格式与声明类型不匹配'));
      }

      const filename = `${randomUUID()}${formatExtensions[format]}`;
      const thumbnailFilename = `thumbnails/${randomUUID()}.webp`;
      const outputPath = resolve(uploadsDirectory, filename);
      const thumbnailPath = resolve(uploadsDirectory, thumbnailFilename);
      const normalized = await image
        .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
        .toFormat(format, format === 'jpeg' ? { quality: 88 } : undefined)
        .toBuffer();
      const thumbnail = await sharp(input)
        .rotate()
        .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      const finalMetadata = await sharp(normalized).metadata();

      assertIsolatedPath(outputPath);
      assertIsolatedPath(thumbnailPath);
      await Promise.all([
        writeFile(outputPath, normalized, { flag: 'wx' }),
        writeFile(thumbnailPath, thumbnail, { flag: 'wx' })
      ]);
      try {
        const asset = await database.uploadAsset.create({
          data: {
            filename,
            storagePath: filename,
            thumbnailPath: thumbnailFilename,
            mimeType: actualMime,
            sizeBytes: normalized.byteLength,
            sha256: createHash('sha256').update(normalized).digest('hex'),
            width: finalMetadata.width,
            height: finalMetadata.height
          }
        });
        return reply.code(201).send(success(toDto(asset)));
      } catch (error) {
        await Promise.allSettled([unlink(outputPath), unlink(thumbnailPath)]);
        throw error;
      }
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
        return reply.code(413).send(failure('FILE_TOO_LARGE', '单张图片不能超过 8MB'));
      }
      if (error instanceof Error && /unsupported image format|Input buffer/i.test(error.message)) {
        return reply.code(422).send(failure('INVALID_FILE', '图片内容无法识别'));
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/v1/uploads/images/:id', async (request, reply) => {
    const asset = await database.uploadAsset.findFirst({ where: { id: request.params.id, deletedAt: null } });
    if (!asset) return reply.code(404).send(failure('NOT_FOUND', '图片不存在'));
    if (asset.recipeId || asset.storeId || asset.mealRecordId || (await isReferenced(database, asset))) {
      return reply.code(409).send(failure('REFERENCED_RESOURCE', '图片正在被业务数据使用，不能删除'));
    }

    assertIsolatedPath(resolve(uploadsDirectory, asset.storagePath));
    if (asset.thumbnailPath) assertIsolatedPath(resolve(uploadsDirectory, asset.thumbnailPath));
    await database.uploadAsset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } });
    await Promise.allSettled([
      unlink(resolve(uploadsDirectory, asset.storagePath)),
      ...(asset.thumbnailPath ? [unlink(resolve(uploadsDirectory, asset.thumbnailPath))] : [])
    ]);
    return reply.send(success({ id: asset.id, deleted: true }));
  });

  app.get<{ Params: { '*': string } }>('/uploads/*', async (request, reply) => {
    const candidate = safeUploadPath(request.params['*'] ?? '');
    if (!candidate) return reply.code(404).send(failure('NOT_FOUND', '图片不存在'));

    try {
      const [root, file] = await Promise.all([realpath(uploadsDirectory), realpath(candidate)]);
      if (file !== root && !file.startsWith(`${root}${sep}`))
        return reply.code(404).send(failure('NOT_FOUND', '图片不存在'));

      const fileStats = await stat(file);
      const contentType = contentTypes[extname(file).toLowerCase()];
      if (!fileStats.isFile() || !contentType) return reply.code(404).send(failure('NOT_FOUND', '图片不存在'));

      return reply
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .type(contentType)
        .send(createReadStream(file));
    } catch {
      return reply.code(404).send(failure('NOT_FOUND', '图片不存在'));
    }
  });
}
