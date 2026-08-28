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

const versionQueryWrapper = { type: 'object', required: ['version'], properties: { version: versionQuerySchema } };

export async function registerToolRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get<{ Querystring: { search?: string } }>('/api/v1/tools', async (request) =>
    success(await listTools(database, request.query.search))
  );
  app.post<{ Body: ToolWriteInput }>('/api/v1/tools', { schema: { body: toolBodySchema } }, async (request, reply) =>
    reply.code(201).send(success(await createTool(database, request.body)))
  );
  app.get<{ Params: { id: string } }>('/api/v1/tools/:id', async (request) =>
    success(await getTool(database, request.params.id))
  );
  app.put<{ Params: { id: string }; Body: ToolWriteInput & { version: number } }>(
    '/api/v1/tools/:id',
    { schema: { body: toolUpdateBodySchema } },
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
