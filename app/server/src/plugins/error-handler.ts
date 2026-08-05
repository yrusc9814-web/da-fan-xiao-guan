import type { FastifyError, FastifyInstance } from 'fastify';

import { failure } from '../shared/http.js';

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send(failure('NOT_FOUND', '请求的接口不存在'));
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400
      ? error.statusCode
      : 500;
    const code = statusCode === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR';
    const message = statusCode >= 500 ? '服务器内部错误' : error.message;

    if (statusCode >= 500) {
      app.log.error(error);
    }

    return reply.code(statusCode).send(failure(code, message));
  });
}
