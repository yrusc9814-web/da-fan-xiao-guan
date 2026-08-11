import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createTestPrismaClient } from '../src/database/test-database.js';
import {
  consumeHighRiskAuthorization,
  createHighRiskAuthorization,
  highRiskAuthorizationLifetime,
  setPin
} from '../src/modules/settings/service.js';

const database = createTestPrismaClient();
let app: Awaited<ReturnType<typeof buildApp>>;

describe('本地 PIN 门禁', () => {
  beforeAll(async () => {
    await database.$connect();
    await database.settings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {
        pinEnabled: false,
        pinHash: null,
        onboardingCompleted: false,
        userNickname: null,
        version: { increment: 1 }
      }
    });
    app = await buildApp({ database, logger: false });
  });

  afterAll(async () => {
    await database.settings.update({
      where: { id: 1 },
      data: { pinEnabled: false, pinHash: null, onboardingCompleted: false, version: { increment: 1 } }
    });
    await app.close();
  });

  it('首次设置完成后拒绝再次 onboarding，且原 PIN、昵称与食用者不变', async () => {
    const settings = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/onboarding',
      payload: {
        version: settings.version,
        nickname: '首次用户',
        dinerName: '默认食用者',
        subtitle: '我的小馆',
        pinEnabled: true,
        pin: '3690',
        defaultRepeatDays: 14,
        autoBackupEnabled: false,
        autoDeductInventory: false
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      onboardingCompleted: true,
      pinEnabled: true,
      userNickname: '首次用户',
      subtitle: '我的小馆',
      defaultRepeatDays: 14,
      autoBackupEnabled: false,
      autoDeductInventory: false
    });
    const originalSession = (
      await app.inject({ method: 'POST', url: '/api/v1/settings/pin/verify', payload: { pin: '3690' } })
    ).json().data;

    const latest = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data;
    const repeated = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/onboarding',
      payload: { version: latest.version, nickname: '绕过后的昵称', dinerName: '替换食用者', pin: null }
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().error.code).toBe('ONBOARDING_ALREADY_COMPLETED');
    expect(await database.diner.count({ where: { name: '替换食用者' } })).toBe(0);

    const unchanged = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data;
    expect(unchanged).toMatchObject({ pinEnabled: true, userNickname: '首次用户', version: latest.version });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/dashboard',
          headers: { 'x-app-pin-token': originalSession.token }
        })
      ).statusCode
    ).toBe(200);
    const repeatedWithOldVersion = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/onboarding',
      payload: { version: settings.version, nickname: '旧版本绕过', dinerName: '旧版本食用者', pin: null }
    });
    expect(repeatedWithOldVersion.statusCode).toBe(409);
    expect(repeatedWithOldVersion.json().error.code).toBe('ONBOARDING_ALREADY_COMPLETED');
    const verified = (
      await app.inject({ method: 'POST', url: '/api/v1/settings/pin/verify', payload: { pin: '3690' } })
    ).json().data;
    expect(verified.valid).toBe(true);
    await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/pin',
      headers: { 'x-app-pin-token': verified.token },
      payload: { version: unchanged.version, pin: null, enabled: false }
    });
  });

  it('启用后保护业务 API，正确 PIN 创建限时会话', async () => {
    const settings = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data;
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/settings/pin',
          payload: { version: settings.version, pin: '2580', enabled: true }
        })
      ).statusCode
    ).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/dashboard' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/settings/pin/verify', payload: { pin: '1111' } })).json().data
        .valid
    ).toBe(false);
    const verified = (
      await app.inject({ method: 'POST', url: '/api/v1/settings/pin/verify', payload: { pin: '2580' } })
    ).json().data;
    expect(verified.valid).toBe(true);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/dashboard',
          headers: { 'x-app-pin-token': verified.token }
        })
      ).statusCode
    ).toBe(200);
  });

  it('高风险授权要求再次验证 PIN，并且过期或使用后的 token 失效', async () => {
    await expect(createHighRiskAuthorization(database, { action: 'RESTORE', pin: '0000' })).rejects.toMatchObject({
      statusCode: 401,
      businessCode: 'HIGH_RISK_AUTHORIZATION_INVALID'
    });
    const authorization = await createHighRiskAuthorization(database, { action: 'RESTORE', pin: '2580' }, 1_000);
    consumeHighRiskAuthorization(authorization.token, 'RESTORE', 1_001);
    expect(() => consumeHighRiskAuthorization(authorization.token, 'RESTORE', 1_002)).toThrow('无效或已过期');

    const expired = await createHighRiskAuthorization(database, { action: 'RESTORE', pin: '2580' }, 2_000);
    expect(() =>
      consumeHighRiskAuthorization(expired.token, 'RESTORE', 2_000 + highRiskAuthorizationLifetime + 1)
    ).toThrow('无效或已过期');

    const current = await database.settings.findUniqueOrThrow({ where: { id: 1 } });
    await setPin(database, current.version, null, false);
    const rejectedIntent = await createHighRiskAuthorization(database, { action: 'RESTORE' });
    if (!('challenge' in rejectedIntent)) throw new Error('未返回本地确认 challenge');
    await expect(
      createHighRiskAuthorization(database, {
        action: 'RESTORE',
        challenge: rejectedIntent.challenge,
        confirmation: '错误确认'
      })
    ).rejects.toMatchObject({ statusCode: 401 });
    const intent = await createHighRiskAuthorization(database, { action: 'RESTORE' });
    if (!('challenge' in intent)) throw new Error('未返回本地确认 challenge');
    const localConfirmation = await createHighRiskAuthorization(database, {
      action: 'RESTORE',
      challenge: intent.challenge,
      confirmation: 'RESTORE_LOCAL_DATA'
    });
    if (!('token' in localConfirmation)) throw new Error('未返回高风险 token');
    expect(() => consumeHighRiskAuthorization(localConfirmation.token, 'RESTORE')).not.toThrow();
  });

  it('两个相同 version 的并发 onboarding 最多只有一个成功', async () => {
    const reset = await database.settings.update({
      where: { id: 1 },
      data: {
        onboardingCompleted: false,
        pinEnabled: false,
        pinHash: null,
        userNickname: null,
        version: { increment: 1 }
      }
    });
    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/settings/onboarding',
        payload: { version: reset.version, nickname: '并发用户A', dinerName: '并发食用者A', pin: null }
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/settings/onboarding',
        payload: { version: reset.version, nickname: '并发用户B', dinerName: '并发食用者B', pin: null }
      })
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json().error.code).toBe(
      'ONBOARDING_ALREADY_COMPLETED'
    );
    expect(await database.diner.count({ where: { name: { in: ['并发食用者A', '并发食用者B'] } } })).toBe(1);
  });
});
