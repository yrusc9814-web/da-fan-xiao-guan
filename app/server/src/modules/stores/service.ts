import { MealType, Prisma, type PrismaClient } from '@prisma/client';

import { normalizePagination, toPaginationResponse } from '../../database/pagination.js';
import { VersionConflictError } from '../../database/optimistic-lock.js';

const STORE_TEXT_LIMIT = 2_000;
const STORE_NAME_LIMIT = 120;
const RECENT_DAYS_DEFAULT = 30;

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export type StoreAcquisitionMode = 'DINE_IN' | 'TAKEOUT';
export type StoreSortBy = 'name' | 'averageCost' | 'rating' | 'createdAt' | 'updatedAt' | 'lastEaten';

export interface StoreWriteInput {
  name: string;
  imagePath?: string | null;
  address?: string | null;
  storeType?: string | null;
  cuisine?: string | null;
  averageCost?: number | null;
  supportsDineIn?: boolean;
  supportsTakeout?: boolean;
  contact?: string | null;
  businessHours?: string | null;
  rating?: number | null;
  recommendedDishes?: string | null;
  avoidDishes?: string | null;
  tagsText?: string | null;
  notes?: string | null;
  favorite?: boolean;
  mealTypes?: MealType[];
}

export type StoreUpdateInput = Partial<StoreWriteInput> & { version: number };

export interface StoreListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  mode?: StoreAcquisitionMode;
  storeType?: string;
  cuisine?: string;
  minAverageCost?: number;
  maxAverageCost?: number;
  minRating?: number;
  tags?: string[];
  recentlyEaten?: boolean;
  recentDays?: number;
  favorite?: boolean;
  mealTypes?: MealType[];
  sortBy?: StoreSortBy;
  sortOrder?: 'asc' | 'desc';
}

export interface StoreCandidateQuery {
  acquisitionModes?: StoreAcquisitionMode[];
  mealTypes?: MealType[];
  wantedKeywords?: string[];
  unwantedKeywords?: string[];
  dinerIds?: string[];
  repeatDays?: number;
  favoriteOnly?: boolean;
}

export class StoreRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'StoreRequestError';
    this.statusCode = statusCode;
  }
}

function cleanedText(value: string | null | undefined, field: string, limit = STORE_TEXT_LIMIT): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.trim();
  if (cleaned.length > limit) throw new StoreRequestError(`${field}不能超过 ${limit} 个字符`);
  return cleaned || null;
}

function validateMealTypes(mealTypes: MealType[] | undefined): MealType[] {
  if (!mealTypes) return [];
  const valid = new Set(Object.values(MealType));
  const unique = [...new Set(mealTypes)];
  if (unique.some((mealType) => !valid.has(mealType))) {
    throw new StoreRequestError('餐次类型无效');
  }
  return unique;
}

function validatedStoreData(input: Partial<StoreWriteInput>, requireName: boolean): Prisma.StoreUpdateInput {
  const data: Prisma.StoreUpdateInput = {};
  if (requireName || input.name !== undefined) {
    const name = cleanedText(input.name, '店名', STORE_NAME_LIMIT);
    if (!name) throw new StoreRequestError('店名不能为空');
    data.name = name;
  }
  const textFields = [
    ['imagePath', '图片路径'],
    ['address', '地址'],
    ['storeType', '店铺类型'],
    ['cuisine', '菜系'],
    ['contact', '联系方式'],
    ['businessHours', '营业时间'],
    ['recommendedDishes', '推荐菜品'],
    ['avoidDishes', '不推荐菜品'],
    ['tagsText', '标签'],
    ['notes', '备注']
  ] as const;
  for (const [key, label] of textFields) {
    if (input[key] !== undefined) data[key] = cleanedText(input[key], label);
  }
  if (input.averageCost !== undefined) {
    if (input.averageCost !== null && (!Number.isFinite(input.averageCost) || input.averageCost < 0)) {
      throw new StoreRequestError('人均消费不能为负数');
    }
    data.averageCost = input.averageCost;
  }
  if (input.rating !== undefined) {
    if (input.rating !== null && (!Number.isFinite(input.rating) || input.rating < 0 || input.rating > 5)) {
      throw new StoreRequestError('评分必须在 0 到 5 之间');
    }
    data.rating = input.rating;
  }
  for (const key of ['supportsDineIn', 'supportsTakeout', 'favorite'] as const) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  return data;
}

function startBusinessDate(days: number): string {
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new StoreRequestError('最近天数必须是 1 到 3650 的整数');
  }
  const date = new Date();
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function activeRecordWhere(since?: string): Prisma.MealRecordItemWhereInput {
  return {
    mealRecord: {
      deletedAt: null,
      status: 'CONFIRMED',
      ...(since ? { recordDate: { gte: since } } : {})
    }
  };
}

function baseStoreWhere(query: StoreListQuery): Prisma.StoreWhereInput {
  if (query.minAverageCost !== undefined && query.minAverageCost < 0)
    throw new StoreRequestError('最低人均消费不能为负数');
  if (query.maxAverageCost !== undefined && query.maxAverageCost < 0)
    throw new StoreRequestError('最高人均消费不能为负数');
  if (
    query.minAverageCost !== undefined &&
    query.maxAverageCost !== undefined &&
    query.minAverageCost > query.maxAverageCost
  ) {
    throw new StoreRequestError('最低人均消费不能高于最高人均消费');
  }
  if (query.minRating !== undefined && (query.minRating < 0 || query.minRating > 5)) {
    throw new StoreRequestError('最低评分必须在 0 到 5 之间');
  }
  const search = query.search?.trim();
  const tags = query.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [];
  const mealTypes = validateMealTypes(query.mealTypes);
  const where: Prisma.StoreWhereInput = {
    deletedAt: null,
    ...(query.mode === 'DINE_IN' ? { supportsDineIn: true } : {}),
    ...(query.mode === 'TAKEOUT' ? { supportsTakeout: true } : {}),
    ...(query.storeType ? { storeType: { contains: query.storeType.trim() } } : {}),
    ...(query.cuisine ? { cuisine: { contains: query.cuisine.trim() } } : {}),
    ...(query.favorite !== undefined ? { favorite: query.favorite } : {}),
    ...(query.minAverageCost !== undefined || query.maxAverageCost !== undefined
      ? {
          averageCost: { gte: query.minAverageCost, lte: query.maxAverageCost }
        }
      : {}),
    ...(query.minRating !== undefined ? { rating: { gte: query.minRating } } : {}),
    ...(mealTypes.length ? { mealTypes: { some: { mealType: { in: mealTypes } } } } : {}),
    ...(tags.length ? { AND: tags.map((tag) => ({ tagsText: { contains: tag } })) } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search } },
            { storeType: { contains: search } },
            { cuisine: { contains: search } },
            { recommendedDishes: { contains: search } },
            { avoidDishes: { contains: search } },
            { tagsText: { contains: search } }
          ]
        }
      : {})
  };
  if (query.recentlyEaten !== undefined) {
    const relation = activeRecordWhere(startBusinessDate(query.recentDays ?? RECENT_DAYS_DEFAULT));
    where.recordItems = query.recentlyEaten ? { some: relation } : { none: relation };
  }
  return where;
}

const storeInclude = {
  mealTypes: { orderBy: { mealType: 'asc' as const } },
  recordItems: {
    where: activeRecordWhere(),
    select: { mealRecord: { select: { id: true, recordDate: true } } }
  }
} satisfies Prisma.StoreInclude;

function mapStore<
  T extends {
    mealTypes: Array<{ mealType: MealType }>;
    recordItems: Array<{ mealRecord: { id: string; recordDate: string } }>;
  }
>(store: T) {
  const recordDates = store.recordItems
    .map((item) => item.mealRecord.recordDate)
    .sort()
    .reverse();
  const recordIds = new Set(store.recordItems.map((item) => item.mealRecord.id));
  const { recordItems: _recordItems, ...rest } = store;
  return {
    ...rest,
    mealTypes: store.mealTypes.map(({ mealType }) => mealType),
    lastEatenDate: recordDates[0] ?? null,
    historyCount: recordIds.size
  };
}

async function activeStoreOrThrow(database: DatabaseClient, id: string) {
  const store = await database.store.findFirst({ where: { id, deletedAt: null } });
  if (!store) throw new StoreRequestError('店铺不存在', 404);
  return store;
}

export async function createStore(database: PrismaClient, input: StoreWriteInput) {
  const mealTypes = validateMealTypes(input.mealTypes);
  const data = validatedStoreData(input, true) as Prisma.StoreCreateInput;
  return database.$transaction(async (transaction) => {
    const store = await transaction.store.create({
      data: {
        ...data,
        ...(mealTypes.length ? { mealTypes: { create: mealTypes.map((mealType) => ({ mealType })) } } : {})
      },
      include: storeInclude
    });
    return mapStore(store);
  });
}

export async function listStores(database: PrismaClient, query: StoreListQuery = {}) {
  const pagination = normalizePagination(query);
  const where = baseStoreWhere(query);
  const sortBy = query.sortBy ?? 'updatedAt';
  const sortOrder = query.sortOrder ?? 'desc';
  const orderBy =
    sortBy === 'lastEaten'
      ? { updatedAt: sortOrder }
      : ({ [sortBy]: sortOrder } as Prisma.StoreOrderByWithRelationInput);
  if (sortBy === 'lastEaten') {
    const stores = await database.store.findMany({ where, include: storeInclude });
    const mapped = stores.map(mapStore).sort((a, b) => {
      const comparison = (a.lastEatenDate ?? '').localeCompare(b.lastEatenDate ?? '');
      return sortOrder === 'asc' ? comparison : -comparison;
    });
    return toPaginationResponse(
      mapped.slice(pagination.skip, pagination.skip + pagination.take),
      pagination.page,
      pagination.pageSize,
      mapped.length
    );
  }
  const [stores, total] = await Promise.all([
    database.store.findMany({ where, orderBy, skip: pagination.skip, take: pagination.take, include: storeInclude }),
    database.store.count({ where })
  ]);
  const mapped = stores.map(mapStore);
  return toPaginationResponse(mapped, pagination.page, pagination.pageSize, total);
}

export async function getStore(database: PrismaClient, id: string) {
  const store = await database.store.findFirst({ where: { id, deletedAt: null }, include: storeInclude });
  if (!store) throw new StoreRequestError('店铺不存在', 404);
  const relatedRecords = await database.mealRecord.findMany({
    where: { deletedAt: null, status: 'CONFIRMED', items: { some: { storeId: id } } },
    orderBy: [{ recordDate: 'desc' }, { recordTime: 'desc' }],
    select: {
      id: true,
      recordDate: true,
      recordTime: true,
      mealType: true,
      sourceType: true,
      rating: true,
      notes: true
    }
  });
  return { ...mapStore(store), relatedRecords };
}

export async function updateStore(database: PrismaClient, id: string, input: StoreUpdateInput) {
  if (!Number.isInteger(input.version) || input.version < 1) throw new StoreRequestError('版本号无效');
  const mealTypes = input.mealTypes === undefined ? undefined : validateMealTypes(input.mealTypes);
  const data = validatedStoreData(input, false);
  return database.$transaction(async (transaction) => {
    const current = await activeStoreOrThrow(transaction, id);
    if (current.version !== input.version) {
      throw new VersionConflictError({
        entity: 'Store',
        id,
        expectedVersion: input.version,
        actualVersion: current.version
      });
    }
    const result = await transaction.store.updateMany({
      where: { id, deletedAt: null, version: input.version },
      data: { ...data, version: { increment: 1 } }
    });
    if (result.count !== 1) {
      const latest = await activeStoreOrThrow(transaction, id);
      throw new VersionConflictError({
        entity: 'Store',
        id,
        expectedVersion: input.version,
        actualVersion: latest.version
      });
    }
    if (mealTypes !== undefined) {
      await transaction.storeMealType.deleteMany({ where: { storeId: id } });
      if (mealTypes.length)
        await transaction.storeMealType.createMany({ data: mealTypes.map((mealType) => ({ storeId: id, mealType })) });
    }
    const updated = await transaction.store.findUniqueOrThrow({ where: { id }, include: storeInclude });
    return mapStore(updated);
  });
}

export async function setStoreFavorite(database: PrismaClient, id: string, favorite: boolean, version: number) {
  if (typeof favorite !== 'boolean') throw new StoreRequestError('收藏状态必须是布尔值');
  return updateStore(database, id, { favorite, version });
}

export async function deleteStore(database: PrismaClient, id: string, version: number) {
  if (!Number.isInteger(version) || version < 1) throw new StoreRequestError('版本号无效');
  return database.$transaction(async (transaction) => {
    const current = await activeStoreOrThrow(transaction, id);
    if (current.version !== version) {
      throw new VersionConflictError({ entity: 'Store', id, expectedVersion: version, actualVersion: current.version });
    }
    const deletedAt = new Date();
    const expiresAt = new Date(deletedAt);
    expiresAt.setDate(expiresAt.getDate() + 30);
    const result = await transaction.store.updateMany({
      where: { id, deletedAt: null, version },
      data: { deletedAt, version: { increment: 1 } }
    });
    if (result.count !== 1) {
      const latest = await activeStoreOrThrow(transaction, id);
      throw new VersionConflictError({ entity: 'Store', id, expectedVersion: version, actualVersion: latest.version });
    }
    await transaction.deletedItem.create({ data: { entityType: 'Store', entityId: id, deletedAt, expiresAt } });
    return { id, deletedAt: deletedAt.toISOString(), version: version + 1 };
  });
}

function keywordList(values: Array<string | null | undefined>): string {
  return values
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase('zh-CN');
}

export async function listStoreCandidates(database: PrismaClient, query: StoreCandidateQuery = {}) {
  const mealTypes = validateMealTypes(query.mealTypes);
  const acquisitionModes = [...new Set(query.acquisitionModes ?? [])];
  if (acquisitionModes.some((mode) => mode !== 'DINE_IN' && mode !== 'TAKEOUT'))
    throw new StoreRequestError('获取方式无效');
  if (query.repeatDays !== undefined && (!Number.isInteger(query.repeatDays) || query.repeatDays < 0)) {
    throw new StoreRequestError('不重复天数必须是非负整数');
  }
  const repeatSince = query.repeatDays && query.repeatDays > 0 ? startBusinessDate(query.repeatDays) : undefined;
  const diners = query.dinerIds?.length
    ? await database.diner.findMany({ where: { id: { in: query.dinerIds }, active: true } })
    : [];
  const dinerBlocked = diners
    .flatMap((diner) => [diner.dislikesText, diner.tabooText, diner.allergyText])
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(/[,，;；\n]/))
    .map((value) => value.trim().toLocaleLowerCase('zh-CN'))
    .filter(Boolean);
  const blocked = [...(query.unwantedKeywords ?? []), ...dinerBlocked]
    .map((value) => value.trim().toLocaleLowerCase('zh-CN'))
    .filter(Boolean);
  const wanted = (query.wantedKeywords ?? []).map((value) => value.trim().toLocaleLowerCase('zh-CN')).filter(Boolean);
  const where: Prisma.StoreWhereInput = {
    deletedAt: null,
    ...(query.favoriteOnly ? { favorite: true } : {}),
    ...(mealTypes.length ? { mealTypes: { some: { mealType: { in: mealTypes } } } } : {}),
    ...(acquisitionModes.length
      ? {
          OR: acquisitionModes.map((mode) =>
            mode === 'DINE_IN' ? { supportsDineIn: true } : { supportsTakeout: true }
          )
        }
      : {}),
    ...(repeatSince ? { recordItems: { none: activeRecordWhere(repeatSince) } } : {})
  };
  const stores = await database.store.findMany({ where, include: storeInclude });
  return stores
    .map(mapStore)
    .flatMap((store) => {
      const haystack = keywordList([
        store.name,
        store.storeType,
        store.cuisine,
        store.recommendedDishes,
        store.tagsText
      ]);
      if (blocked.some((keyword) => haystack.includes(keyword))) return [];
      const matchedWantedKeywords = wanted.filter((keyword) => haystack.includes(keyword));
      let score = (store.rating ?? 0) * 4;
      const reasons: string[] = [];
      if (store.favorite) {
        score += 20;
        reasons.push('已收藏');
      }
      if (matchedWantedKeywords.length) {
        score += matchedWantedKeywords.length * 15;
        reasons.push('命中想吃关键词');
      }
      if (!store.lastEatenDate) {
        score += 10;
        reasons.push('还没吃过');
      } else reasons.push(`最近食用 ${store.lastEatenDate}`);
      if (store.rating !== null) reasons.push(`个人评分 ${store.rating}`);
      return [{ ...store, score, matchedWantedKeywords, reasons }];
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN'));
}
