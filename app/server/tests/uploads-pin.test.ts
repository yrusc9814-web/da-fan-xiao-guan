import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { buildApp } from '../src/app.js';
import { createTestPrismaClient } from '../src/database/test-database.js';
import { setPin, uploadSessionCookieName } from '../src/modules/settings/service.js';

const database = createTestPrismaClient();
let app: Awaited<ReturnType<typeof buildApp>>;
const testPin = '941835';
const rotatedPin = '526817';

function multipart(filename: string, mime: string, data: Buffer) {
  const boundary = '----dafan-uploads-pin-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

function cookieHeader(token: string): string {
  return `${uploadSessionCookieName}=${token}`;
}

function firstSetCookie(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

describe('PIN 保护 /uploads 静态图片', () => {
  let assetUrl = '';
  let assetId = '';
  let headerToken = '';
  let uploadCookie = '';

  beforeAll(async () => {
    await database.$connect();
    await database.settings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: { pinEnabled: false, pinHash: null, onboardingCompleted: false }
    });
    app = await buildApp({ database, logger: false });

    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ddeeff' } })
      .png()
      .toBuffer();
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/images',
      ...multipart('ok.png', 'image/png', png)
    });
    expect(uploaded.statusCode).toBe(201);
    const asset = uploaded.json().data as { id: string; url: string };
    assetId = asset.id;
    assetUrl = asset.url;
  });

  afterAll(async () => {
    try {
      const current = await database.settings.findUniqueOrThrow({ where: { id: 1 } });
      await setPin(database, current.version, null, false);
      await app.inject({ method: 'DELETE', url: `/api/v1/uploads/images/${assetId}` });
    } finally {
      await app.close();
    }
  });

  it('PIN 未启用时图片可以直接访问', async () => {
    const response = await app.inject({ method: 'GET', url: assetUrl });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
  });

  it('PIN 启用后：无凭证 401，且不泄露文件是否存在', async () => {
    const settings = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data;
    const enabled = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/pin',
      payload: { version: settings.version, pin: testPin, enabled: true }
    });
    expect(enabled.statusCode).toBe(200);

    const missing = await app.inject({ method: 'GET', url: '/uploads/确实不存在的图片.png' });
    const existing = await app.inject({ method: 'GET', url: assetUrl });
    expect(existing.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(missing.body).toBe(existing.body);

    // 百分号编码的前缀同样要被保护（路由器解码后命中 /uploads/*）
    const encoded = await app.inject({ method: 'GET', url: assetUrl.replace('/uploads/', '/%75ploads/') });
    expect(encoded.statusCode).toBe(401);
  });

  it('无效或过期 cookie 返回 401，畸形 cookie 也不会 500', async () => {
    const invalid = await app.inject({ method: 'GET', url: assetUrl, headers: { cookie: cookieHeader('deadbeef') } });
    expect(invalid.statusCode).toBe(401);
    const malformed = await app.inject({
      method: 'GET',
      url: assetUrl,
      headers: { cookie: `${uploadSessionCookieName}=%zz` }
    });
    expect(malformed.statusCode).toBe(401);
  });

  it('有效会话：仅凭 cookie（<img> 行为）或仅凭 header 都能取到相同图片', async () => {
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/pin/verify',
      payload: { pin: testPin }
    });
    expect(verified.statusCode).toBe(200);
    headerToken = verified.json().data.token;
    const setCookie = firstSetCookie(verified.headers['set-cookie']);
    expect(setCookie).toContain(`${uploadSessionCookieName}=`);

    uploadCookie = setCookie.split(';')[0]!;
    expect(uploadCookie.startsWith(`${uploadSessionCookieName}=`)).toBe(true);

    const viaCookie = await app.inject({ method: 'GET', url: assetUrl, headers: { cookie: uploadCookie } });
    expect(viaCookie.statusCode).toBe(200);
    expect(viaCookie.headers['content-type']).toBe('image/png');
    const viaHeader = await app.inject({ method: 'GET', url: assetUrl, headers: { 'x-app-pin-token': headerToken } });
    expect(viaHeader.statusCode).toBe(200);
    expect(viaCookie.rawPayload.equals(viaHeader.rawPayload)).toBe(true);
  });

  it('upload cookie 不能替代 API 写请求的 header token', async () => {
    const body = multipart('x.png', 'image/png', Buffer.from('not-a-real-image'));
    const uploadWithCookieOnly = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/images',
      headers: { ...body.headers, cookie: uploadCookie },
      payload: body.payload
    });
    expect(uploadWithCookieOnly.statusCode).toBe(401);

    const deleteWithCookieOnly = await app.inject({
      method: 'DELETE',
      url: `/api/v1/uploads/images/${assetId}`,
      headers: { cookie: uploadCookie }
    });
    expect(deleteWithCookieOnly.statusCode).toBe(401);
  });

  it('会话失效后旧 cookie 立即 401（PIN 修改触发服务端清空）', async () => {
    const settings = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().data;
    const rotated = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/pin',
      headers: { 'x-app-pin-token': headerToken },
      payload: { version: settings.version, pin: rotatedPin, enabled: true }
    });
    expect(rotated.statusCode).toBe(200);

    const stale = await app.inject({ method: 'GET', url: assetUrl, headers: { cookie: uploadCookie } });
    expect(stale.statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: { 'x-app-pin-token': headerToken } }))
        .statusCode
    ).toBe(401);
  });

  it('模拟 <img> 的完整链路：PIN 登录后普通 /uploads URL 可获取图片', async () => {
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/pin/verify',
      payload: { pin: rotatedPin }
    });
    expect(verified.statusCode).toBe(200);
    const loginToken = verified.json().data.token;
    const loginCookie = firstSetCookie(verified.headers['set-cookie']).split(';')[0]!;

    // 前端 <img src="/uploads/..."> 只带同源 cookie，不带自定义 header；DTO url 是不含 token 的普通路径
    expect(assetUrl).toMatch(/^\/uploads\/[\w-]+\.png$/);
    const image = await app.inject({ method: 'GET', url: assetUrl, headers: { cookie: loginCookie } });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(loginToken).toEqual(expect.any(String));
  });

  it('已有 header 会话恢复后，upload 会话同步恢复（升级场景）', async () => {
    // 上一个用例修改过 PIN：升级前遗留的旧 token 必须已失效
    const stale = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/pin/session',
      headers: { 'x-app-pin-token': headerToken }
    });
    expect(stale.statusCode).toBe(401);

    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/pin/verify',
      payload: { pin: rotatedPin }
    });
    headerToken = verified.json().data.token;

    // 升级后的前端只持久化了 header token、没有 cookie：pin/session 补发 upload cookie
    const upgraded = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/pin/session',
      headers: { 'x-app-pin-token': headerToken }
    });
    expect(upgraded.statusCode).toBe(200);
    const syncedCookie = firstSetCookie(upgraded.headers['set-cookie']).split(';')[0]!;
    expect(syncedCookie).toContain(headerToken);

    const image = await app.inject({ method: 'GET', url: assetUrl, headers: { cookie: syncedCookie } });
    expect(image.statusCode).toBe(200);

    // 反向恢复：只有 cookie 的浏览器可以从 pin/session 取回 token（guard 豁免该只读端点）
    const recovered = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/pin/session',
      headers: { cookie: syncedCookie }
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().data).toMatchObject({ valid: true, token: headerToken });
  });

  it('路径穿越攻击仍被拒绝，未认证时先 401', async () => {
    const unauthenticated = await app.inject({ method: 'GET', url: '/uploads/..%2f..%2fapp.db' });
    expect(unauthenticated.statusCode).toBe(401);

    const attempts = [
      '/uploads/..%2f..%2fapp.db',
      '/uploads/%2e%2e%2fapp.db',
      '/uploads/..%5c..%5capp.db',
      '/uploads/subdir%2f..%2f..%2fapp.db'
    ];
    for (const url of attempts) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie: cookieHeader(headerToken) } });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('SQLite');
    }
  });
});
