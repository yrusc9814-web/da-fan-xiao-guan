import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

describe('基础 HTTP 接口', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('健康检查返回统一成功结构', async () => {
    app = await buildApp({ logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health'
    });
    const payload = response.json() as {
      success: boolean;
      data: { status: string; app: string; version: string; timestamp: string };
      error: null;
    };

    expect(response.statusCode).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data).toMatchObject({
      status: 'ok',
      app: '搭饭小馆',
      version: '0.1.0'
    });
    expect(Number.isNaN(Date.parse(payload.data.timestamp))).toBe(false);
    expect(payload.error).toBeNull();
  });

  it('未知接口返回 404 和统一错误结构', async () => {
    app = await buildApp({ logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/unknown'
    });
    const payload = response.json() as {
      success: boolean;
      data: null;
      error: { code: string; message: string };
    };

    expect(response.statusCode).toBe(404);
    expect(payload).toEqual({
      success: false,
      data: null,
      error: {
        code: 'NOT_FOUND',
        message: '请求的接口不存在'
      }
    });
  });
});
