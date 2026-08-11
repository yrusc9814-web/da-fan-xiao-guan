import type { FastifyError, FastifyInstance } from 'fastify';

import { VersionConflictError } from '../database/optimistic-lock.js';
import { failure } from '../shared/http.js';
import type { ApiErrorCode } from '../../../shared/types/api.js';

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send(failure('NOT_FOUND', '请求的接口不存在'));
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof VersionConflictError) {
      return reply.code(409).send(
        failure('VERSION_CONFLICT', error.message, {
          entity: error.conflict.entity,
          id: error.conflict.id,
          expectedVersion: error.conflict.expectedVersion,
          actualVersion: error.conflict.actualVersion
        })
      );
    }

    const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    const businessCode = (error as FastifyError & { businessCode?: ApiErrorCode }).businessCode;
    const code =
      businessCode ??
      (statusCode === 400 || statusCode === 422
        ? 'VALIDATION_ERROR'
        : statusCode === 401
          ? 'UNAUTHORIZED'
          : statusCode === 409
            ? 'CONFLICT'
            : 'INTERNAL_ERROR');
    const message = statusCode >= 500 ? '服务器内部错误' : error.message;

    if (statusCode >= 500) {
      app.log.error(error);
    }

    return reply.code(statusCode).send(failure(code, message));
  });
}
