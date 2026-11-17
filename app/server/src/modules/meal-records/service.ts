import type {
  MealRole,
  MealType,
  Prisma,
  PrismaClient,
  RecordItemType,
  RecordSourceType,
  RecordStatus
} from '@prisma/client';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { resolveUploadsDirectory } from '../../database/paths.js';
import { VersionConflictError } from '../../database/optimistic-lock.js';
import { recordDeletedItem } from '../../database/deleted-items.js';
import { isValidBusinessDate } from '../calendar/business-date.js';
import { normalizePagination, toPaginationResponse } from '../../database/pagination.js';

/** 与上传路由同源的上传根目录（data/uploads），用于 file existence 校验。 */
const uploadsDirectory = resolveUploadsDirectory();

export interface RecordItemInput {
  itemType: RecordItemType;
  mealRole?: MealRole | null;
  recipeId?: string | null;
  storeId?: string | null;
  customName?: string | null;
  sortOrder?: number;
}

export interface RecordInput {
  recordDate: string;
  recordTime?: string | null;
  title?: string | null;
  mealType: MealType;
  sourceType: RecordSourceType;
  status?: RecordStatus;
  imagePath?: string | null;
  /**
   * 多图照片（最多 3 张，有序，第 1 张为封面）。契约（与 shared MealRecordDto.photos 一致）：
   * - 非空数组 → 落库 canonical JSON（JSON.stringify），并同步 imagePath = photos[0]；
   * - 显式 null 或 [] → 清空：photosJson = null 且 imagePath = null；
   * - 省略（undefined）→ 保留旧值（不清空、不推断）。
   * 条目必须是 /uploads/... 相对路径且真实存在于 UploadAsset（禁止 data URL/base64 落 SQLite）。
   */
  photos?: string[] | null;
  rating?: number | null;
  /** 饱腹度：仅接受正式档位 3/5/7/8/10，null 表示未填写。 */
  satiety?: number | null;
  /** 摄入热量 kcal：非负整数，null 表示未填写。 */
  calories?: number | null;
  /** 就餐消费（元）：0..9999 整数，null 表示未填写。 */
  cost?: number | null;
  isNewTry?: boolean;
  favorite?: boolean;
  notes?: string | null;
  relatedPlanId?: string | null;
  items?: RecordItemInput[];
  dinerIds?: string[];
}

/** 饱腹度正式档位；与前端 Google 2.0 select 的 value 保持一致（旧 demo 值 4 不在正式契约内）。 */
export const SATIETY_LEVELS = [3, 5, 7, 8, 10] as const;

const RECORD_COST_MAX = 9999;
const RECORD_TITLE_MAX = 200;

function normalizeTitle(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw httpError(400, '记录标题必须是字符串或 null');
  const title = value.trim();
  if (title.length > RECORD_TITLE_MAX) throw httpError(400, `记录标题不能超过 ${RECORD_TITLE_MAX} 个字符`);
  return title || null;
}

/** 多图上限：与冻结 UI photoSlotView-0..2 的 0..3 相框一一对应，绝不静默截断。 */
export const RECORD_PHOTOS_MAX = 3;

/** 业务照片只接受 /uploads/ 下的相对存储路径（禁 data URL / base64 / 绝对路径 / 逃逸）。 */
const UPLOAD_PATH_PATTERN = /^\/uploads\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export interface PhotoValidationContext {
  /** 真实存在的 UploadAsset 相对路径集合（filename 与 /uploads/filename 两种形态）。 */
  knownPaths?: ReadonlySet<string>;
}

function assertPhotoPath(path: unknown, index: number): string {
  if (typeof path !== 'string') throw httpError(400, `第 ${index + 1} 张照片路径必须是字符串`);
  const cleaned = path.trim();
  if (!cleaned) throw httpError(400, `第 ${index + 1} 张照片路径不能为空`);
  if (cleaned.length > 300) throw httpError(400, `第 ${index + 1} 张照片路径过长`);
  if (/^data:/i.test(cleaned) || /;base64,/i.test(cleaned))
    throw httpError(400, `第 ${index + 1} 张照片不能使用 data URL / base64，请先上传为文件`);
  if (cleaned.includes('\0') || cleaned.includes('\\'))
    throw httpError(400, `第 ${index + 1} 张照片路径不能包含非法字符`);
  if (cleaned.includes('..') || cleaned.includes('./') || cleaned.includes('//'))
    throw httpError(400, `第 ${index + 1} 张照片路径不能包含目录逃逸片段`);
  if (!UPLOAD_PATH_PATTERN.test(cleaned)) throw httpError(400, `第 ${index + 1} 张照片必须是 /uploads/ 下的图片路径`);
  return cleaned;
}

/**
 * photos 入参规范化。返回值语义：
 * - `{ mode: 'keep' }`：省略 → 保留旧值；
 * - `{ mode: 'clear' }`：显式 null 或 [] → 清空 photosJson + imagePath；
 * - `{ mode: 'write', photos }`：非空有序数组 → 写 canonical JSON。
 * 非法类型 / 超过 3 张 / data URL / 路径逃逸一律 400 快速失败，绝不静默丢图或只取第一张。
 */
export function normalizePhotos(
  value: unknown,
  context: PhotoValidationContext = {}
): { mode: 'keep' } | { mode: 'clear' } | { mode: 'write'; photos: string[] } {
  if (value === undefined) return { mode: 'keep' };
  if (value === null) return { mode: 'clear' };
  if (!Array.isArray(value)) throw httpError(400, '多图照片必须是数组或 null');
  if (!value.length) return { mode: 'clear' };
  if (value.length > RECORD_PHOTOS_MAX) throw httpError(400, `多图照片最多 ${RECORD_PHOTOS_MAX} 张，请先删除多余照片`);
  const photos = value.map((entry, index) => assertPhotoPath(entry, index));
  const unique = new Set(photos);
  if (unique.size !== photos.length) throw httpError(400, '多图照片不能重复');
  if (context.knownPaths) {
    for (const [index, path] of photos.entries()) {
      const filename = path.slice('/uploads/'.length);
      if (!context.knownPaths.has(path) && !context.knownPaths.has(filename))
        throw httpError(400, `第 ${index + 1} 张照片不是本服务已上传的图片，请重新上传`);
    }
  }
  return { mode: 'write', photos };
}

/** 读取侧解析 photosJson：NULL → 回退旧单图 imagePath；损坏 JSON → 快速失败而非静默丢字段。 */
export function photosFromRow(row: { photosJson: string | null; imagePath: string | null }): string[] | null {
  if (row.photosJson === null) return row.imagePath ? [row.imagePath] : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.photosJson);
  } catch {
    throw Object.assign(new Error('饮食记录照片数据损坏（photosJson 非法 JSON）'), { statusCode: 500 });
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string'))
    throw Object.assign(new Error('饮食记录照片数据损坏（photosJson 非字符串数组）'), { statusCode: 500 });
  if (!parsed.length) return row.imagePath ? [row.imagePath] : null;
  return parsed as string[];
}

/**
 * 记录 DTO：photos 与 imagePath 同时给出，photos 遵循读写契约（不伪造、不占位）。
 * 供本模块的 GET/list/create/update 以及 meal-plans 完成计划生成记录等跨模块返回复用。
 */
export function recordDtoWithPhotos<T extends { photosJson: string | null; imagePath: string | null }>(
  row: T
): T & { photos: string[] | null } {
  return { ...row, photos: photosFromRow(row) };
}

/**
 * 校验照片引用真实性：必须是本服务已上传（UploadAsset 未删除）且磁盘文件仍存在的图片。
 * 沿 repo 现有上传约定：文件在 data/uploads，URL 形态 /uploads/<filename>，缩略图为
 * thumbnails/<name>.webp；不信任客户端正则伪造路径。
 */
async function assertUploadedPhotos(
  database: PrismaClient | Prisma.TransactionClient,
  photos: string[]
): Promise<void> {
  const filenames = photos.map((path) => path.slice('/uploads/'.length));
  const assets = await database.uploadAsset.findMany({
    where: {
      deletedAt: null,
      OR: [{ filename: { in: filenames } }, { storagePath: { in: filenames } }, { thumbnailPath: { in: filenames } }]
    },
    select: { filename: true, storagePath: true, thumbnailPath: true }
  });
  const known = new Set<string>();
  for (const asset of assets) {
    for (const value of [asset.filename, asset.storagePath, asset.thumbnailPath]) {
      if (!value) continue;
      known.add(value);
      known.add(`/uploads/${value}`);
    }
  }
  const missing: string[] = [];
  for (const [index, path] of photos.entries()) {
    const filename = path.slice('/uploads/'.length);
    if (!known.has(path) && !known.has(filename)) missing.push(`第 ${index + 1} 张（${path}）`);
    else if (filename && !(await uploadFileExists(filename))) missing.push(`第 ${index + 1} 张（${path}）`);
  }
  if (missing.length) throw httpError(400, `照片不是本服务已上传的图片或文件已丢失：${missing.join('、')}，请重新上传`);
}

/** file existence：沿上传路由同源的 data/uploads 根目录，拒绝路径逃逸（safeUploadPath 同规则）。 */
async function uploadFileExists(relativePath: string): Promise<boolean> {
  const segments = relativePath.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  const candidate = resolve(uploadsDirectory, ...segments);
  if (!candidate.startsWith(`${uploadsDirectory}${sep}`)) return false;
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

type ResolvedPhotoWrite =
  { mode: 'keep' } | { mode: 'clear' } | { mode: 'write'; photosJson: string; imagePath: string };

/** 把入参 photos 解析为库写入语义（含真实性校验）；keep 表示完全不动 photosJson。 */
async function resolvePhotoWrite(
  database: PrismaClient | Prisma.TransactionClient,
  value: unknown
): Promise<ResolvedPhotoWrite> {
  const normalized = normalizePhotos(value);
  if (normalized.mode === 'keep') return { mode: 'keep' };
  if (normalized.mode === 'clear') return { mode: 'clear' };
  await assertUploadedPhotos(database, normalized.photos);
  return { mode: 'write', photosJson: JSON.stringify(normalized.photos), imagePath: normalized.photos[0]! };
}

function assertNullableInteger(
  value: number | null | undefined,
  field: string,
  minimum: number,
  maximum?: number
): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || !Number.isFinite(value)) throw httpError(400, `${field}必须是整数`);
  if (value < minimum) throw httpError(400, `${field}不能小于 ${minimum}`);
  if (maximum !== undefined && value > maximum) throw httpError(400, `${field}不能大于 ${maximum}`);
}

const recordInclude = {
  items: { orderBy: { sortOrder: 'asc' as const }, include: { recipe: true, store: true } },
  diners: { include: { diner: true } }
};

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function validate(input: RecordInput): void {
  normalizeTitle(input.title);
  if (!isValidBusinessDate(input.recordDate)) throw httpError(400, '记录日期必须使用 YYYY-MM-DD 格式且为真实日期');
  if (
    input.rating !== null &&
    input.rating !== undefined &&
    (!Number.isFinite(input.rating) || input.rating < 0 || input.rating > 5)
  )
    throw httpError(400, '评分必须在 0 到 5 之间');
  // 饱腹度只接受正式档位；不把非法值（含旧 demo 值 4）静默降级成整数，也不 coerce 为 0/8。
  if (input.satiety !== null && input.satiety !== undefined) {
    if (!Number.isInteger(input.satiety) || !SATIETY_LEVELS.includes(input.satiety as (typeof SATIETY_LEVELS)[number]))
      throw httpError(400, `饱腹度必须是 ${SATIETY_LEVELS.join('/')} 之一`);
  }
  assertNullableInteger(input.calories, '摄入热量', 0);
  assertNullableInteger(input.cost, '就餐消费', 0, RECORD_COST_MAX);
  // 形状级校验先做（类型/张数/路径形态），真实性（UploadAsset + 文件存在）在 service 写路径异步校验。
  normalizePhotos(input.photos);
  for (const item of input.items ?? []) {
    const links =
      Number(Boolean(item.recipeId)) + Number(Boolean(item.storeId)) + Number(Boolean(item.customName?.trim()));
    if (links !== 1) throw httpError(400, '每个记录项目必须且只能关联菜谱、店铺或自定义名称之一');
    if (
      (item.itemType === 'RECIPE') !== Boolean(item.recipeId) ||
      (item.itemType === 'STORE') !== Boolean(item.storeId) ||
      (item.itemType === 'CUSTOM') !== Boolean(item.customName?.trim())
    )
      throw httpError(400, '记录项目类型与关联内容不一致');
  }
}

function itemCreates(items: RecordItemInput[] = []): Prisma.MealRecordItemCreateWithoutMealRecordInput[] {
  return items.map((item, index) => ({
    itemType: item.itemType,
    mealRole: item.mealRole ?? null,
    recipe: item.recipeId ? { connect: { id: item.recipeId } } : undefined,
    store: item.storeId ? { connect: { id: item.storeId } } : undefined,
    customName: item.customName?.trim() || null,
    sortOrder: item.sortOrder ?? index
  }));
}

export async function listRecords(
  database: PrismaClient,
  query: {
    from?: string;
    to?: string;
    sourceType?: RecordSourceType;
    mealType?: MealType;
    status?: RecordStatus;
    minRating?: string;
    dinerId?: string;
    q?: string;
    page?: number;
    pageSize?: number;
  }
) {
  const q = query.q?.trim();
  const pagination = normalizePagination(query);
  const where: Prisma.MealRecordWhereInput = {
    deletedAt: null,
    ...(query.from || query.to
      ? { recordDate: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
      : {}),
    ...(query.sourceType ? { sourceType: query.sourceType } : {}),
    ...(query.mealType ? { mealType: query.mealType } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.minRating ? { rating: { gte: Number(query.minRating) } } : {}),
    ...(query.dinerId ? { diners: { some: { dinerId: query.dinerId } } } : {}),
    ...(q
      ? {
          OR: [
            { notes: { contains: q } },
            {
              items: {
                some: {
                  OR: [
                    { customName: { contains: q } },
                    { recipe: { name: { contains: q } } },
                    { store: { name: { contains: q } } }
                  ]
                }
              }
            }
          ]
        }
      : {})
  };
  const [items, total] = await Promise.all([
    database.mealRecord.findMany({
      where,
      include: recordInclude,
      orderBy: [{ recordDate: 'desc' }, { recordTime: 'desc' }, { id: 'desc' }],
      skip: pagination.skip,
      take: pagination.take
    }),
    database.mealRecord.count({ where })
  ]);
  return toPaginationResponse(
    items.map((row) => recordDtoWithPhotos(row)),
    pagination.page,
    pagination.pageSize,
    total
  );
}

export async function getRecord(database: PrismaClient, id: string) {
  const record = await database.mealRecord.findFirst({ where: { id, deletedAt: null }, include: recordInclude });
  if (!record) throw httpError(404, '饮食记录不存在');
  return recordDtoWithPhotos(record);
}

export async function createRecord(database: PrismaClient | Prisma.TransactionClient, input: RecordInput) {
  validate(input);
  const photoWrite = await resolvePhotoWrite(database, input.photos);
  const imagePath = photoWrite.mode === 'write' ? photoWrite.imagePath : (input.imagePath ?? null);
  return database.mealRecord
    .create({
      data: {
        recordDate: input.recordDate,
        recordTime: input.recordTime ?? null,
        mealType: input.mealType,
        sourceType: input.sourceType,
        title: normalizeTitle(input.title) ?? null,
        status: input.status ?? 'CONFIRMED',
        confirmedAt: (input.status ?? 'CONFIRMED') === 'CONFIRMED' ? new Date() : null,
        // 多图写入时以 photos[0] 同步首张封面（旧单图消费方继续工作）；无 photos 时保持 imagePath 语义。
        imagePath,
        photosJson: photoWrite.mode === 'write' ? photoWrite.photosJson : null,
        rating: input.rating ?? null,
        satiety: input.satiety ?? null,
        calories: input.calories ?? null,
        cost: input.cost ?? null,
        isNewTry: input.isNewTry ?? false,
        favorite: input.favorite ?? false,
        notes: input.notes ?? null,
        relatedPlanId: input.relatedPlanId ?? null,
        items: { create: itemCreates(input.items) },
        diners: { create: [...new Set(input.dinerIds ?? [])].map((dinerId) => ({ dinerId })) }
      },
      include: recordInclude
    })
    .then((row) => recordDtoWithPhotos(row));
}

export async function updateRecord(database: PrismaClient, id: string, version: number, input: Partial<RecordInput>) {
  return database.$transaction(async (tx) => {
    const current = await tx.mealRecord.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw httpError(404, '饮食记录不存在');
    if (current.version !== version)
      throw new VersionConflictError({
        entity: 'MealRecord',
        id,
        expectedVersion: version,
        actualVersion: current.version
      });
    const photoWrite = await resolvePhotoWrite(tx, input.photos);
    const merged: RecordInput = {
      recordDate: input.recordDate ?? current.recordDate,
      recordTime: input.recordTime === undefined ? current.recordTime : input.recordTime,
      mealType: input.mealType ?? current.mealType,
      sourceType: input.sourceType ?? current.sourceType,
      title: input.title === undefined ? current.title : normalizeTitle(input.title),
      status: input.status ?? current.status,
      // photos 显式提供时以 photos[0] 为准（清空则置 null）；省略时按 imagePath 原语义保留。
      imagePath:
        photoWrite.mode === 'keep'
          ? input.imagePath === undefined
            ? current.imagePath
            : input.imagePath
          : photoWrite.mode === 'write'
            ? photoWrite.imagePath
            : null,
      photos: input.photos,
      rating: input.rating === undefined ? current.rating : input.rating,
      satiety: input.satiety === undefined ? current.satiety : input.satiety,
      calories: input.calories === undefined ? current.calories : input.calories,
      cost: input.cost === undefined ? current.cost : input.cost,
      isNewTry: input.isNewTry ?? current.isNewTry,
      favorite: input.favorite ?? current.favorite,
      notes: input.notes === undefined ? current.notes : input.notes,
      relatedPlanId: input.relatedPlanId === undefined ? current.relatedPlanId : input.relatedPlanId,
      items: input.items
    };
    validate(merged);
    if (current.status === 'CONFIRMED' && input.status === 'DRAFT') throw httpError(409, '已确认记录不能退回草稿');
    if (input.items) await tx.mealRecordItem.deleteMany({ where: { mealRecordId: id } });
    if (input.dinerIds) await tx.mealRecordDiner.deleteMany({ where: { mealRecordId: id } });
    await tx.mealRecord.update({
      where: { id },
      data: {
        recordDate: merged.recordDate,
        recordTime: merged.recordTime,
        mealType: merged.mealType,
        sourceType: merged.sourceType,
        title: merged.title,
        status: merged.status,
        confirmedAt: current.status === 'DRAFT' && merged.status === 'CONFIRMED' ? new Date() : current.confirmedAt,
        imagePath: merged.imagePath,
        // 省略 photos → 保留旧 photosJson；显式 null/[] → 清空；非空 → 覆盖 canonical JSON。
        ...(photoWrite.mode === 'keep'
          ? {}
          : { photosJson: photoWrite.mode === 'write' ? photoWrite.photosJson : null }),
        rating: merged.rating,
        satiety: merged.satiety,
        calories: merged.calories,
        cost: merged.cost,
        isNewTry: merged.isNewTry,
        favorite: merged.favorite,
        notes: merged.notes,
        relatedPlanId: merged.relatedPlanId,
        version: { increment: 1 },
        ...(input.items ? { items: { create: itemCreates(input.items) } } : {}),
        ...(input.dinerIds ? { diners: { create: [...new Set(input.dinerIds)].map((dinerId) => ({ dinerId })) } } : {})
      }
    });
    const row = await tx.mealRecord.findUniqueOrThrow({ where: { id }, include: recordInclude });
    return recordDtoWithPhotos(row);
  });
}

export async function confirmRecord(database: PrismaClient, id: string, version: number) {
  const current = await getRecord(database, id);
  if (current.status === 'CONFIRMED') return current;
  return updateRecord(database, id, version, { status: 'CONFIRMED' });
}

export async function deleteRecord(database: PrismaClient, id: string, version: number) {
  return database.$transaction(async (tx) => {
    const current = await tx.mealRecord.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw httpError(404, '饮食记录不存在');
    if (current.version !== version)
      throw new VersionConflictError({
        entity: 'MealRecord',
        id,
        expectedVersion: version,
        actualVersion: current.version
      });
    const deletedAt = new Date();
    await tx.mealRecord.update({ where: { id }, data: { deletedAt, version: { increment: 1 } } });
    await recordDeletedItem(tx, 'MealRecord', id, deletedAt);
    // 记录删除后同步回退计划状态（E3）：否则计划仍 COMPLETED，首页继续显示「✓ 已打卡」，
    // 与今日记录/统计的「未记录」自相矛盾。仅回退仍活跃且仍为 COMPLETED 的来源计划。
    let revertedPlanId: string | null = null;
    if (current.sourceMealPlanId) {
      const plan = await tx.mealPlan.findFirst({
        where: { id: current.sourceMealPlanId, deletedAt: null },
        select: { id: true, status: true }
      });
      if (plan && plan.status === 'COMPLETED') {
        await tx.mealPlan.update({
          where: { id: plan.id },
          data: { status: 'PLANNED', completedAt: null, version: { increment: 1 } }
        });
        revertedPlanId = plan.id;
        // 用户明确删除记录后释放自动记录唯一关联，允许计划重新打卡。
        // 归档、relatedPlanId 与消费历史保留；此路径不复活或覆盖已删除记录。
        await tx.mealRecord.update({ where: { id }, data: { sourceMealPlanId: null } });
      }
    }
    return { id, revertedPlanId };
  });
}

export async function setRecordFavorite(database: PrismaClient, id: string, version: number, favorite: boolean) {
  const updated = await database.mealRecord.updateMany({
    where: { id, version, deletedAt: null },
    data: { favorite, version: { increment: 1 } }
  });
  if (!updated.count) {
    const current = await database.mealRecord.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw httpError(404, '饮食记录不存在');
    throw new VersionConflictError({
      entity: 'MealRecord',
      id,
      expectedVersion: version,
      actualVersion: current.version
    });
  }
  return getRecord(database, id);
}
