import type { PrismaClient } from '@prisma/client';

import { VersionConflictError } from '../../database/optimistic-lock.js';
import { recordDeletedItem } from '../../database/deleted-items.js';

export interface ToolWriteInput {
  name: string;
  imagePath?: string | null;
  /** 设备图标（前端 #formToolIcon select 的 emoji 原文）；null 表示未填写，绝不以 🍲 等默认值冒充。 */
  icon?: string | null;
  category?: string | null;
  quantity?: number;
  status?: string | null;
  notes?: string | null;
}

/** 图标长度上限（与冻结 UI select 的 emoji 原文容量对应；超限快速失败而非静默截断）。 */
const TOOL_ICON_LIMIT = 20;

/**
 * 图标入参：null/undefined/空串 → null（未填写）；非字符串或超限 → 400。
 * 注意：mapTool 类读取侧不得回退 imagePath/🍲 —— 只返回真实存下的 icon。
 */
function cleanedIcon(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw Object.assign(new Error('设备图标必须是字符串'), { statusCode: 400 });
  const cleaned = value.trim();
  if (cleaned.length > TOOL_ICON_LIMIT)
    throw Object.assign(new Error(`设备图标不能超过 ${TOOL_ICON_LIMIT} 个字符`), { statusCode: 400 });
  return cleaned || null;
}

function validate(input: ToolWriteInput): void {
  if (!input.name?.trim()) throw Object.assign(new Error('工具名称不能为空'), { statusCode: 400 });
  if (input.quantity != null && (!Number.isInteger(input.quantity) || input.quantity < 0)) {
    throw Object.assign(new Error('工具数量必须是非负整数'), { statusCode: 400 });
  }
  cleanedIcon(input.icon);
}

export async function listTools(database: PrismaClient, search?: string) {
  return database.kitchenTool.findMany({
    where: { deletedAt: null, ...(search?.trim() ? { name: { contains: search.trim() } } : {}) },
    orderBy: { updatedAt: 'desc' }
  });
}

export async function getTool(database: PrismaClient, id: string) {
  const tool = await database.kitchenTool.findFirst({ where: { id, deletedAt: null } });
  if (!tool) throw Object.assign(new Error('厨房工具不存在'), { statusCode: 404 });
  return tool;
}

export async function createTool(database: PrismaClient, input: ToolWriteInput) {
  validate(input);
  return database.kitchenTool.create({
    data: {
      name: input.name.trim(),
      imagePath: input.imagePath ?? null,
      icon: cleanedIcon(input.icon),
      category: input.category ?? null,
      quantity: input.quantity ?? 1,
      status: input.status ?? null,
      notes: input.notes ?? null
    }
  });
}

export async function updateTool(database: PrismaClient, id: string, version: number, input: ToolWriteInput) {
  if (!Number.isInteger(version) || version < 1)
    throw Object.assign(new Error('version 必须是正整数'), { statusCode: 400 });
  validate(input);
  const result = await database.kitchenTool.updateMany({
    where: { id, version, deletedAt: null },
    data: {
      name: input.name.trim(),
      imagePath: input.imagePath ?? null,
      // 省略 icon → 保留库内旧值（不得把用户已选图标静默清空/造假）；显式 null/空串 → 清空。
      icon: input.icon === undefined ? undefined : cleanedIcon(input.icon),
      category: input.category ?? null,
      quantity: input.quantity ?? 1,
      status: input.status ?? null,
      notes: input.notes ?? null,
      version: { increment: 1 }
    }
  });
  if (!result.count) {
    const current = await database.kitchenTool.findUnique({
      where: { id },
      select: { version: true, deletedAt: true }
    });
    if (!current || current.deletedAt) throw Object.assign(new Error('厨房工具不存在'), { statusCode: 404 });
    throw new VersionConflictError({
      entity: 'KitchenTool',
      id,
      expectedVersion: version,
      actualVersion: current.version
    });
  }
  return getTool(database, id);
}

export async function deleteTool(database: PrismaClient, id: string, version: number) {
  if (!Number.isInteger(version) || version < 1)
    throw Object.assign(new Error('version 必须是正整数'), { statusCode: 400 });
  return database.$transaction(async (transaction) => {
    const deletedAt = new Date();
    const result = await transaction.kitchenTool.updateMany({
      where: { id, version, deletedAt: null },
      data: { deletedAt, version: { increment: 1 } }
    });
    if (!result.count) {
      const current = await transaction.kitchenTool.findUnique({
        where: { id },
        select: { version: true, deletedAt: true }
      });
      if (!current || current.deletedAt) throw Object.assign(new Error('厨房工具不存在'), { statusCode: 404 });
      throw new VersionConflictError({
        entity: 'KitchenTool',
        id,
        expectedVersion: version,
        actualVersion: current.version
      });
    }
    await recordDeletedItem(transaction, 'KitchenTool', id, deletedAt);
    return { id, deleted: true };
  });
}
