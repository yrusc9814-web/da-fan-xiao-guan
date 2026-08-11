import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { success } from '../../shared/http.js';
import {
  confirmRecord,
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  setRecordFavorite,
  updateRecord,
  type RecordInput
} from './service.js';

export async function registerMealRecordRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get('/api/v1/records', async (request) =>
    success(await listRecords(database, request.query as Parameters<typeof listRecords>[1]))
  );
  app.post('/api/v1/records', async (request, reply) =>
    reply.code(201).send(success(await createRecord(database, request.body as RecordInput)))
  );
  app.get('/api/v1/records/:id', async (request) =>
    success(await getRecord(database, (request.params as { id: string }).id))
  );
  app.put('/api/v1/records/:id', async (request) => {
    const { version, ...input } = request.body as Partial<RecordInput> & { version: number };
    return success(await updateRecord(database, (request.params as { id: string }).id, version, input));
  });
  app.delete('/api/v1/records/:id', async (request) =>
    success(
      await deleteRecord(
        database,
        (request.params as { id: string }).id,
        Number((request.query as { version: string }).version)
      )
    )
  );
  app.post('/api/v1/records/:id/confirm', async (request) =>
    success(
      await confirmRecord(
        database,
        (request.params as { id: string }).id,
        (request.body as { version: number }).version
      )
    )
  );
  app.post('/api/v1/records/:id/favorite', async (request) => {
    const body = request.body as { version: number; favorite: boolean };
    return success(
      await setRecordFavorite(database, (request.params as { id: string }).id, body.version, body.favorite)
    );
  });
}
