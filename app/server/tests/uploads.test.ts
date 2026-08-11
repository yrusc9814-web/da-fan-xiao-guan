import Fastify from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerUploadRoutes } from '../src/modules/uploads/routes.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
const database = createTestPrismaClient();
const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
function multipart(filename: string, mime: string, data: Buffer) {
  const boundary = '----dafan-test-boundary';
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
describe('图片上传', () => {
  beforeAll(async () => {
    await database.$connect();
    registerErrorHandlers(app);
    await registerUploadRoutes(app, database);
  });
  afterAll(async () => {
    await app.close();
  });
  it('校验真实格式、8MB 限制和引用删除', async () => {
    const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ffccdd' } })
      .png()
      .toBuffer();
    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/images',
      ...multipart('fake.jpg', 'image/jpeg', png)
    });
    expect(mismatch.statusCode).toBe(422);
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/images',
      ...multipart('large.png', 'image/png', Buffer.alloc(8 * 1024 * 1024 + 1))
    });
    expect(tooLarge.statusCode).toBe(413);
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/images',
      ...multipart('ok.png', 'image/png', png)
    });
    expect(uploaded.statusCode).toBe(201);
    const asset = uploaded.json().data as { id: string; url: string };
    const served = await app.inject({ method: 'GET', url: asset.url });
    expect(served.statusCode).toBe(200);
    expect(served.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    const recipe = await database.recipe.create({ data: { name: '上传引用菜谱', imagePath: asset.url } });
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/uploads/images/${asset.id}` })).statusCode).toBe(409);
    await database.recipe.update({ where: { id: recipe.id }, data: { imagePath: null } });
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/uploads/images/${asset.id}` })).statusCode).toBe(200);
  });
});
