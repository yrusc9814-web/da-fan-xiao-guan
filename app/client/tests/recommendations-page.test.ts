import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import RecommendationsPage from '../src/pages/RecommendationsPage.vue';

async function mountAt(mode: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/recommendations', component: RecommendationsPage }]
  });
  await router.push(`/recommendations?mode=${mode}`);
  const wrapper = mount(RecommendationsPage, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

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
