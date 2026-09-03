import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createTestPrismaClient } from '../src/database/test-database.js';

const database = createTestPrismaClient();
let app: Awaited<ReturnType<typeof buildApp>>;

// 边界守护：onboarding 不再提供「头像路径」输入（首次创建提交 null），
// 但已有用户的头像不能被普通设置保存或重复 onboarding 无意清空。
describe('Settings 头像字段边界', () => {
  beforeAll(async () => {
    await database.$connect();
    await database.settings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        userNickname: '已有头像用户',
        userAvatarPath: '/uploads/avatar-existing.png',
        onboardingCompleted: true
      },
      update: {
        userNickname: '已有头像用户',
        userAvatarPath: '/uploads/avatar-existing.png',
        onboardingCompleted: true,
        version: { increment: 1 }
      }
    });
    app = await buildApp({ database, logger: false });
  });

  afterAll(async () => {
    await database.settings.update({
      where: { id: 1 },
      data: { userAvatarPath: null, onboardingCompleted: false, version: { increment: 1 } }
    });
    await app.close();
  });

  it('普通设置保存不携带头像字段时，已有头像保持不变', async () => {
    const settings = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data;
    expect(settings.userAvatarPath).toBe('/uploads/avatar-existing.png');

    // 与 SettingsPage.vue 保存行为一致：不发送 userAvatarPath
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: {
        version: settings.version,
        appName: '搭饭小馆',
        subtitle: '让每一餐都更美好',
        userNickname: '已有头像用户',
        autoBackupEnabled: true,
        autoDeductInventory: true,
        defaultRepeatDays: 7,
        onboardingCompleted: true
      }
    });
    expect(response.statusCode).toBe(200);

    const updated = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data;
    expect(updated.userAvatarPath).toBe('/uploads/avatar-existing.png');
  });

  it('onboarding 已完成后无法重复提交覆盖头像', async () => {
    const settings = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data;
    const repeated = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/onboarding',
      payload: { version: settings.version, nickname: '覆盖尝试', dinerName: '覆盖食用者', userAvatarPath: null }
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().error.code).toBe('ONBOARDING_ALREADY_COMPLETED');

    const after = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data;
    expect(after.userAvatarPath).toBe('/uploads/avatar-existing.png');
    expect(after.userNickname).toBe('已有头像用户');
  });
});
