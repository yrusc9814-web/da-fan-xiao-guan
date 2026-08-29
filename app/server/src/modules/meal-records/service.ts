import type {
  MealRole,
  MealType,
  Prisma,
  PrismaClient,
  RecordItemType,
  RecordSourceType,
  RecordStatus
} from '@prisma/client';

import { VersionConflictError } from '../../database/optimistic-lock.js';
import { recordDeletedItem } from '../../database/deleted-items.js';
import { normalizePagination, toPaginationResponse } from '../../database/pagination.js';

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
  mealType: MealType;
  sourceType: RecordSourceType;
  status?: RecordStatus;
  imagePath?: string | null;
  rating?: number | null;
  isNewTry?: boolean;
  favorite?: boolean;
  notes?: string | null;
  relatedPlanId?: string | null;
  items?: RecordItemInput[];
  dinerIds?: string[];
}

const recordInclude = {
  items: { orderBy: { sortOrder: 'asc' as const }, include: { recipe: true, store: true } },
  diners: { include: { diner: true } }
};

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function validate(input: RecordInput): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.recordDate)) throw httpError(400, '记录日期必须使用 YYYY-MM-DD 格式');
  if (
    input.rating !== null &&
    input.rating !== undefined &&
    (!Number.isFinite(input.rating) || input.rating < 0 || input.rating > 5)
  )
    throw httpError(400, '评分必须在 0 到 5 之间');
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
  return toPaginationResponse(items, pagination.page, pagination.pageSize, total);
}

export async function getRecord(database: PrismaClient, id: string) {
  const record = await database.mealRecord.findFirst({ where: { id, deletedAt: null }, include: recordInclude });
  if (!record) throw httpError(404, '饮食记录不存在');
  return record;
}

export async function createRecord(database: PrismaClient, input: RecordInput) {
  validate(input);
  return database.mealRecord.create({
    data: {
      recordDate: input.recordDate,
      recordTime: input.recordTime ?? null,
      mealType: input.mealType,
      sourceType: input.sourceType,
      status: input.status ?? 'CONFIRMED',
      confirmedAt: (input.status ?? 'CONFIRMED') === 'CONFIRMED' ? new Date() : null,
      imagePath: input.imagePath ?? null,
      rating: input.rating ?? null,
      isNewTry: input.isNewTry ?? false,
      favorite: input.favorite ?? false,
      notes: input.notes ?? null,
      relatedPlanId: input.relatedPlanId ?? null,
      items: { create: itemCreates(input.items) },
      diners: { create: [...new Set(input.dinerIds ?? [])].map((dinerId) => ({ dinerId })) }
    },
    include: recordInclude
  });
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
    const merged: RecordInput = {
      recordDate: input.recordDate ?? current.recordDate,
      recordTime: input.recordTime === undefined ? current.recordTime : input.recordTime,
      mealType: input.mealType ?? current.mealType,
      sourceType: input.sourceType ?? current.sourceType,
      status: input.status ?? current.status,
      imagePath: input.imagePath === undefined ? current.imagePath : input.imagePath,
      rating: input.rating === undefined ? current.rating : input.rating,
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
        status: merged.status,
        confirmedAt: current.status === 'DRAFT' && merged.status === 'CONFIRMED' ? new Date() : current.confirmedAt,
        imagePath: merged.imagePath,
        rating: merged.rating,
        isNewTry: merged.isNewTry,
        favorite: merged.favorite,
        notes: merged.notes,
        relatedPlanId: merged.relatedPlanId,
        version: { increment: 1 },
        ...(input.items ? { items: { create: itemCreates(input.items) } } : {}),
        ...(input.dinerIds ? { diners: { create: [...new Set(input.dinerIds)].map((dinerId) => ({ dinerId })) } } : {})
      }
    });
    return tx.mealRecord.findUniqueOrThrow({ where: { id }, include: recordInclude });
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
    return { id };
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
