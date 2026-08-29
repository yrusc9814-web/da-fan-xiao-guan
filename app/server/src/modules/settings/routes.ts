import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { failure, success } from '../../shared/http.js';
import {
  booleanSchema,
  integerSchema,
  nullableStringSchema,
  stringSchema,
  versionBodySchema
} from '../../shared/validation-schemas.js';
import {
  completeOnboarding,
  getAccessQr,
  createHighRiskAuthorization,
  getSettings,
  pinRetryAfterSeconds,
  setPin,
  updateSettings,
  uploadSessionCookieName,
  validPinSession,
  verifyPinAndCreateSession
} from './service.js';

const uploadCookieMaxAgeSeconds = 12 * 60 * 60;

const onboardingBodySchema = {
  type: 'object',
  required: ['version', 'nickname', 'dinerName'],
  properties: {
    version: versionBodySchema,
    nickname: stringSchema,
    dinerName: stringSchema,
    subtitle: stringSchema,
    userAvatarPath: nullableStringSchema,
    pinEnabled: booleanSchema,
    pin: { type: ['string', 'null'] },
    defaultRepeatDays: { ...integerSchema, minimum: 0, maximum: 365 },
    autoBackupEnabled: booleanSchema,
    autoDeductInventory: booleanSchema
  }
};

const updateSettingsBodySchema = {
  type: 'object',
  required: ['version'],
  properties: {
    version: versionBodySchema,
    appName: stringSchema,
    subtitle: stringSchema,
    userNickname: nullableStringSchema,
    userAvatarPath: nullableStringSchema,
    autoBackupEnabled: booleanSchema,
    autoDeductInventory: booleanSchema,
    defaultRepeatDays: { ...integerSchema, minimum: 0, maximum: 365 },
    onboardingCompleted: booleanSchema
  }
};

const setPinBodySchema = {
  type: 'object',
  required: ['version', 'enabled'],
  properties: { version: versionBodySchema, enabled: booleanSchema, pin: { type: ['string', 'null'] } }
};

const verifyPinBodySchema = { type: 'object', required: ['pin'], properties: { pin: stringSchema } };

const highRiskBodySchema = {
  type: 'object',
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['RESTORE'] },
    pin: { type: ['string', 'null'] },
    confirmation: { type: ['string', 'null'] },
    challenge: { type: ['string', 'null'] }
  }
};

interface BusinessError extends Error {
  statusCode: number;
  businessCode: string;
}

export function registerPinGuard(app: FastifyInstance, database: PrismaClient) {
  app.addHook('preHandler', async (request, reply) => {
    // request.url 保留原始编码（如 /%61pi/...），直接做前缀判断会被绕过；
    // preHandler 阶段必然已匹配到具体路由，因此以路由器解析出的规范化模式为准。
    const url = request.routeOptions.url ?? '';
    const isApi = url.startsWith('/api/v1/');
    const isUpload = url.startsWith('/uploads/');
    if (!isApi && !isUpload) return;
    if (
      url === '/api/v1/health' ||
      (request.method === 'POST' && url === '/api/v1/settings/pin/verify') ||
      (request.method === 'POST' && url === '/api/v1/settings/onboarding') ||
      (request.method === 'GET' && url === '/api/v1/settings') ||
      (request.method === 'GET' && url === '/api/v1/settings/pin/session')
    )
      return;
    const settings = await database.settings.findUnique({ where: { id: 1 }, select: { pinEnabled: true } });
    if (!settings?.pinEnabled) return;
    if (validPinSession(request.headers['x-app-pin-token'] as string | undefined)) return;
    // /uploads/* 由 <img> 等标签直接发起，无法携带自定义 header，只对这些路径额外接受
    // Path=/uploads 的 HttpOnly 会话 cookie；/api/v1/ 全部接口（含写请求）仍只认 header token。
    if (isUpload) {
      const cookieToken = parsePinSessionCookies(request.headers.cookie)[uploadSessionCookieName];
      if (validPinSession(cookieToken)) return;
    }
    return reply.code(401).send(failure('UNAUTHORIZED', '需要先验证本地 PIN'));
  });
}

export function parsePinSessionCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const rawValue = part.slice(index + 1).trim();
    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      // 非法编码的 cookie 值按原样保留，避免整个请求 500
    }
    if (name) cookies[name] = value;
  }
  return cookies;
}

function setUploadSessionCookie(reply: FastifyReply, token: string): void {
  reply.header(
    'set-cookie',
    `${uploadSessionCookieName}=${encodeURIComponent(token)}; Path=/uploads; HttpOnly; SameSite=Strict; Max-Age=${uploadCookieMaxAgeSeconds}`
  );
}

export function clearUploadSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${uploadSessionCookieName}=; Path=/uploads; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export async function registerSettingsRoutes(app: FastifyInstance, database: PrismaClient) {
  app.get('/api/v1/settings', async () => success(await getSettings(database)));
  app.post<{ Body: Parameters<typeof completeOnboarding>[1] }>(
    '/api/v1/settings/onboarding',
    { schema: { body: onboardingBodySchema } },
    async (request) => success(await completeOnboarding(database, request.body))
  );
  app.get('/api/v1/settings/pin/session', async (request, reply) => {
    const settings = await database.settings.findUnique({ where: { id: 1 }, select: { pinEnabled: true } });
    if (!settings?.pinEnabled) return success({ valid: true });
    const token = request.headers['x-app-pin-token'] as string | undefined;
    const cookieToken = parsePinSessionCookies(request.headers.cookie)[uploadSessionCookieName];
    if (token && validPinSession(token)) {
      // 升级兼容：老版本前端只持久化 header token，首次访问时补发 /uploads 会话 cookie
      if (cookieToken !== token) setUploadSessionCookie(reply, token);
      return success({ valid: true });
    }
    if (cookieToken && validPinSession(cookieToken)) {
      // 恢复链路：token 丢失但 HttpOnly cookie 仍有效时，把 token 交回前端重新持久化
      return success({ valid: true, token: cookieToken });
    }
    return reply.code(401).send(failure('UNAUTHORIZED', '会话无效'));
  });
  app.put<{ Body: { version: number } & Parameters<typeof updateSettings>[2] }>(
    '/api/v1/settings',
    { schema: { body: updateSettingsBodySchema } },
    async (request) => {
      const { version, ...input } = request.body;
      return success(await updateSettings(database, version, input));
    }
  );
  app.put<{ Body: { version: number; pin: string | null; enabled: boolean } }>(
    '/api/v1/settings/pin',
    { schema: { body: setPinBodySchema } },
    async (request, reply) => {
      const result = await setPin(database, request.body.version, request.body.pin, request.body.enabled);
      clearUploadSessionCookie(reply);
      return success(result);
    }
  );
  app.post<{ Body: { pin: string } }>(
    '/api/v1/settings/pin/verify',
    { schema: { body: verifyPinBodySchema } },
    async (request, reply) => {
      const clientKey = request.ip;
      try {
        const result = await verifyPinAndCreateSession(database, request.body.pin, clientKey);
        if (!result.token) return success(result);
        setUploadSessionCookie(reply, result.token);
        return success(result);
      } catch (error) {
        const business = error as Partial<BusinessError>;
        if (business?.businessCode === 'PIN_ATTEMPTS_EXCEEDED') {
          return reply
            .code(429)
            .header('retry-after', pinRetryAfterSeconds(clientKey))
            .send(failure('PIN_ATTEMPTS_EXCEEDED', '尝试次数过多，请稍后再试'));
        }
        throw error;
      }
    }
  );
  app.post<{ Body: { action: 'RESTORE'; pin?: string; confirmation?: string; challenge?: string } }>(
    '/api/v1/settings/high-risk/authorize',
    { schema: { body: highRiskBodySchema } },
    async (request) => success(await createHighRiskAuthorization(database, request.body))
  );
  app.get<{ Querystring: { host?: string } }>('/api/v1/settings/access-qr', async (request) =>
    success(await getAccessQr(request.query.host))
  );
}
