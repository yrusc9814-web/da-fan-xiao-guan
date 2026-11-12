import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerDeletedItemRoutes } from '../src/modules/deleted-items/routes.js';
import { registerMealPlanRoutes } from '../src/modules/meal-plans/routes.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
const database = createTestPrismaClient();
let datePrefix = '2046-02-';
let sequence = 1;
function app(): FastifyInstance {
  const server = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
  registerErrorHandlers(server);
  void registerDeletedItemRoutes(server, database);
  void registerMealPlanRoutes(server, database);
  void registerMealRecordRoutes(server, database);
  return server;
}
async function plan(mealType: 'BREAKFAST' | 'LUNCH' | 'DINNER', item: Record<string, unknown>, dinerCount = 1) {
  const response = await testApp.inject({
    method: 'POST',
    url: '/api/v1/plans',
    payload: { planDate: `${datePrefix}${String(sequence++).padStart(2, '0')}`, mealType, dinerCount, items: [item] }
  });
  expect(response.statusCode).toBe(201);
  return response.json().data as { id: string; version: number; planDate: string };
}
async function complete(p: { id: string; version: number }) {
  const response = await testApp.inject({
    method: 'POST',
    url: `/api/v1/plans/${p.id}/complete`,
    payload: { version: p.version }
  });
  expect(response.statusCode).toBe(200);
  return response.json().data as {
    plan: { id: string; version: number };
    record: { id: string; version: number; sourceType: string };
  };
}
async function undo(p: { id: string; version: number }) {
  const response = await testApp.inject({
    method: 'POST',
    url: `/api/v1/plans/${p.id}/uncomplete`,
    payload: { version: p.version }
  });
  expect(response.statusCode).toBe(200);
  return response.json().data as { plan: { id: string; version: number }; removedRecord: { id: string } };
}
async function archiveFor(entityId: string) {
  return database.deletedItem.findFirstOrThrow({ where: { entityType: 'MealRecord', entityId } });
}
async function snapshotDatabase(): Promise<Record<string, unknown[]>> {
  const tables = await database.$queryRaw<
    Array<{ name: string }>
  >`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_prisma_migrations' ORDER BY name`;
  const result: Record<string, unknown[]> = {};
  for (const { name } of tables) result[name] = await database.$queryRawUnsafe(`SELECT * FROM "${name}" ORDER BY 1`);
  return result;
}
const testApp = app();
describe('plan proof real Fastify/SQLite path', () => {
  beforeAll(async () => {
    await database.$connect();
    // Select an unused month without deleting data owned by other tests.
    let year = 2046;
    while (await database.mealPlan.count({ where: { planDate: { startsWith: `${year}-02-` } } })) year += 1;
    datePrefix = `${year}-02-`;
    await testApp.ready();
  });
  afterAll(async () => {
    await testApp.close();
    await database.$disconnect();
  });
  it('A: STORE -> undo -> PUT RECIPE -> complete reuses record as HOMEMADE with recipeId', async () => {
    const store = await database.store.create({ data: { name: 'real-path-store-a' } });
    const recipe = await database.recipe.create({ data: { name: 'real-path-recipe-a', servings: 2 } });
    const first = await plan('DINNER', { itemType: 'STORE', storeId: store.id });
    const completed = await complete(first);
    const undone = await undo(completed.plan);
    const updated = await testApp.inject({
      method: 'PUT',
      url: `/api/v1/plans/${first.id}`,
      payload: { version: undone.plan.version, items: [{ itemType: 'RECIPE', recipeId: recipe.id }] }
    });
    expect(updated.statusCode).toBe(200);
    const second = await complete({ id: first.id, version: updated.json().data.version });
    expect(second.record.id).toBe(completed.record.id);
    expect(second.record.sourceType).toBe('HOMEMADE');
    expect(
      (await database.mealRecord.findUniqueOrThrow({ where: { id: second.record.id }, include: { items: true } })).items
    ).toMatchObject([{ itemType: 'RECIPE', recipeId: recipe.id, storeId: null }]);
  });
  it('B: RECIPE -> undo -> PUT STORE -> complete reuses record as DINE_IN with storeId', async () => {
    const recipe = await database.recipe.create({ data: { name: 'real-path-recipe-b', servings: 2 } });
    const store = await database.store.create({ data: { name: 'real-path-store-b' } });
    const first = await plan('LUNCH', { itemType: 'RECIPE', recipeId: recipe.id });
    const completed = await complete(first);
    const undone = await undo(completed.plan);
    const updated = await testApp.inject({
      method: 'PUT',
      url: `/api/v1/plans/${first.id}`,
      payload: { version: undone.plan.version, items: [{ itemType: 'STORE', storeId: store.id }] }
    });
    expect(updated.statusCode).toBe(200);
    const second = await complete({ id: first.id, version: updated.json().data.version });
    expect(second.record.id).toBe(completed.record.id);
    expect(second.record.sourceType).toBe('DINE_IN');
    expect(
      (await database.mealRecord.findUniqueOrThrow({ where: { id: second.record.id }, include: { items: true } })).items
    ).toMatchObject([{ itemType: 'STORE', storeId: store.id, recipeId: null }]);
  });
  it('C: changed date/item/diner values complete the same record without inventory or consumption writes', async () => {
    const recipe = await database.recipe.create({ data: { name: 'real-path-recipe-c', servings: 2 } });
    const diner = await database.diner.create({ data: { name: 'real-path-diner-c' } });
    const ingredient = await database.ingredient.create({
      data: { name: 'real-path-ingredient-c', unit: 'GRAM', quantity: 1000 }
    });
    await database.inventoryBatch.create({ data: { ingredientId: ingredient.id, quantity: 1000, unit: 'GRAM' } });
    const first = await plan('BREAKFAST', { itemType: 'CUSTOM', customName: 'before-c' });
    const completed = await complete(first);
    const undone = await undo(completed.plan);
    const ingredientBefore = await database.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } });
    const batchBefore = await database.inventoryBatch.findFirstOrThrow({ where: { ingredientId: ingredient.id } });
    const before = await snapshotDatabase();
    const nextDate = `${datePrefix}28`;
    const updated = await testApp.inject({
      method: 'PUT',
      url: `/api/v1/plans/${first.id}`,
      payload: {
        version: undone.plan.version,
        planDate: nextDate,
        dinerCount: 1,
        dinerIds: [diner.id],
        items: [{ itemType: 'RECIPE', recipeId: recipe.id }]
      }
    });
    expect(updated.statusCode).toBe(200);
    const finished = await complete({ id: first.id, version: updated.json().data.version });
    expect(finished.record.id).toBe(completed.record.id);
    const record = await database.mealRecord.findUniqueOrThrow({
      where: { id: finished.record.id },
      include: { items: true, diners: true }
    });
    expect(record.recordDate).toBe(nextDate);
    expect(record.items).toMatchObject([{ itemType: 'RECIPE', recipeId: recipe.id }]);
    expect(record.diners.map(({ dinerId }) => dinerId)).toEqual([diner.id]);
    expect(await database.inventoryLog.count({ where: { relatedRecordId: record.id } })).toBe(0);
    expect(await database.consumptionOperation.count({ where: { mealRecordId: record.id } })).toBe(0);
    const ingredientAfter = await database.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } });
    const batchAfter = await database.inventoryBatch.findFirstOrThrow({ where: { ingredientId: ingredient.id } });
    expect(ingredientAfter).toEqual(ingredientBefore);
    expect(batchAfter).toEqual(batchBefore);
    const after = await snapshotDatabase();
    expect(after.inventoryLog).toEqual(before.inventoryLog);
    expect(after.consumptionOperation).toEqual(before.consumptionOperation);
  });
  it.each([
    ['title-only', { title: 'manual title d' }],
    ['item-only', { items: [{ itemType: 'CUSTOM', customName: 'manual item d' }] }],
    ['recordDate-only', { recordDate: '2046-03-01' }],
    ['mealType-only', { mealType: 'LUNCH' }],
    ['dinerIds-only', { dinerIds: ['PLACEHOLDER'] }]
  ] as const)(
    'D: %s manual field edit then DELETE has no proof and complete is zero-write 409',
    async (label, patch) => {
      const first = await plan('DINNER', { itemType: 'CUSTOM', customName: `manual-${label}` });
      const completed = await complete(first);
      const undone = await undo(completed.plan);
      const recycle = await archiveFor(completed.record.id);
      expect(
        (await testApp.inject({ method: 'POST', url: `/api/v1/deleted-items/${recycle.id}/restore` })).statusCode
      ).toBe(200);
      const record = await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } });
      const diner =
        label === 'dinerIds-only' ? await database.diner.create({ data: { name: `manual-diner-${sequence}` } }) : null;
      const actualPatch = label === 'dinerIds-only' ? { dinerIds: [diner!.id] } : patch;
      const update = await testApp.inject({
        method: 'PUT',
        url: `/api/v1/records/${record.id}`,
        payload: { version: record.version, ...actualPatch }
      });
      expect(update.statusCode).toBe(200);
      const deleted = await testApp.inject({
        method: 'DELETE',
        url: `/api/v1/records/${record.id}?version=${update.json().data.version}`
      });
      expect(deleted.statusCode).toBe(200);
      const before = await snapshotDatabase();
      const blocked = await testApp.inject({
        method: 'POST',
        url: `/api/v1/plans/${first.id}/complete`,
        payload: { version: undone.plan.version }
      });
      expect(blocked.statusCode).toBe(409);
      expect((await database.mealRecord.findUniqueOrThrow({ where: { id: record.id } })).deletedAt).not.toBeNull();
      expect(await snapshotDatabase()).toEqual(before);
      expect((await archiveFor(record.id)).planUncompleteProof).toBeNull();
    }
  );
  it('E: unedited manual DELETE after restore has no proof and is protected', async () => {
    const first = await plan('LUNCH', { itemType: 'CUSTOM', customName: 'manual-e' });
    const completed = await complete(first);
    const undone = await undo(completed.plan);
    const recycle = await archiveFor(completed.record.id);
    expect(
      (await testApp.inject({ method: 'POST', url: `/api/v1/deleted-items/${recycle.id}/restore` })).statusCode
    ).toBe(200);
    const record = await database.mealRecord.findUniqueOrThrow({ where: { id: completed.record.id } });
    const deleted = await testApp.inject({
      method: 'DELETE',
      url: `/api/v1/records/${record.id}?version=${record.version}`
    });
    expect(deleted.statusCode).toBe(200);
    const before = await snapshotDatabase();
    const blocked = await testApp.inject({
      method: 'POST',
      url: `/api/v1/plans/${first.id}/complete`,
      payload: { version: undone.plan.version }
    });
    expect(blocked.statusCode).toBe(409);
    expect(await snapshotDatabase()).toEqual(before);
  });
  it('F: missing, malformed, and ID-mismatched proofs fail closed with zero writes', async () => {
    const cases = [
      ['missing', null],
      ['malformed-json', '{not-json'],
      ['plan-id-mismatch', 'plan-id-mismatch'],
      ['record-id-mismatch', 'record-id-mismatch']
    ] as const;
    for (const [label, kind] of cases) {
      const first = await plan('BREAKFAST', { itemType: 'CUSTOM', customName: `proof-${label}` });
      const completed = await complete(first);
      const undone = await undo(completed.plan);
      const item = await archiveFor(completed.record.id);
      const proof =
        kind && (kind.startsWith('plan') || kind.startsWith('record')) ? JSON.parse(item.planUncompleteProof!) : null;
      if (proof && kind) proof[kind.startsWith('plan') ? 'sourcePlanId' : 'sourceRecordId'] = 'wrong-id';
      await database.deletedItem.update({
        where: { id: item.id },
        data: { planUncompleteProof: proof ? JSON.stringify(proof) : kind }
      });
      const before = await snapshotDatabase();
      const blocked = await testApp.inject({
        method: 'POST',
        url: `/api/v1/plans/${first.id}/complete`,
        payload: { version: undone.plan.version }
      });
      expect(blocked.statusCode, label).toBe(409);
      expect(await snapshotDatabase(), label).toEqual(before);
    }
  });

  it('G: malformed proof versions fail closed for zero, negative, and unsafe integers', async () => {
    for (const [field, fieldLabel] of [
      ['sourcePlanVersion', 'plan'],
      ['sourceRecordVersion', 'record']
    ] as const)
      for (const [label, version] of [
        ['zero', 0],
        ['negative', -1],
        ['unsafe', Number.MAX_SAFE_INTEGER + 1]
      ] as const) {
        const first = await plan('BREAKFAST', { itemType: 'CUSTOM', customName: `fault-${fieldLabel}-${label}` });
        const completed = await complete(first);
        const undone = await undo(completed.plan);
        const item = await archiveFor(completed.record.id);
        const proof = JSON.parse(item.planUncompleteProof!);
        proof[field] = version;
        await database.deletedItem.update({
          where: { id: item.id },
          data: { planUncompleteProof: JSON.stringify(proof) }
        });
        const before = await snapshotDatabase();
        const blocked = await testApp.inject({
          method: 'POST',
          url: `/api/v1/plans/${first.id}/complete`,
          payload: { version: undone.plan.version }
        });
        expect(blocked.statusCode, `${field}-${label}`).toBe(409);
        expect(await snapshotDatabase(), `${field}-${label}`).toEqual(before);
      }
  });
});
