import { Prisma, type PrismaClient } from '@prisma/client';

import { normalizePagination, toPaginationResponse } from '../../database/pagination.js';
import { VersionConflictError } from '../../database/optimistic-lock.js';

const NAME_LIMIT = 80;
const TEXT_LIMIT = 2_000;

export interface DinerWriteInput {
  name: string;
  avatarPath?: string | null;
  active?: boolean;
  likesText?: string | null;
  dislikesText?: string | null;
  tabooText?: string | null;
  allergyText?: string | null;
  portionNote?: string | null;
  notes?: string | null;
}

export type DinerUpdateInput = Partial<DinerWriteInput> & { version: number };

export interface DinerListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  active?: boolean;
  sortOrder?: 'asc' | 'desc';
}

export class DinerRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'DinerRequestError';
    this.statusCode = statusCode;
  }
}

function cleaned(value: string | null | undefined, field: string, limit = TEXT_LIMIT): string | null {
  if (value === null || value === undefined) return null;
  const result = value.trim();
  if (result.length > limit) throw new DinerRequestError(`${field}不能超过 ${limit} 个字符`);
  return result || null;
}

function dinerData(input: Partial<DinerWriteInput>, requireName: boolean): Prisma.DinerUpdateInput {
  const data: Prisma.DinerUpdateInput = {};
  if (requireName || input.name !== undefined) {
    const name = cleaned(input.name, '食用者姓名', NAME_LIMIT);
    if (!name) throw new DinerRequestError('食用者姓名不能为空');
    data.name = name;
  }
  for (const [key, label] of [
    ['avatarPath', '头像路径'],
    ['likesText', '喜好'],
    ['dislikesText', '不喜欢'],
    ['tabooText', '忌口'],
    ['allergyText', '过敏提示'],
    ['portionNote', '默认餐量'],
    ['notes', '备注']
  ] as const) {
    if (input[key] !== undefined) data[key] = cleaned(input[key], label);
  }
  if (input.active !== undefined) data.active = input.active;
  return data;
}

async function dinerOrThrow(database: PrismaClient | Prisma.TransactionClient, id: string) {
  const diner = await database.diner.findUnique({ where: { id } });
  if (!diner) throw new DinerRequestError('食用者不存在', 404);
  return diner;
}

export async function createDiner(database: PrismaClient, input: DinerWriteInput) {
  return database.diner.create({ data: dinerData(input, true) as Prisma.DinerCreateInput });
}

export async function listDiners(database: PrismaClient, query: DinerListQuery = {}) {
  const pagination = normalizePagination(query);
  const search = query.search?.trim();
  const where: Prisma.DinerWhereInput = {
    ...(query.active !== undefined ? { active: query.active } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search } },
            { likesText: { contains: search } },
            { dislikesText: { contains: search } },
            { tabooText: { contains: search } },
            { allergyText: { contains: search } }
          ]
        }
      : {})
  };
  const [items, total] = await Promise.all([
    database.diner.findMany({
      where,
      orderBy: { name: query.sortOrder ?? 'asc' },
      skip: pagination.skip,
      take: pagination.take
    }),
    database.diner.count({ where })
  ]);
  return toPaginationResponse(items, pagination.page, pagination.pageSize, total);
}

export async function getDiner(database: PrismaClient, id: string) {
  const diner = await dinerOrThrow(database, id);
  const [planCount, recordCount] = await Promise.all([
    database.mealPlanDiner.count({ where: { dinerId: id, mealPlan: { deletedAt: null } } }),
    database.mealRecordDiner.count({ where: { dinerId: id, mealRecord: { deletedAt: null } } })
  ]);
  return { ...diner, planCount, recordCount };
}

export async function updateDiner(database: PrismaClient, id: string, input: DinerUpdateInput) {
  if (!Number.isInteger(input.version) || input.version < 1) throw new DinerRequestError('版本号无效');
  const data = dinerData(input, false);
  const result = await database.diner.updateMany({
    where: { id, version: input.version },
    data: { ...data, version: { increment: 1 } }
  });
  if (result.count !== 1) {
    const current = await dinerOrThrow(database, id);
    throw new VersionConflictError({
      entity: 'Diner',
      id,
      expectedVersion: input.version,
      actualVersion: current.version
    });
  }
  return database.diner.findUniqueOrThrow({ where: { id } });
}

export async function deactivateDiner(database: PrismaClient, id: string, version: number) {
  if (!Number.isInteger(version) || version < 1) throw new DinerRequestError('版本号无效');
  return database.$transaction(async (transaction) => {
    const current = await dinerOrThrow(transaction, id);
    if (current.version !== version) {
      throw new VersionConflictError({ entity: 'Diner', id, expectedVersion: version, actualVersion: current.version });
    }
    const result = await transaction.diner.updateMany({
      where: { id, version },
      data: { active: false, version: { increment: 1 } }
    });
    if (result.count !== 1) {
      const latest = await dinerOrThrow(transaction, id);
      throw new VersionConflictError({ entity: 'Diner', id, expectedVersion: version, actualVersion: latest.version });
    }
    return transaction.diner.findUniqueOrThrow({ where: { id } });
  });
}
