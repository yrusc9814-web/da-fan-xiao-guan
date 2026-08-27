import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import RecommendationsPage from '../src/pages/RecommendationsPage.vue';

const diners = [
  { id: 'diner-1', name: '验收-张三' },
  { id: 'diner-2', name: '验收-李四' }
];

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data, error: null })
  };
}

function buildFetch() {
  return vi.fn().mockImplementation((input: unknown, _init?: { method?: string; body?: string }) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/diners')) return Promise.resolve(jsonResponse({ items: diners }));
    if (path.endsWith('/recommendations/random') || path.endsWith('/recommendations/meal-set'))
      return Promise.resolve(
        jsonResponse({
          historyId: 'history-1',
          results: [
            {
              resultType: 'RECIPE',
              resultId: 'recipe-1',
              title: '验收-测试菜',
              reason: '测试',
              missingIngredients: []
            }
          ]
        })
      );
    if (path.endsWith('/kitchen/recommend'))
      return Promise.resolve(jsonResponse({ mode: 'ALLOW_PURCHASE', candidateCount: 0, items: [] }));
    if (path.includes('/add-to-plan'))
      return Promise.resolve(jsonResponse({ plan: { id: 'plan-1' }, historyId: 'history-1' }));
    return Promise.resolve(jsonResponse({ items: [] }));
  });
}

async function mountAt(mode: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/recommendations', component: RecommendationsPage }]
  });
  await router.push(`/recommendations?mode=${mode}`);
  const fetchMock = buildFetch();
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(RecommendationsPage, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router, fetchMock };
}

function postBody(fetchMock: ReturnType<typeof vi.fn>, predicate: (path: string) => boolean) {
  const call = fetchMock.mock.calls.find(([input, init]) => {
    const url = new URL(String(input));
    return (init?.method ?? 'GET') === 'POST' && predicate(url.pathname);
  });
  expect(call, '未找到匹配的 POST 请求').toBeTruthy();
  return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('推荐页首页入口', () => {
  it.each([
    ['random', 'random'],
    ['meal-set', 'meal-set'],
    ['inventory', 'inventory']
  ])('mode=%s 初始化为对应推荐方式', async (query, expected) => {
    const { wrapper } = await mountAt(query);
    expect(wrapper.get('select').element.value).toBe(expected);
  });

  it('同组件 query 改变时同步模式，非法值回退 random', async () => {
    const { wrapper, router } = await mountAt('random');
    await router.push('/recommendations?mode=inventory');
    await flushPromises();
    expect(wrapper.get('select').element.value).toBe('inventory');
    await router.push('/recommendations?mode=invalid');
    await flushPromises();
    expect(wrapper.get('select').element.value).toBe('random');
  });
});

describe('推荐页食用者选择', () => {
  it('未选择食用者时如实提示不应用过滤，勾选后显示硬过滤文案', async () => {
    const { wrapper } = await mountAt('random');
    expect(wrapper.text()).toContain('验收-张三');
    expect(wrapper.text()).toContain('未选择食用者');
    expect(wrapper.text()).not.toContain('忌口和过敏始终硬过滤');
    await wrapper.findAll('input[type="checkbox"]')[0].setValue(true);
    await flushPromises();
    expect(wrapper.text()).toContain('忌口和过敏始终硬过滤');
    expect(wrapper.text()).not.toContain('未选择食用者');
  });

  it('生成推荐时把已勾选食用者传入请求 body', async () => {
    const { wrapper, fetchMock } = await mountAt('random');
    await wrapper.findAll('input[type="checkbox"]')[0].setValue(true);
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('生成推荐'))!
      .trigger('click');
    await flushPromises();
    const body = postBody(fetchMock, (path) => path.endsWith('/recommendations/random'));
    expect(body.dinerIds).toEqual([diners[0].id]);
    expect(body.mealType).toBe('DINNER');
  });

  it('库存推荐同样把已勾选食用者传入请求 body', async () => {
    const { wrapper, fetchMock } = await mountAt('inventory');
    await wrapper.findAll('input[type="checkbox"]')[1].setValue(true);
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('生成推荐'))!
      .trigger('click');
    await flushPromises();
    const body = postBody(fetchMock, (path) => path.endsWith('/kitchen/recommend'));
    expect(body.dinerIds).toEqual([diners[1].id]);
    expect(body.mode).toBe('ALLOW_PURCHASE');
  });

  it('加入计划时把已勾选食用者写入 add-to-plan 请求 body', async () => {
    const { wrapper, fetchMock } = await mountAt('random');
    await wrapper.findAll('input[type="checkbox"]')[0].setValue(true);
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('生成推荐'))!
      .trigger('click');
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('整组加入计划'))!
      .trigger('click');
    await flushPromises();
    const body = postBody(fetchMock, (path) => path.includes('/add-to-plan'));
    expect(body.dinerIds).toEqual([diners[0].id]);
  });
});
