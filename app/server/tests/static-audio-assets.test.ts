import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fixtureDirectory as tmpdir } from './setup/fixture-paths.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createPrismaClient } from '../src/database/client.js';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testsDirectory, '../../..');
const publicAudioDirectory = resolve(projectRoot, 'app/client/public/assets/audio');

/**
 * 已核对的音效资源指纹（实现时与 Source of Truth 的 assets/audio 逐字节比对过）。
 * 这里只用固定常量，不在测试里依赖 SoT 的绝对路径，保证测试可跨机器运行。
 */
const audioAssets = [
  {
    fileName: 'timer_alarm.m4a',
    bytes: 65334,
    sha256: '1d12225362f16c0b4e19bec92c5403b4e0ef790ef0eca365f8d9581f0afafe62'
  },
  {
    fileName: 'wheel_exclude.m4a',
    bytes: 7786,
    sha256: 'b4bba27813429aea01df08307e8731819ef1477852094694133c9bcc9e63011f'
  },
  {
    fileName: 'wheel_winner.m4a',
    bytes: 14516,
    sha256: '6ce56cceba10ad17eee26c076c1cc8af7f2fc8d6e85ccc1d4d4137816ac3db9a'
  }
] as const;

/**
 * 该文件的测试库独立于 data/test.db，也绝不会指向开发库 data/app.db；
 * 测试只做静态资源 HTTP 断言，不连接、不写入任何数据库。
 */
const database = createPrismaClient(`file:${resolve(tmpdir(), 'test-assets.db')}`);
let app: FastifyInstance;
let fixtureRoot: string;
let originalCwd: string;

function describeAudioContainer(bytes: Buffer) {
  const boxTypes: string[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length && boxTypes.length < 8) {
    const size = bytes.readUInt32BE(offset);
    boxTypes.push(bytes.subarray(offset + 4, offset + 8).toString('latin1'));
    if (size < 8) break;
    offset += size;
  }
  return {
    ftyp: bytes.subarray(4, 8).toString('latin1'),
    brand: bytes.subarray(8, 12).toString('latin1'),
    mdatOffset: bytes.indexOf('mdat'),
    boxTypes
  };
}

describe('VAN-36 音效静态资源', () => {
  beforeAll(async () => {
    // 独立夹具目录：只从 app/client/public 复制音效，不依赖其它代理是否执行过 client build。
    originalCwd = process.cwd();
    fixtureRoot = await mkdtemp(join(tmpdir(), 'g2-static-audio-'));
    const fixtureDist = join(fixtureRoot, 'app', 'client', 'dist');
    await mkdir(join(fixtureDist, 'assets', 'audio'), { recursive: true });
    await writeFile(join(fixtureDist, 'index.html'), '<!doctype html><html><body>spa-fallback</body></html>');
    for (const asset of audioAssets) {
      await copyFile(join(publicAudioDirectory, asset.fileName), join(fixtureDist, 'assets', 'audio', asset.fileName));
    }
    // 生产模式才注册静态服务，静态根是 resolve(process.cwd(), 'app/client/dist')，故临时切换 cwd 到夹具根。
    process.chdir(fixtureRoot);
    app = await buildApp({
      database,
      logger: false,
      config: { appName: '搭饭小馆', version: '0.1.0', host: '0.0.0.0', port: 8787, environment: 'production' }
    });
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.chdir(originalCwd);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each(audioAssets)('$fileName 存在于 public 资源且字节与已核指纹一致', async (asset) => {
    const filePath = join(publicAudioDirectory, asset.fileName);
    const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
    expect(metadata.size).toBe(asset.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
  });

  it.each(audioAssets)('$fileName 经静态服务返回真实音频内容（MIME/字节/容器结构，而非 HTML 兜底）', async (asset) => {
    const response = await app.inject({ method: 'GET', url: `/assets/audio/${asset.fileName}` });
    expect(response.statusCode).toBe(200);

    const contentType = String(response.headers['content-type'] ?? '');
    expect(contentType.startsWith('audio/')).toBe(true);

    const body = response.rawPayload;
    expect(body.length).toBe(asset.bytes);
    expect(createHash('sha256').update(body).digest('hex')).toBe(asset.sha256);
    // 与 public 源文件逐字节一致（排除任何转换/截断）
    expect(body.equals(await readFile(join(publicAudioDirectory, asset.fileName)))).toBe(true);

    const container = describeAudioContainer(body);
    expect(container.ftyp).toBe('ftyp');
    expect(container.brand).toBe('M4A ');
    expect(container.mdatOffset).toBeGreaterThan(0);
    expect(container.boxTypes).toContain('mdat');
  });

  it('dist 中缺失该资源时 SPA 兜底会返回 HTML 200——这正是必须把音效复制进构建产物的原因', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/audio/not-copied.m4a' });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'] ?? '')).toContain('text/html');
    expect(response.body).toContain('spa-fallback');
  });
});
