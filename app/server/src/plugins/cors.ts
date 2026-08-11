import cors, { type FastifyCorsOptions } from '@fastify/cors';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const developmentOrigins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);

function sameOrigin(request: FastifyRequest, origin: string): boolean {
  try {
    const candidate = new URL(origin);
    return candidate.protocol === `${request.protocol}:` && candidate.host.toLowerCase() === request.host.toLowerCase();
  } catch {
    return false;
  }
}

function corsOptionsFor(request: FastifyRequest, environment: string): FastifyCorsOptions {
  const origin = request.headers.origin;
  if (!origin) return { origin: false };
  const allowed = sameOrigin(request, origin) || (environment !== 'production' && developmentOrigins.has(origin));
  if (!allowed) {
    throw Object.assign(new Error('不允许来自该来源的请求'), { statusCode: 403 });
  }
  return { origin, credentials: false };
}

export async function registerCors(app: FastifyInstance, environment: string): Promise<void> {
  await app.register(cors, {
    delegator: (request, callback) => {
      try {
        callback(null, corsOptionsFor(request, environment));
      } catch (error) {
        callback(error as Error);
      }
    }
  });
}

export { corsOptionsFor, sameOrigin };
