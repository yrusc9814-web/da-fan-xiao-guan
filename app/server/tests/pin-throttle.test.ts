import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createTestPrismaClient } from '../src/database/test-database.js';
import {
  clearPinSessions,
  pinAttemptLimit,
  pinAttemptsSize,
  pinLockoutMs,
  setPin,
  verifyPinAndCreateSession
} from '../src/modules/settings/service.js';

const database = createTestPrismaClient();
let app: Awaited<ReturnType<typeof buildApp>>;
const testPin = '730815';

async function verify(pin: string, remoteAddress: string) {
  return app.inject({ method: 'POST', url: '/api/v1/settings/pin/verify', remoteAddress, payload: { pin } });
}

describe('PIN 暴力尝试限制', () => {
  beforeAll(async () => {
    await database.$connect();
    await database.settings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: { pinEnabled: false, pinHash: null, onboardingCompleted: false }
    });
    app = await buildApp({ database, logger: false });
    const current = await database.settings.findUniqueOrThrow({ where: { id: 1 } });
    await setPin(database, current.version, testPin, true);
  });

  afterAll(async () => {
    try {
      const current = await database.settings.findUniqueOrThrow({ where: { id: 1 } });
      await setPin(database, current.version, null, false);
    } finally {
      await app.close();
    }
  });

  it('阈值前的连续失败不返回 429，也不创建会话', async () => {
    for (let attempt = 0; attempt < pinAttemptLimit - 1; attempt += 1) {
      const response = await verify('000000', '10.7.0.11');
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({ valid: false, token: null });
    }
  });

  it('达到阈值后进入冷却：429、PIN_ATTEMPTS_EXCEEDED、Retry-After，且不创建会话', async () => {
    // 承接上一用例的第 5 次失败：本次仍是最后一次允许的验证尝试
    const fifth = await verify('000000', '10.7.0.11');
    expect(fifth.statusCode).toBe(200);
    expect(fifth.json().data).toMatchObject({ valid: false, token: null });

    const locked = await verify('000000', '10.7.0.11');
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('PIN_ATTEMPTS_EXCEEDED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(locked.json().data).toBeNull();
  });

  it('注入时钟推进 30s 冷却到期后可再次验证（不真实等待）', async () => {
    const t0 = 1_000_000;
    for (let attempt = 0; attempt < pinAttemptLimit; attempt += 1) {
      await verifyPinAndCreateSession(database, '000000', 'clock-client', t0);
    }
    await expect(
      verifyPinAndCreateSession(database, '000000', 'clock-client', t0 + pinLockoutMs - 1)
    ).rejects.toMatchObject({ statusCode: 429, businessCode: 'PIN_ATTEMPTS_EXCEEDED' });

    const recovered = await verifyPinAndCreateSession(database, testPin, 'clock-client', t0 + pinLockoutMs);
    expect(recovered.valid).toBe(true);
    expect(recovered.token).toEqual(expect.any(String));
  });

  it('成功验证清零计数，之后一次失败从 1 重新计', async () => {
    for (let attempt = 0; attempt < pinAttemptLimit - 1; attempt += 1) {
      expect((await verify('000000', '10.7.0.12')).statusCode).toBe(200);
    }
    const success = await verify(testPin, '10.7.0.12');
    expect(success.statusCode).toBe(200);
    expect(success.json().data?.token).toEqual(expect.any(String));

    const singleFailure = await verify('000000', '10.7.0.12');
    expect(singleFailure.statusCode).toBe(200);
    expect(singleFailure.json().data).toMatchObject({ valid: false, token: null });

    // 若成功未清零，这里累计失败已达 5 次会返回 429
    const nextSuccess = await verify(testPin, '10.7.0.12');
    expect(nextSuccess.statusCode).toBe(200);
    expect(nextSuccess.json().data?.valid).toBe(true);
  });

  it('客户端隔离：A 被冷却不影响不同 IP 的 B', async () => {
    for (let attempt = 0; attempt < pinAttemptLimit; attempt += 1) {
      expect((await verify('000000', '10.7.0.13')).statusCode).toBe(200);
    }
    expect((await verify('000000', '10.7.0.13')).statusCode).toBe(429);

    const otherClient = await verify(testPin, '10.7.0.14');
    expect(otherClient.statusCode).toBe(200);
    expect(otherClient.json().data?.token).toEqual(expect.any(String));

    expect((await verify('000000', '10.7.0.13')).statusCode).toBe(429);
  });

  it('过期条目被惰性清理，map 不会无限增长', async () => {
    clearPinSessions();
    expect(pinAttemptsSize()).toBe(0);

    const t0 = 5_000_000;
    for (let client = 0; client < 20; client += 1) {
      await verifyPinAndCreateSession(database, '000000', `flood-${client}`, t0);
    }
    expect(pinAttemptsSize()).toBe(20);

    // 未到期：触发清理也不会误删在窗口内的条目
    await verifyPinAndCreateSession(database, testPin, 'flood-probe', t0 + 1000);
    expect(pinAttemptsSize()).toBe(20);

    // 到期：所有条目作废并重新计数
    await verifyPinAndCreateSession(database, testPin, 'flood-probe', t0 + pinLockoutMs + 1);
    expect(pinAttemptsSize()).toBe(0);
  });
});
