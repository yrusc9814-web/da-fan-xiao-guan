import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { success } from '../../shared/http.js';
import {
  createDiner,
  deactivateDiner,
  DinerRequestError,
  getDiner,
  listDiners,
  updateDiner,
  type DinerUpdateInput,
  type DinerWriteInput
} from './service.js';

type Params = { id: string };
type RawQuery = Record<string, string | undefined>;

function numberValue(value: string | undefined, field: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new DinerRequestError(`${field}必须是数字`);
  return parsed;
}

function booleanValue(value: string | undefined, field: string): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new DinerRequestError(`${field}必须是 true 或 false`);
}

export async function registerDinerRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get<{ Querystring: RawQuery }>('/api/v1/diners', async (request) => {
    if (
      request.query.sortOrder !== undefined &&
      request.query.sortOrder !== 'asc' &&
      request.query.sortOrder !== 'desc'
    ) {
      throw new DinerRequestError('排序方向无效');
    }
    return success(
      await listDiners(database, {
        page: numberValue(request.query.page, '页码'),
        pageSize: numberValue(request.query.pageSize, '每页数量'),
        search: request.query.search,
        active: booleanValue(request.query.active, '启用状态'),
        sortOrder: request.query.sortOrder as 'asc' | 'desc' | undefined
      })
    );
  });
  app.post<{ Body: DinerWriteInput }>('/api/v1/diners', async (request, reply) =>
    reply.code(201).send(success(await createDiner(database, request.body)))
  );
  app.get<{ Params: Params }>('/api/v1/diners/:id', async (request) =>
    success(await getDiner(database, request.params.id))
  );
  app.put<{ Params: Params; Body: DinerUpdateInput }>('/api/v1/diners/:id', async (request) =>
    success(await updateDiner(database, request.params.id, request.body))
  );
  app.delete<{ Params: Params; Body: { version: number } }>('/api/v1/diners/:id', async (request) =>
    success(await deactivateDiner(database, request.params.id, request.body?.version))
  );
}
