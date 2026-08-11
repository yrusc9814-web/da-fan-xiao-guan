import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import { createTool, deleteTool, getTool, listTools, updateTool, type ToolWriteInput } from './service.js';

export async function registerToolRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get<{ Querystring: { search?: string } }>('/api/v1/tools', async (request) => success(await listTools(database, request.query.search)));
  app.post<{ Body: ToolWriteInput }>('/api/v1/tools', async (request, reply) => reply.code(201).send(success(await createTool(database, request.body))));
  app.get<{ Params: { id: string } }>('/api/v1/tools/:id', async (request) => success(await getTool(database, request.params.id)));
  app.put<{ Params: { id: string }; Body: ToolWriteInput & { version: number } }>('/api/v1/tools/:id', async (request) => {
    const { version, ...input } = request.body;
    return success(await updateTool(database, request.params.id, version, input));
  });
  app.delete<{ Params: { id: string }; Querystring: { version: number } }>('/api/v1/tools/:id', async (request) => success(await deleteTool(database, request.params.id, Number(request.query.version))));
}
