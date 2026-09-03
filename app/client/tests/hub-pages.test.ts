import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MobileBottomNav from '../src/layouts/MobileBottomNav.vue';
import productionRouter from '../src/router';
import { setPinToken } from '../src/services/api';

let mounted: VueWrapper[] = [];

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: async () => ({ success: true, data, error: null }) });
}

/**
 * 统一 fetch 桩：覆盖深链回归时各业务页 onMounted 的首屏请求。
 * 只需成功且形状合法，页面渲染出真实标题即可，不校验业务数据。
 */
function stubAllApis() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard')) return jsonOk(null);
      if (url.includes('/statistics'))
        return jsonOk({
          period: { start: '2026-09-01', end: '2026-09-30' },
          totalRecords: 0,
          recordedDays: 0,
          totalMeals: 0,
          newTryCount: 0,
          favoriteCount: 0,
          averageRating: null,
          sourceBreakdown: {},
          mealTypeDistribution: {},
          topRecipes: [],
          topStores: [],
          shoppingCompletionRate: null
        });
      if (url.includes('/records')) return jsonOk({ items: [], total: 0 });
      if (url.includes('/calendar')) return jsonOk({ days: [] });
      return jsonOk([]);
    })
  );
}

async function mountAt(path: string) {
  stubAllApis();
  await productionRouter.push(path);
  await productionRouter.isReady();
  const wrapper = mount(
    { template: '<RouterView />' },
    {
      global: { plugins: [productionRouter, createPinia()] }
    }
  );
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

function hubLinkHrefs(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.hub-card').map((card) => card.attributes('href') ?? '');
}

afterEach(async () => {
  setPinToken(null);
  for (const wrapper of mounted) wrapper.unmount();
  mounted = [];
  vi.unstubAllGlobals();
});

describe('生产路由接入：/chef 与 /journal 渲染 Hub（A/B）', () => {
  it('/chef 渲染厨师 Hub 而不是食材库存页', async () => {
    const wrapper = await mountAt('/chef');

    expect(productionRouter.currentRoute.value.name).toBe('chef');
    expect(wrapper.get('h1').text()).toBe('厨师');
    expect(wrapper.find('.hub-grid').exists()).toBe(true);
    // 旧 /chef 直达库存页的标记（新增食材按钮 + 批次工具条）不应出现
    expect(wrapper.find('.business-toolbar').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('冰箱还是空的');
  });

  it('/journal 渲染日记 Hub 而不是饮食记录页', async () => {
    const wrapper = await mountAt('/journal');

    expect(productionRouter.currentRoute.value.name).toBe('journal');
    expect(wrapper.get('h1').text()).toBe('日记');
    expect(wrapper.find('.hub-grid').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('饮食日记');
  });
});

describe('Hub 二级入口指向真实业务路由（C/D/E）', () => {
  it('厨师 Hub 暴露 我的菜谱/新增菜谱/食材库存/厨房工具/库存推荐/购物清单', async () => {
    const wrapper = await mountAt('/chef');

    expect(hubLinkHrefs(wrapper)).toEqual([
      '/recipes',
      '/recipes/new',
      '/inventory',
      '/tools',
      '/inventory?panel=recommend',
      '/shopping'
    ]);
  });

  it('日记 Hub 暴露 记录一餐/饮食记录/用餐计划/饮食日历/统计分析/食用者', async () => {
    const wrapper = await mountAt('/journal');

    expect(hubLinkHrefs(wrapper)).toEqual([
      '/records?mealType=DINNER',
      '/records',
      '/plans',
      '/calendar',
      '/statistics',
      '/diners'
    ]);
  });

  it('普通用户可从 首页→厨师→我的菜谱→新增一道菜 走通而不手输 URL', async () => {
    await mountAt('/chef');
    await productionRouter.push('/recipes');
    await flushPromises();
    expect(productionRouter.currentRoute.value.path).toBe('/recipes');

    await productionRouter.push('/recipes/new');
    await flushPromises();
    expect(productionRouter.currentRoute.value.path).toBe('/recipes/new');
    expect(productionRouter.currentRoute.value.name).toBe('recipe-new');
  });

  it('日记 Hub 的记录/日历/计划/统计入口全部可达', async () => {
    await mountAt('/journal');

    for (const path of ['/records', '/calendar', '/plans', '/statistics']) {
      await productionRouter.push(path);
      await flushPromises();
      expect(productionRouter.currentRoute.value.path).toBe(path);
    }
  });
});

describe('已有深链不被破坏（F）', () => {
  it('inventory/records/calendar/plans/statistics/shopping/tools/recipes 仍直达各自页面', async () => {
    const cases: Array<[string, string]> = [
      ['/inventory', '食材库存'],
      ['/records', '饮食日记'],
      ['/calendar', '饮食日历'],
      ['/plans', '饮食计划'],
      ['/statistics', '统计分析'],
      ['/shopping', '购物清单'],
      ['/tools', '厨房工具'],
      ['/recipes', '我的菜谱']
    ];
    for (const [path, heading] of cases) {
      const wrapper = await mountAt(path);
      expect(productionRouter.currentRoute.value.path).toBe(path);
      expect(wrapper.get('h1').text()).toBe(heading);
    }
  });
});

describe('移动端底栏与 Hub 的导航关系（G）', () => {
  it('生产路由仍注册 首页/厨师/觅食/日记 四个一级路径', () => {
    const paths = productionRouter.getRoutes().map((route) => route.path);
    for (const required of ['/', '/chef', '/discovery', '/journal']) {
      expect(paths).toContain(required);
    }
  });

  it('在 /chef、/journal 上底栏「厨师」「日记」高亮 active', async () => {
    stubAllApis();
    for (const [path, label] of [
      ['/chef', '厨师'],
      ['/journal', '日记']
    ] as const) {
      await productionRouter.push(path);
      await productionRouter.isReady();
      const wrapper = mount(MobileBottomNav, { global: { plugins: [productionRouter, createPinia()] } });
      mounted.push(wrapper);
      expect(wrapper.find('.mobile-nav-link--active').text()).toContain(label);
    }
  });
});
