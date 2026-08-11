import type { FastifyInstance } from 'fastify';

import { failure } from '../shared/http.js';

let maintenanceActive = false;
let activeApiRequests = 0;
const trackedRequests = new WeakSet<object>();

function releaseRequest(request: object): void {
  if (!trackedRequests.delete(request)) return;
  activeApiRequests = Math.max(0, activeApiRequests - 1);
}

export function registerMaintenanceGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/') || request.url === '/api/v1/health') return;
    if (maintenanceActive) {
      return reply.code(503).send(failure('MAINTENANCE', '数据正在恢复，请稍后重试'));
    }
    trackedRequests.add(request);
    activeApiRequests += 1;
  });
  app.addHook('onResponse', async (request) => releaseRequest(request));
  app.addHook('onError', async (request) => releaseRequest(request));
}

export async function beginMaintenance(allowedInFlight = 0): Promise<void> {
  if (maintenanceActive) throw Object.assign(new Error('已有数据维护任务正在执行'), { statusCode: 409 });
  maintenanceActive = true;
  const deadline = Date.now() + 30_000;
  while (activeApiRequests > allowedInFlight) {
    if (Date.now() >= deadline) {
      maintenanceActive = false;
      throw Object.assign(new Error('等待现有请求结束超时，恢复未开始'), { statusCode: 503 });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function endMaintenance(): void {
  maintenanceActive = false;
}

export function maintenanceState(): { active: boolean; activeApiRequests: number } {
  return { active: maintenanceActive, activeApiRequests };
}
