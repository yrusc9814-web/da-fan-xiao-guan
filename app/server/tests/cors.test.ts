import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createTestPrismaClient } from '../src/database/test-database.js';

const database = createTestPrismaClient();
const config = { appName: '搭饭小馆', version: '0.1.0', host: '0.0.0.0', port: 8787 } as const;
let productionApp: Awaited<ReturnType<typeof buildApp>>;
let developmentApp: Awaited<ReturnType<typeof buildApp>>;

describe('CORS 来源限制', () => {
  beforeAll(async () => {
    await database.$connect();
    productionApp = await buildApp({ database, logger: false, config: { ...config, environment: 'production' } });
    developmentApp = await buildApp({ database, logger: false, config: { ...config, environment: 'development' } });
  });

  afterAll(async () => {
    await productionApp.close();
    await developmentApp.close();
  });

  it('production 拒绝第三方 Origin，但允许本机与局域网同源', async () => {
    const rejected = await productionApp.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '192.168.1.20:8787', origin: 'https://evil.example' }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();

    const sameOrigin = await productionApp.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '192.168.1.20:8787', origin: 'http://192.168.1.20:8787' }
    });
    expect(sameOrigin.statusCode).toBe(200);
    expect(sameOrigin.headers['access-control-allow-origin']).toBe('http://192.168.1.20:8787');

    expect((await productionApp.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
  });

  it('development 允许约定的 Vite 本地来源', async () => {
    const response = await developmentApp.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '127.0.0.1:8787', origin: 'http://localhost:5173' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
