import { describe, expect, it } from 'vitest';

import {
  getAccessQr,
  listLanIpv4Addresses,
  pickPreferredLanIpv4,
  type LanInterfaceAddress
} from '../src/modules/settings/service.js';

function iface(address: string, options: Partial<LanInterfaceAddress> = {}): LanInterfaceAddress {
  return {
    address,
    family: options.family ?? 'IPv4',
    internal: options.internal ?? false
  };
}

describe('局域网访问二维码', () => {
  it('A/B：不传浏览器 origin 时仍返回唯一 LAN IPv4', async () => {
    const result = await getAccessQr(undefined, { Ethernet: [iface('192.168.1.23')] }, 8787);
    expect(result.url).toBe('http://192.168.1.23:8787');
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.candidates).toEqual(['http://192.168.1.23:8787']);
    expect(result.message).toBeNull();
  });

  it('C：loopback 与 internal 地址被排除', () => {
    expect(
      listLanIpv4Addresses({
        Loopback: [iface('127.0.0.1', { internal: true })],
        Virtual: [iface('10.0.0.2', { internal: true })],
        Wifi: [iface('192.168.1.8')]
      })
    ).toEqual(['192.168.1.8']);
  });

  it('D：多个 LAN 地址按 192.168 > 10 > 172.16 选择，candidates 含全部且不含 127.0.0.1', async () => {
    const interfaces = {
      Wifi: [iface('10.0.0.8'), iface('192.168.1.23')],
      Vpn: [iface('172.16.1.4')],
      Loopback: [iface('127.0.0.1', { internal: true })]
    };
    expect(pickPreferredLanIpv4(listLanIpv4Addresses(interfaces))).toBe('192.168.1.23');
    const result = await getAccessQr(undefined, interfaces, 8787);
    expect(result.url).toBe('http://192.168.1.23:8787');
    expect(result.candidates).toEqual(['http://10.0.0.8:8787', 'http://172.16.1.4:8787', 'http://192.168.1.23:8787']);
    expect(result.candidates.join(' ')).not.toContain('127.0.0.1');
  });

  it('E：没有有效 LAN 时不生成 localhost 二维码', async () => {
    const result = await getAccessQr(undefined, { Loopback: [iface('127.0.0.1', { internal: true })] }, 8787);
    expect(result.url).toBeNull();
    expect(result.dataUrl).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(result.message).toContain('局域网');
    expect(JSON.stringify(result)).not.toContain('localhost');
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
  });

  it('F：二维码 URL 不含 PIN、token 或 query', async () => {
    const result = await getAccessQr(undefined, { Ethernet: [iface('192.168.1.23')] }, 8787);
    expect(result.url).toBe('http://192.168.1.23:8787');
    expect(result.url).not.toMatch(/[?&]/);
    expect(result.url).not.toContain('pin');
    expect(result.url).not.toContain('token');
  });

  it('169.254 APIPA 被排除，family=4 也被识别', () => {
    expect(
      listLanIpv4Addresses({
        Apipa: [iface('169.254.12.3')],
        Wifi: [iface('192.168.0.5', { family: 4 })]
      })
    ).toEqual(['192.168.0.5']);
  });

  it('host 不在候选中返回 400', async () => {
    await expect(getAccessQr('10.0.0.9', { Ethernet: [iface('192.168.1.23')] }, 8787)).rejects.toMatchObject({
      statusCode: 400
    });
  });
});
