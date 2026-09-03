import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import ChefHubPage from '../src/pages/ChefHubPage.vue';
import JournalHubPage from '../src/pages/JournalHubPage.vue';
import MobileBottomNav from '../src/layouts/MobileBottomNav.vue';

const stub = { template: '<div />' };

async function createHubRouter(initialPath: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: stub },
      { path: '/chef', name: 'chef', component: ChefHubPage },
      { path: '/journal', name: 'journal', component: JournalHubPage },
      { path: '/recipes', name: 'recipes', component: stub },
      { path: '/recipes/new', name: 'recipe-new', component: stub },
      { path: '/inventory', name: 'inventory', component: stub },
      { path: '/tools', name: 'tools', component: stub },
      { path: '/shopping', name: 'shopping', component: stub },
      { path: '/plans', name: 'plans', component: stub },
      { path: '/calendar', name: 'calendar', component: stub },
      { path: '/statistics', name: 'statistics', component: stub },
      { path: '/records', name: 'records', component: stub },
      { path: '/diners', name: 'diners', component: stub },
      { path: '/discovery', name: 'discovery', component: stub },
      { path: '/:pathMatch(.*)*', component: stub }
    ]
  });
  await router.push(initialPath);
  const wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

function hubLinkTexts(wrapper: Awaited<ReturnType<typeof mount>>): Array<{ text: string; href: string }> {
  return wrapper.findAll('.hub-card').map((card) => ({
    text: card.text(),
    href: card.attributes('href') ?? ''
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('厨师 Hub（移动端一级入口 /chef 的路由可见内容）', () => {
  it('以「厨师」Hub 渲染并暴露核心厨房功能入口', async () => {
    const { wrapper } = await createHubRouter('/chef');
    const links = hubLinkTexts(wrapper);

    expect(wrapper.get('h1').text()).toBe('厨师');
    expect(links).toHaveLength(6);
    expect(links.map((entry) => entry.href)).toEqual([
      '/recipes',
      '/recipes/new',
      '/inventory',
      '/tools',
      '/inventory?panel=recommend',
      '/shopping'
    ]);
    expect(links[0]?.text).toContain('我的菜谱');
    expect(links[1]?.text).toContain('新增菜谱');
    expect(links[2]?.text).toContain('食材库存');
    expect(links[3]?.text).toContain('厨房工具');
    expect(links[4]?.text).toContain('库存推荐');
    expect(links[5]?.text).toContain('购物清单');
  });

  it('从厨师 Hub 出发普通用户可发现「新增菜谱」而不需要手输 /recipes/new', async () => {
    const { wrapper, router } = await createHubRouter('/chef');
    await wrapper.findAll('.hub-card')[1].trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.path).toBe('/recipes/new');
  });
});

describe('日记 Hub（移动端一级入口 /journal 的路由可见内容）', () => {
  it('以「日记」Hub 渲染并暴露记录与计划相关入口', async () => {
    const { wrapper } = await createHubRouter('/journal');
    const links = hubLinkTexts(wrapper);

    expect(wrapper.get('h1').text()).toBe('日记');
    expect(links).toHaveLength(6);
    expect(links.map((entry) => entry.href)).toEqual([
      '/records?mealType=DINNER',
      '/records',
      '/plans',
      '/calendar',
      '/statistics',
      '/diners'
    ]);
    expect(links[0]?.text).toContain('记录一餐');
    expect(links[1]?.text).toContain('饮食记录');
    expect(links[2]?.text).toContain('用餐计划');
    expect(links[3]?.text).toContain('饮食日历');
    expect(links[4]?.text).toContain('统计分析');
    expect(links[5]?.text).toContain('食用者');
  });
});

describe('移动端底部四栏导航保持 PRD 一级栏目', () => {
  it('仍为 首页/厨师/觅食/日记 四栏，且各自指向既有路由', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: stub },
        { path: '/chef', component: stub },
        { path: '/discovery', component: stub },
        { path: '/journal', component: stub }
      ]
    });
    await router.push('/');
    const wrapper = mount(MobileBottomNav, { global: { plugins: [router] } });

    const links = wrapper.findAll('.mobile-nav-link');
    expect(links.map((link) => link.attributes('href'))).toEqual(['/', '/chef', '/discovery', '/journal']);
    expect(links.map((link) => link.text().trim())).toEqual(['首页', '厨师', '觅食', '日记']);
  });
});
