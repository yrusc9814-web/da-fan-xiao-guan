import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import CatalogPage from '../src/pages/CatalogPage.vue';

const recipeItems = [
  { id: 'recipe-1', name: '验收-番茄炒蛋', cookingTimeMinutes: 15, ingredients: [], favorite: false, version: 1 }
];
const toolItems = [
  { id: 'tool-1', name: '验收-不粘锅', category: '锅具', quantity: 2, status: 'AVAILABLE', version: 1 }
];

function jsonResponse(data: unknown) {
  return {
    ok: true,
    json: async () => ({ success: true, data, error: null })
  };
}

async function mountCatalogAcrossKinds() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/recipes', name: 'recipes', component: CatalogPage, props: { kind: 'recipes' } },
      { path: '/tools', name: 'tools', component: CatalogPage, props: { kind: 'tools' } },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
    ]
  });
  await router.push('/recipes');
  const fetchMock = vi
    .fn()
    .mockImplementation((input: unknown) =>
      Promise.resolve(jsonResponse(String(input).includes('/tools') ? toolItems : recipeItems))
    );
  vi.stubGlobal('fetch', fetchMock);
  // 通过 RouterView 挂载，路由 props(kind) 才会注入，且跨 kind 导航时复用同一实例
  const wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router, fetchMock };
}

function calledUrl(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): URL {
  return new URL(String(fetchMock.mock.calls[callIndex]?.[0]));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CatalogPage 同组件跨 kind 路由切换', () => {
  it('从 /recipes 搜索后切到 /tools 时重置搜索并重新加载工具数据', async () => {
    const { wrapper, router, fetchMock } = await mountCatalogAcrossKinds();

    expect(wrapper.get('h1').text()).toBe('我的菜谱');
    const searchInput = wrapper.find('input[placeholder="输入名称或关键词"]');
    await searchInput.setValue('番茄');
    await wrapper.findAll('.business-toolbar button')[0].trigger('click');
    await flushPromises();

    expect(calledUrl(fetchMock, 1).searchParams.get('search')).toBe('番茄');
    expect(wrapper.text()).toContain('验收-番茄炒蛋');

    await router.push('/tools');
    await flushPromises();

    expect(wrapper.get('h1').text()).toBe('厨房工具');
    const toolsUrl = calledUrl(fetchMock, 2);
    expect(toolsUrl.pathname).toContain('/api/v1/tools');
    expect(toolsUrl.searchParams.get('search')).toBeNull();
    expect((wrapper.find('input[placeholder="输入名称或关键词"]').element as HTMLInputElement).value).toBe('');
    expect(wrapper.text()).toContain('验收-不粘锅');
    expect(wrapper.text()).not.toContain('验收-番茄炒蛋');
  });

  it('首次挂载只加载一次，kind 未变化时不重复请求', async () => {
    const { wrapper, fetchMock } = await mountCatalogAcrossKinds();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calledUrl(fetchMock, 0).pathname).toContain('/api/v1/recipes');
    expect(wrapper.text()).toContain('验收-番茄炒蛋');
  });
});
