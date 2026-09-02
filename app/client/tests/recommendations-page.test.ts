import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import RecommendationsPage, { pickDifferentCandidate, type SpinCandidate } from '../src/pages/RecommendationsPage.vue';

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
    if (path.endsWith('/shopping-lists') && (_init?.method ?? 'GET') === 'POST')
      return Promise.resolve(jsonResponse({ id: 'list-1', version: 1, items: [] }));
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

function candidate(id: string, name: string, enabled = true): SpinCandidate {
  return { id, name, enabledForRecommendation: enabled, version: 1 };
}

describe('「换一个」确定性兜底 pickDifferentCandidate', () => {
  it('2 候选（当前=A）：必返回 B，与概率无关', () => {
    const result = pickDifferentCandidate([candidate('a', '菜A'), candidate('b', '菜B')], 'a');
    expect(result).toEqual({ resultType: 'RECIPE', resultId: 'b', title: '菜B' });
  });

  it('多候选（当前=A）+ A 权重极高：仍保证返回非 A 候选', () => {
    // 候选池顺序模拟 A 优先（如带权排序），兜底逻辑必须无视顺序挑选非 A
    const pool = [candidate('a', '菜A'), candidate('b', '菜B'), candidate('c', '菜C'), candidate('d', '菜D')];
    const result = pickDifferentCandidate(pool, 'a');
    expect(result).toBeTruthy();
    expect(result!.resultId).not.toBe('a');
  });

  it('候选池只有 1 个（当前=A）：返回 null，语义为暂时没有别的候选', () => {
    expect(pickDifferentCandidate([candidate('a', '菜A')], 'a')).toBeNull();
  });

  it('当前结果不在候选池：任意启用候选都是不同结果，直接返回', () => {
    expect(pickDifferentCandidate([candidate('a', '菜A')], 'x')).toEqual({
      resultType: 'RECIPE',
      resultId: 'a',
      title: '菜A'
    });
  });

  it('停用（不参与推荐）的候选不计入可选池', () => {
    const pool = [candidate('a', '菜A'), candidate('b', '菜B', false)];
    expect(pickDifferentCandidate(pool, 'a')).toBeNull();
  });

  it('候选池为空：返回 null', () => {
    expect(pickDifferentCandidate([], 'a')).toBeNull();
  });
});

describe('「换一个」确定性接入转盘（不依赖随机）', () => {
  it('候选池 2 道菜、API 恒返回当前结果：点「换一个」必得另一道菜', async () => {
    // /recipes 返回 2 道启用候选；/recommendations/random 恒定返回 菜A（模拟权重极高）
    const alwaysA = vi.fn().mockImplementation((input: unknown) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/diners')) return Promise.resolve(jsonResponse({ items: diners }));
      if (path.endsWith('/recipes'))
        return Promise.resolve(
          jsonResponse({
            items: [
              { id: 'a', name: '菜A', enabledForRecommendation: true, version: 1 },
              { id: 'b', name: '菜B', enabledForRecommendation: true, version: 1 }
            ]
          })
        );
      if (path.endsWith('/recommendations/random'))
        return Promise.resolve(
          jsonResponse({
            historyId: 'history-a',
            results: [
              {
                resultType: 'RECIPE',
                resultId: 'a',
                title: '菜A',
                reason: '测试',
                missingIngredients: []
              }
            ]
          })
        );
      return Promise.resolve(jsonResponse({ items: [] }));
    });
    vi.stubGlobal('fetch', alwaysA);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/recommendations', component: RecommendationsPage }]
    });
    await router.push('/recommendations?mode=random');
    const wrapper = mount(RecommendationsPage, { global: { plugins: [router] } });
    await flushPromises();

    const clickButton = async (text: string) => {
      const btn = wrapper.findAll('button').find((b) => b.text().includes(text));
      expect(btn, `未找到按钮 ${text}`).toBeTruthy();
      await btn!.trigger('click');
    };

    // 1. 转一下：得到菜A
    await clickButton('转一下');
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 1200)); // 动画 600ms
    await flushPromises();
    expect(wrapper.find('.spin-wheel__item--result').text()).toBe('菜A');

    // 2. 换一个：API 4 次重试都返回菜A，必须走确定性兜底换成菜B
    await clickButton('换一个');
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 2600)); // 3 次重试延迟(200+300+400) + 动画 600ms
    await flushPromises();
    expect(wrapper.find('.spin-wheel__item--result').text()).toBe('菜B');

    // 3. 随机 API 调用计数：初次 1 次 + 换一个 4 次 = 5 次，全部返回菜A
    const randomPosts = alwaysA.mock.calls.filter(
      ([input, init]) => (init?.method ?? 'GET') === 'POST' && String(input).includes('/recommendations/random')
    );
    expect(randomPosts).toHaveLength(5);
  });

  it('候选池仅 1 道启用候选：点「换一个」明确提示没有别的候选', async () => {
    const single = vi.fn().mockImplementation((input: unknown) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/diners')) return Promise.resolve(jsonResponse({ items: diners }));
      if (path.endsWith('/recipes'))
        return Promise.resolve(
          jsonResponse({
            items: [{ id: 'a', name: '菜A', enabledForRecommendation: true, version: 1 }]
          })
        );
      if (path.endsWith('/recommendations/random'))
        return Promise.resolve(
          jsonResponse({
            historyId: 'history-a',
            results: [
              {
                resultType: 'RECIPE',
                resultId: 'a',
                title: '菜A',
                reason: '测试',
                missingIngredients: []
              }
            ]
          })
        );
      return Promise.resolve(jsonResponse({ items: [] }));
    });
    vi.stubGlobal('fetch', single);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/recommendations', component: RecommendationsPage }]
    });
    await router.push('/recommendations?mode=random');
    const wrapper = mount(RecommendationsPage, { global: { plugins: [router] } });
    await flushPromises();

    const clickButton = async (text: string) => {
      const btn = wrapper.findAll('button').find((b) => b.text().includes(text));
      expect(btn, `未找到按钮 ${text}`).toBeTruthy();
      await btn!.trigger('click');
    };

    await clickButton('转一下');
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await flushPromises();
    expect(wrapper.find('.spin-wheel__item--result').text()).toBe('菜A');

    await clickButton('换一个');
    await flushPromises();
    expect(wrapper.text()).toContain('候选池只有一道菜');
  });
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

  it('缺料加入购物清单一次 POST 全部 items，不循环逐条写入', async () => {
    const { wrapper, fetchMock } = await mountAt('random');
    fetchMock.mockImplementation((input: unknown, init?: { method?: string; body?: string }) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/diners')) return Promise.resolve(jsonResponse({ items: diners }));
      if (path.endsWith('/recommendations/random'))
        return Promise.resolve(
          jsonResponse({
            historyId: 'history-1',
            results: [
              {
                resultType: 'RECIPE',
                resultId: 'recipe-1',
                title: '验收-测试菜',
                reason: '测试',
                missingIngredients: ['番茄', '鸡蛋']
              }
            ]
          })
        );
      if (path.endsWith('/shopping-lists') && (init?.method ?? 'GET') === 'POST')
        return Promise.resolve(jsonResponse({ id: 'list-1', version: 1, items: [] }));
      return Promise.resolve(jsonResponse({ items: [] }));
    });
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('生成推荐'))!
      .trigger('click');
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('缺料加入购物清单'))!
      .trigger('click');
    await flushPromises();
    const shoppingPosts = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(String(input));
      return (init?.method ?? 'GET') === 'POST' && url.pathname.endsWith('/shopping-lists');
    });
    expect(shoppingPosts).toHaveLength(1);
    const body = JSON.parse((shoppingPosts[0][1] as RequestInit).body as string) as {
      items: Array<{ ingredientName: string }>;
    };
    expect(body.items.map((item) => item.ingredientName)).toEqual(['番茄', '鸡蛋']);
    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input).includes('/shopping-lists/') && String(input).includes('/items')
      )
    ).toBe(false);
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
