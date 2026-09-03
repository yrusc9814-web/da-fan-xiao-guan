import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';

import SettingsPage from '../src/pages/SettingsPage.vue';
import BackupPage from '../src/pages/BackupPage.vue';
import DeletedItemsPage from '../src/pages/DeletedItemsPage.vue';
import StatisticsPage from '../src/pages/StatisticsPage.vue';
import PinGate from '../src/components/PinGate.vue';

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ success: true, data, error: null }) };
}

// 测试关注点是「用户可见语言」：页面不得再向普通用户暴露实现细节
// （SQLite、端口、SHA/staging/hash、内部枚举等），全部用产品语言描述。
const forbiddenOnScreens = [
  'SQLite',
  '8787',
  'SHA256',
  'SHA-256',
  'staging',
  'hash',
  'Hash',
  '原子',
  'runtime',
  'Local settings',
  'Backup & restore',
  'First setup',
  'HOMEMADE',
  '端口'
];

function expectNoDeveloperCopy(wrapper: { text(): string }) {
  const text = wrapper.text();
  for (const term of forbiddenOnScreens) {
    expect(text, `页面不应出现实现术语“${term}”`).not.toContain(term);
  }
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('SettingsPage 用户语言', () => {
  it('首屏用产品语言呈现，并给备份恢复与回收站清晰入口', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 1,
        appName: '搭饭小馆',
        subtitle: '让每一餐都更美好',
        userNickname: '小饭',
        autoBackupEnabled: true,
        autoDeductInventory: true,
        defaultRepeatDays: 7,
        onboardingCompleted: true,
        pinEnabled: false,
        version: 1
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings', component: SettingsPage },
        { path: '/backup', component: { template: '<div />' } },
        { path: '/settings/deleted-items', component: { template: '<div />' } },
        { path: '/diners', component: { template: '<div />' } }
      ]
    });
    await router.push('/settings');
    const wrapper = mount(SettingsPage, { global: { plugins: [router, createPinia()] } });
    await flushPromises();

    expect(wrapper.text()).toContain('系统设置');
    expect(wrapper.text()).toContain('数据备份与恢复');
    expect(wrapper.text()).toContain('备份与恢复');
    expect(wrapper.text()).toContain('访问 PIN');
    expect(wrapper.text()).toContain('最近删除');
    // 备份与恢复入口必须真实指向既有 /backup 路由
    const backupLink = wrapper.findAll('a').find((a) => a.text().includes('备份与恢复'));
    expect(backupLink?.attributes('href')).toBe('/backup');
    const deletedLink = wrapper.findAll('a').find((a) => a.text().includes('回收站'));
    expect(deletedLink?.attributes('href')).toBe('/settings/deleted-items');

    expectNoDeveloperCopy(wrapper);
  });
});

describe('BackupPage 用户语言', () => {
  it('备份与恢复描述只讲备份内容和安全结果，不讲实现细节', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ pinEnabled: false }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(BackupPage);
    await flushPromises();

    expect(wrapper.text()).toContain('备份与恢复');
    expect(wrapper.text()).toContain('导出备份');
    expect(wrapper.text()).toContain('校验并恢复');
    // 用户语言：备份内容与安全说明
    expect(wrapper.text()).toContain('菜谱、库存、记录、图片和设置');
    expect(wrapper.text()).toContain('现有数据不受影响');
    expectNoDeveloperCopy(wrapper);

    // 「恢复前二次验证」对话框在恢复授权时才打开；AppDialog 传送到 body
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, 'files', { value: [new File(['zip'], 'backup.zip')] });
    await input.trigger('change');
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('校验并恢复'))!
      .trigger('click');
    await flushPromises();

    expect(document.body.textContent).toContain('恢复前二次验证');
    expect(document.body.textContent).toContain('回退');
    expectNoDeveloperCopy({ text: () => `${wrapper.text()}${document.body.textContent ?? ''}` });
  });

  it('恢复成功后明确提示「恢复成功 + 需要重新验证」，且不含实现词', async () => {
    const filePayload = new File(['zip'], 'backup.zip');
    const fetchMock = vi.fn().mockImplementation((input: unknown, init?: { method?: string }) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.pathname.endsWith('/settings/high-risk/authorize')) {
        return Promise.resolve(jsonResponse({ token: 'auth-token' }));
      }
      if (method === 'POST' && url.pathname.endsWith('/backups/restore')) {
        return Promise.resolve(jsonResponse({ restored: true }));
      }
      return Promise.resolve(jsonResponse({ pinEnabled: false }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(BackupPage);
    await flushPromises();

    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, 'files', { value: [filePayload] });
    await input.trigger('change');
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('校验并恢复'))!
      .trigger('click');
    await flushPromises();
    // 无 PIN 时走确认勾选路径
    const confirmLabel = document.body.querySelector('.backup-confirmation') as HTMLLabelElement;
    expect(confirmLabel).not.toBeNull();
    const checkbox = confirmLabel.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.click();
    await wrapper.vm.$nextTick();
    await [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('二次验证并恢复'))!.click();
    await flushPromises();

    // 恢复成功后用户必须看到「数据已恢复」和「需要重新验证」的业务解释
    expect(wrapper.text()).toContain('数据已恢复');
    expect(wrapper.text()).toContain('重新验证');
    const visibleText = `${wrapper.text()}${document.body.textContent ?? ''}`;
    for (const term of ['token', 'Token', 'session', 'Session', 'SQLite', 'SHA', 'staging', 'hash', 'Hash']) {
      expect(visibleText, `恢复成功提示不应出现实现词“${term}”`).not.toContain(term);
    }
  });
});

describe('DeletedItemsPage 用户语言', () => {
  it('恢复结果描述用产品语言，并按类型显示中文标签', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'del-1',
            entityType: 'Recipe',
            entityId: 'r1',
            name: '红烧肉',
            deletedAt: '2046-08-01T10:00:00.000Z',
            expiresAt: '2046-08-31T10:00:00.000Z'
          },
          {
            id: 'del-2',
            entityType: 'Ingredient',
            entityId: 'i1',
            name: '番茄',
            deletedAt: '2046-08-02T10:00:00.000Z',
            expiresAt: null
          }
        ])
      )
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(DeletedItemsPage);
    await flushPromises();

    expect(wrapper.text()).toContain('红烧肉');
    expect(wrapper.text()).toContain('菜谱');
    expect(wrapper.text()).toContain('番茄');
    expect(wrapper.text()).toContain('食材');
    expect(wrapper.text()).toContain('可恢复至');
    expectNoDeveloperCopy(wrapper);

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('恢复'))!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('已恢复“红烧肉”');
  });
});

describe('StatisticsPage 用户语言', () => {
  it('来源分布显示中文标签而不是内部枚举', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        period: { start: '2046-08-01', end: '2046-08-31' },
        totalRecords: 2,
        recordedDays: 2,
        totalMeals: 2,
        newTryCount: 0,
        favoriteCount: 1,
        averageRating: 4.5,
        sourceBreakdown: { HOMEMADE: 2 },
        mealTypeDistribution: { DINNER: 2 },
        topRecipes: [],
        topStores: [],
        shoppingCompletionRate: null
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/statistics', component: StatisticsPage }]
    });
    await router.push('/statistics');
    const wrapper = mount(StatisticsPage, { global: { plugins: [router, createPinia()] } });
    await flushPromises();

    expect(wrapper.text()).toContain('统计分析');
    expect(wrapper.text()).toContain('在家做：2');
    expect(wrapper.text()).not.toContain('HOMEMADE');
    expectNoDeveloperCopy(wrapper);
  });
});

describe('PinGate 首次配置与 PIN 门禁用户语言', () => {
  it('首次设置不出现端口、头像路径等实现信息', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ version: 1, pinEnabled: false, onboardingCompleted: false, userNickname: null })
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(PinGate);
    await flushPromises();

    expect(wrapper.text()).toContain('欢迎来到搭饭小馆');
    expect(wrapper.text()).toContain('首次设置');
    expectNoDeveloperCopy(wrapper);
  });

  it('PIN 门禁只要求输入 PIN，不解释存储与验证机制', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ version: 2, pinEnabled: true, onboardingCompleted: true, userNickname: '小饭' })
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(PinGate);
    await flushPromises();

    expect(wrapper.text()).toContain('请输入访问 PIN');
    expectNoDeveloperCopy(wrapper);
  });
});
