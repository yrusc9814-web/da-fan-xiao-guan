import type { FastifyInstance } from 'fastify';
import type { PrismaClient, ShoppingListStatus } from '@prisma/client';

import { success } from '../../shared/http.js';
import {
  addShoppingItem,
  clearCompleted,
  createShoppingList,
  deleteShoppingItem,
  deleteShoppingList,
  generateShoppingList,
  getShoppingList,
  listShoppingLists,
  updateShoppingItem,
  updateShoppingList,
  type ShoppingItemInput,
  type ShoppingListInput
} from './service.js';

export async function registerShoppingRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get('/api/v1/shopping-lists', async (request) =>
    success(await listShoppingLists(database, (request.query as { status?: ShoppingListStatus }).status))
  );
  app.post('/api/v1/shopping-lists', async (request, reply) =>
    reply.code(201).send(success(await createShoppingList(database, request.body as ShoppingListInput)))
  );
  app.get('/api/v1/shopping-lists/:id', async (request) =>
    success(await getShoppingList(database, (request.params as { id: string }).id))
  );
  app.put('/api/v1/shopping-lists/:id', async (request) => {
    const { version, ...input } = request.body as Partial<ShoppingListInput> & { version: number };
    return success(await updateShoppingList(database, (request.params as { id: string }).id, version, input));
  });
  app.delete('/api/v1/shopping-lists/:id', async (request) =>
    success(
      await deleteShoppingList(
        database,
        (request.params as { id: string }).id,
        Number((request.query as { version: string }).version)
      )
    )
  );
  app.post('/api/v1/shopping-lists/:id/items', async (request) => {
    const { version, ...item } = request.body as ShoppingItemInput & { version: number };
    return success(await addShoppingItem(database, (request.params as { id: string }).id, version, item));
  });
  app.put('/api/v1/shopping-list-items/:id', async (request) => {
    const { version, ...input } = request.body as Partial<ShoppingItemInput> & { version: number };
    return success(await updateShoppingItem(database, (request.params as { id: string }).id, version, input));
  });
  app.delete('/api/v1/shopping-list-items/:id', async (request) =>
    success(
      await deleteShoppingItem(
        database,
        (request.params as { id: string }).id,
        Number((request.query as { version: string }).version)
      )
    )
  );
  app.post('/api/v1/shopping-lists/:id/clear-completed', async (request) =>
    success(
      await clearCompleted(
        database,
        (request.params as { id: string }).id,
        (request.body as { version: number }).version
      )
    )
  );
  app.post('/api/v1/shopping-lists/generate', async (request) =>
    success(await generateShoppingList(database, request.body as Parameters<typeof generateShoppingList>[1]))
  );
}
