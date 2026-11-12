import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import {
  nullableStringSchema,
  stringSchema,
  versionBodySchema,
  versionQuerySchema
} from '../../shared/validation-schemas.js';
import { createTool, deleteTool, getTool, listTools, updateTool, type ToolWriteInput } from './service.js';

const toolBodySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: stringSchema,
    imagePath: nullableStringSchema,
    // icon：前端 #formToolIcon select 的 emoji 原文；nullable，空串按未填写处理（service 归一 null），
    // 限长 20 字符。绝不写入/读取 🍲 等默认值冒充。
    icon: { type: ['string', 'null'], maxLength: 20 },
    category: nullableStringSchema,
    quantity: { type: ['integer', 'null'], minimum: 0 },
    status: nullableStringSchema,
    notes: nullableStringSchema
  }
};

const toolUpdateBodySchema = {
  type: 'object',
  required: ['name', 'version'],
  properties: { ...toolBodySchema.properties, version: versionBodySchema }
};

/**
 * 工具写入 body 的允许字段。Fastify 默认 AJV 会静默剥离未知字段（removeAdditional），
 * 与“未知字段 fail-closed 快速失败”的契约冲突；preValidation 在 AJV 之前执行，
 * 可看到原始解析后的 body（与 ingredients / recipes / meal-plans 同一既有模式）。
 * POST 不接受 version（version 是乐观锁 PUT 专用字段），出现即 400。
 */
const toolCreateAllowedKeys: readonly string[] = [
  'name',
  'imagePath',
  'icon',
  'category',
  'quantity',
  'status',
  'notes'
];
const toolUpdateAllowedKeys: readonly string[] = [...toolCreateAllowedKeys, 'version'];

function assertToolKeys(allowed: readonly string[]): (body: unknown) => void {
  return (body: unknown) => {
    if (!body || typeof body !== 'object') return;
    const unknown = Object.keys(body as Record<string, unknown>).filter((key) => !allowed.includes(key));
    if (unknown.length) {
      throw Object.assign(new Error(`请求包含未支持的字段：${unknown.join(', ')}`), { statusCode: 400 });
    }
  };
}

const versionQueryWrapper = { type: 'object', required: ['version'], properties: { version: versionQuerySchema } };

export async function registerToolRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get<{ Querystring: { search?: string } }>('/api/v1/tools', async (request) =>
    success(await listTools(database, request.query.search))
  );
  app.post<{ Body: ToolWriteInput }>(
    '/api/v1/tools',
    {
      schema: { body: toolBodySchema },
      preValidation: async (request) => assertToolKeys(toolCreateAllowedKeys)(request.body)
    },
    async (request, reply) => reply.code(201).send(success(await createTool(database, request.body)))
  );
  app.get<{ Params: { id: string } }>('/api/v1/tools/:id', async (request) =>
    success(await getTool(database, request.params.id))
  );
  app.put<{ Params: { id: string }; Body: ToolWriteInput & { version: number } }>(
    '/api/v1/tools/:id',
    {
      schema: { body: toolUpdateBodySchema },
      preValidation: async (request) => assertToolKeys(toolUpdateAllowedKeys)(request.body)
    },
    async (request) => {
      const { version, ...input } = request.body;
      return success(await updateTool(database, request.params.id, version, input));
    }
  );
  app.delete<{ Params: { id: string }; Querystring: { version: number } }>(
    '/api/v1/tools/:id',
    { schema: { querystring: versionQueryWrapper } },
    async (request) => success(await deleteTool(database, request.params.id, Number(request.query.version)))
  );
}
