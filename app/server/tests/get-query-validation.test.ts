import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerCalendarRoutes } from '../src/modules/calendar/routes.js';
import { registerDinerRoutes } from '../src/modules/diners/routes.js';
import { registerIngredientRoutes } from '../src/modules/ingredients/routes.js';
import { registerInventoryRoutes } from '../src/modules/inventory/routes.js';
import { registerMealPlanRoutes } from '../src/modules/meal-plans/routes.js';
import { registerMealRecordRoutes } from '../src/modules/meal-records/routes.js';
import { registerRecipeRoutes } from '../src/modules/recipes/routes.js';
import { registerShoppingRoutes } from '../src/modules/shopping/routes.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';

const database = createTestPrismaClient();
let app: FastifyInstance;

describe('GET query 运行时校验（坏输入 → 400，不进入 Prisma 500）', () => {
  beforeAll(async () => {
    await database.$connect();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerRecipeRoutes(app, database);
    await registerMealPlanRoutes(app, database);
    await registerMealRecordRoutes(app, database);
    await registerShoppingRoutes(app, database);
    await registerInventoryRoutes(app, database);
    await registerIngredientRoutes(app, database);
    await registerCalendarRoutes(app, database);
    await registerDinerRoutes(app, database);
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it('A：page=abc → 400', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/recipes?page=abc' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('B：page=-1 → 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/recipes?page=-1' })).statusCode).toBe(400);
  });

  it('C：page=1.5 → 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/recipes?page=1.5' })).statusCode).toBe(400);
  });

  it('D：pageSize=abc → 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/recipes?pageSize=abc' })).statusCode).toBe(400);
  });

  it('E：take=abc → 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/inventory/logs?take=abc' })).statusCode).toBe(400);
  });

  it('F：非法 enum → 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/records?mealType=HELLO' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/plans?status=NOPE' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/shopping-lists?status=NOPE' })).statusCode).toBe(400);
  });

  it('minRating=abc → 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/records?minRating=abc' })).statusCode).toBe(400);
  });

  it('G/H：合法 query 与缺省 query 保持 200', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/recipes' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/recipes?page=1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/plans' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/inventory/logs' })).statusCode).toBe(200);
  });

  it('I：非法 query 不返回 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/recipes?page=abc' });
    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(500);
  });

  it('超长 page 不会变成 Infinity 进入 Prisma', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/recipes?page=1000000000' });
    expect(response.statusCode).toBe(400);
  });
});
