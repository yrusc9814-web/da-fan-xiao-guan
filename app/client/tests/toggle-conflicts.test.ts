import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import CatalogPage from '../src/pages/CatalogPage.vue';
import ShoppingPage from '../src/pages/ShoppingPage.vue';

function okResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data, error: null })
  };
}

function conflictResponse(message: string) {
  return {
    ok: false,
    status: 409,
    json: async () => ({ success: false, data: null, error: { code: 'VERSION_CONFLICT', message } })
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ShoppingPage 购物清单连续勾选（C-01）', () => {
  it('第一项请求未返回前勾选第二项时，串行发送且第二个 PUT 使用最新 version，两项最终都成功、无 409 横幅', async () => {
    const state = {
      id: 'list-1',
      name: '本周采购',
      status: 'ACTIVE',
      notes: null,
      version: 5,
      items: [
        { id: 'item-a', ingredientNameSnapshot: '番茄', quantity: 2, unit: 'PIECE', completed: false, notes: null },
        { id: 'item-b', ingredientNameSnapshot: '鸡蛋', quantity: 1, unit: 'KILOGRAM', completed: false, notes: null }
      ]
    };

    let releaseFirstPut: (() => void) | null = null;
    const firstPutGate = new Promise<void>((resolve) => {
      releaseFirstPut = resolve;
    });
    let putCount = 0;

    const fetchMock = vi.fn().mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      if (init?.method === 'PUT') {
        putCount += 1;
        const body = JSON.parse(init.body ?? '{}') as { version: number; completed: boolean };
        if (body.version !== state.version) return conflictResponse(`版本冲突：期望 ${state.version}`);
        const itemId = url.split('/').pop();
        const target = state.items.find((entry) => entry.id === itemId);
        if (!target) return conflictResponse('清单项目不存在');
        target.completed = body.completed;
        state.version += 1;
        const snapshot = JSON.parse(JSON.stringify(state));
        if (putCount === 1) await firstPutGate; // 模拟慢网络：第一个 PUT 挂起，让第二次点击先发生
        return okResponse(snapshot);
      }
      return okResponse([JSON.parse(JSON.stringify(state))]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(ShoppingPage);
    await flushPromises();

    const checkboxes = wrapper.findAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);

    // 快速连续勾选：第一项请求仍挂起时就勾选第二项
    await checkboxes[0].trigger('change');
    await checkboxes[1].trigger('change');
    releaseFirstPut!();
    await flushPromises();

    const putCalls = fetchMock.mock.calls.filter(([, init]) => (init as { method?: string }).method === 'PUT');
    expect(putCalls).toHaveLength(2);
    // 第二个 PUT 必须携带第一个 PUT 成功后的最新 version，而不是过期的 5
    expect(JSON.parse((putCalls[0][1] as { body: string }).body).version).toBe(5);
    expect(JSON.parse((putCalls[1][1] as { body: string }).body).version).toBe(6);
    expect(wrapper.find('.business-conflict').exists()).toBe(false);

    const finalCheckboxes = wrapper.findAll('input[type="checkbox"]');
    expect(finalCheckboxes[0].element.checked).toBe(true);
    expect(finalCheckboxes[1].element.checked).toBe(true);
  });

  it('服务端真正返回 409 时仍然展示冲突横幅', async () => {
    const state = {
      id: 'list-1',
      name: '本周采购',
      status: 'ACTIVE',
      notes: null,
      version: 5,
      items: [
        { id: 'item-a', ingredientNameSnapshot: '番茄', quantity: 2, unit: 'PIECE', completed: false, notes: null }
      ]
    };
    const fetchMock = vi.fn().mockImplementation((input: unknown, init?: { method?: string }) => {
      if (init?.method === 'PUT') return conflictResponse('数据已被其他设备修改');
      return okResponse([JSON.parse(JSON.stringify(state))]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(ShoppingPage);
    await flushPromises();
    await wrapper.findAll('input[type="checkbox"]')[0].trigger('change');
    await flushPromises();

    expect(wrapper.find('.business-conflict').exists()).toBe(true);
    expect(wrapper.text()).toContain('数据已被其他设备修改');
  });
});

describe('CatalogPage 收藏双击保护（C-02）', () => {
  it('请求进行中双击爱心不会发出第二次收藏请求，成功后无 409 横幅且爱心更新为实心', async () => {
    const state = {
      id: 'recipe-1',
      name: '验收-番茄炒蛋',
      cookingTimeMinutes: 15,
      ingredients: [] as unknown[],
      favorite: false,
      version: 1
    };
    let releaseFavorite: (() => void) | null = null;
    const favoriteGate = new Promise<void>((resolve) => {
      releaseFavorite = resolve;
    });

    const fetchMock = vi.fn().mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        await favoriteGate; // 模拟慢网络：收藏请求挂起期间接收第二次点击
        const body = JSON.parse(init.body ?? '{}') as { favorite: boolean };
        state.favorite = body.favorite;
        state.version += 1;
        return okResponse({ ...state });
      }
      return okResponse([{ ...state }]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/recipes', name: 'recipes', component: CatalogPage, props: { kind: 'recipes' } },
        { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
      ]
    });
    await router.push('/recipes');
    const wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router] } });
    await flushPromises();

    const heart = wrapper.get('.business-favorite');
    await heart.trigger('click');
    await heart.trigger('click'); // 第一次请求仍未返回时的重复点击
    releaseFavorite!();
    await flushPromises();

    const postCalls = fetchMock.mock.calls.filter(([, init]) => (init as { method?: string }).method === 'POST');
    expect(postCalls).toHaveLength(1);
    expect(JSON.parse((postCalls[0][1] as { body: string }).body)).toEqual({ favorite: true, version: 1 });
    expect(wrapper.find('.business-conflict').exists()).toBe(false);
    expect(wrapper.get('.business-favorite').text()).toBe('♥');
  });

  it('真正的失败（非重复点击导致）仍正确提示错误', async () => {
    const recipe = {
      id: 'recipe-1',
      name: '验收-番茄炒蛋',
      cookingTimeMinutes: 15,
      ingredients: [] as unknown[],
      favorite: false,
      version: 1
    };
    const fetchMock = vi.fn().mockImplementation((input: unknown, init?: { method?: string }) => {
      if (init?.method === 'POST') return conflictResponse('数据已被其他设备修改');
      return okResponse([recipe]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/recipes', name: 'recipes', component: CatalogPage, props: { kind: 'recipes' } },
        { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
      ]
    });
    await router.push('/recipes');
    const wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('.business-favorite').trigger('click');
    await flushPromises();

    expect(wrapper.find('.business-conflict').exists()).toBe(true);
    expect(wrapper.text()).toContain('数据已被其他设备修改');
  });
});
