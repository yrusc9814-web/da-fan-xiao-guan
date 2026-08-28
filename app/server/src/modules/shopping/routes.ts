import type { FastifyInstance } from 'fastify';
import type { PrismaClient, ShoppingListStatus } from '@prisma/client';

import { success } from '../../shared/http.js';
import {
  booleanSchema,
  nullableStringSchema,
  quantityUnitSchema,
  shoppingListStatusSchema,
  shoppingSourceTypeSchema,
  stringSchema,
  versionBodySchema,
  versionQuerySchema
} from '../../shared/validation-schemas.js';
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

const shoppingItemProperties = {
  ingredientId: { type: ['string', 'null'] },
  ingredientName: stringSchema,
  quantity: { type: 'number' },
  unit: quantityUnitSchema,
  sourceType: shoppingSourceTypeSchema,
  sourceId: { type: ['string', 'null'] },
  completed: booleanSchema,
  sortOrder: { type: 'integer' },
  notes: nullableStringSchema
};

const shoppingItemSchema = {
  type: 'object',
  required: ['ingredientName', 'quantity', 'unit'],
  properties: shoppingItemProperties
};

const shoppingListBodySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: stringSchema,
    status: shoppingListStatusSchema,
    notes: nullableStringSchema,
    items: { type: 'array', items: shoppingItemSchema }
  }
};

const shoppingListUpdateBodySchema = {
  type: 'object',
  required: ['version'],
  properties: {
    name: stringSchema,
    status: shoppingListStatusSchema,
    notes: nullableStringSchema,
    version: versionBodySchema
  }
};

const shoppingItemAddBodySchema = {
  type: 'object',
  required: ['version', 'ingredientName', 'quantity', 'unit'],
  properties: { ...shoppingItemProperties, version: versionBodySchema }
};

const shoppingItemUpdateBodySchema = {
  type: 'object',
  required: ['version'],
  properties: { ...shoppingItemProperties, version: versionBodySchema }
};

const versionBodyWrapper = { type: 'object', required: ['version'], properties: { version: versionBodySchema } };
const versionQueryWrapper = { type: 'object', required: ['version'], properties: { version: versionQuerySchema } };

const generateBodySchema = {
  type: 'object',
  properties: {
    listId: stringSchema,
    version: versionBodySchema,
    name: stringSchema,
    mode: { type: 'string', enum: ['LOW_STOCK'] },
    items: { type: 'array', items: shoppingItemSchema }
  }
};

export async function registerShoppingRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.get('/api/v1/shopping-lists', async (request) =>
    success(await listShoppingLists(database, (request.query as { status?: ShoppingListStatus }).status))
  );
  app.post('/api/v1/shopping-lists', { schema: { body: shoppingListBodySchema } }, async (request, reply) =>
    reply.code(201).send(success(await createShoppingList(database, request.body as ShoppingListInput)))
  );
  app.get('/api/v1/shopping-lists/:id', async (request) =>
    success(await getShoppingList(database, (request.params as { id: string }).id))
  );
  app.put('/api/v1/shopping-lists/:id', { schema: { body: shoppingListUpdateBodySchema } }, async (request) => {
    const { version, ...input } = request.body as Partial<ShoppingListInput> & { version: number };
    return success(await updateShoppingList(database, (request.params as { id: string }).id, version, input));
  });
  app.delete('/api/v1/shopping-lists/:id', { schema: { querystring: versionQueryWrapper } }, async (request) =>
    success(
      await deleteShoppingList(
        database,
        (request.params as { id: string }).id,
        Number((request.query as { version: string }).version)
      )
    )
  );
  app.post('/api/v1/shopping-lists/:id/items', { schema: { body: shoppingItemAddBodySchema } }, async (request) => {
    const { version, ...item } = request.body as ShoppingItemInput & { version: number };
    return success(await addShoppingItem(database, (request.params as { id: string }).id, version, item));
  });
  app.put('/api/v1/shopping-list-items/:id', { schema: { body: shoppingItemUpdateBodySchema } }, async (request) => {
    const { version, ...input } = request.body as Partial<ShoppingItemInput> & { version: number };
    return success(await updateShoppingItem(database, (request.params as { id: string }).id, version, input));
  });
  app.delete('/api/v1/shopping-list-items/:id', { schema: { querystring: versionQueryWrapper } }, async (request) =>
    success(
      await deleteShoppingItem(
        database,
        (request.params as { id: string }).id,
        Number((request.query as { version: string }).version)
      )
    )
  );
  app.post('/api/v1/shopping-lists/:id/clear-completed', { schema: { body: versionBodyWrapper } }, async (request) =>
    success(
      await clearCompleted(
        database,
        (request.params as { id: string }).id,
        (request.body as { version: number }).version
      )
    )
  );
  app.post('/api/v1/shopping-lists/generate', { schema: { body: generateBodySchema } }, async (request) =>
    success(await generateShoppingList(database, request.body as Parameters<typeof generateShoppingList>[1]))
  );
}
