import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import HomePage from '../src/pages/HomePage.vue';
import { fetchDashboard, setPinToken } from '../src/services/api';
import type { DashboardDto } from '../../shared/types/dashboard';

function createDashboard(overrides: Partial<DashboardDto> = {}): DashboardDto {
  return {
    generatedAt: '2026-08-06T00:00:00.000Z',
    branding: { appName: '搭饭小馆', subtitle: '让每一餐都更美好' },
    userNickname: '厨房伙伴',
    currentDate: '2026-08-06',
    greetingPeriod: 'afternoon',
    greetingText: '忙碌之中，也别忘了好好吃饭～',
    recommendedRecipes: Array.from({ length: 6 }, (_, index) => ({
      id: `recipe-${index}`,
      name: `演示菜谱${index + 1}`,
      imagePath: 'tomato-eggs.svg',
      cookingTimeMinutes: 15,
      tags: ['家常菜'],
      rating: 4.6
    })),
    todayRecords: [
      {
        mealType: 'BREAKFAST',
        label: '早餐',
        time: '08:00',
        recorded: true,
        title: '番茄炒蛋',
        summary: '在家制作',
        rating: 4.6
      },
      { mealType: 'LUNCH', label: '午餐', time: null, recorded: false, title: null, summary: null, rating: null },
      { mealType: 'DINNER', label: '晚餐', time: null, recorded: false, title: null, summary: null, rating: null }
    ],
    inventory: {
      totalIngredients: 4,
      expiringSoon: 1,
      insufficient: 1,
      expiringIngredients: [
        { id: 'ingredient-1', name: '西兰花', expiryDate: '2026-08-08', quantity: 1, unit: 'PIECE' }
      ]
    },
    weeklyStats: { recordedDays: 2, totalMeals: 3, averageRating: 4.6, consumedIngredientCount: 2 },
    calendarDays: Array.from({ length: 7 }, (_, index) => ({
      date: `2026-08-${String(index + 3).padStart(2, '0')}`,
      weekday: ['一', '二', '三', '四', '五', '六', '日'][index] ?? '',
      dayOfMonth: index + 3,
      isToday: index === 3,
      status: index === 3 ? 'recorded' : 'empty'
    })),
    tip: '优先消耗即将到期的食材，让每一份新鲜都不被浪费。',
    ...overrides
  };
}

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
  });
}

async function mountHomepage(data: DashboardDto | null = createDashboard()) {
  const router = createTestRouter();
  await router.push('/');
  const healthPayload = {
    success: true,
    data: {
      status: 'ok',
      app: '搭饭小馆',
      version: '0.1.0',
      database: { status: 'ok', provider: 'sqlite' },
      timestamp: new Date().toISOString()
    },
    error: null
  };
  const dashboardPayload = { success: true, data, error: null };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          String(input).includes('/health')
            ? healthPayload
            : String(input).includes('/calendar')
              ? {
                  success: true,
                  data: {
                    start: '2026-08-10',
                    end: '2026-08-16',
                    days: [{ date: '2026-08-10', hasPlans: false, hasRecords: true, hasDrafts: false }]
                  },
                  error: null
                }
              : dashboardPayload
      })
    )
  );
  const wrapper = mount(HomePage, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  setPinToken(null);
  vi.unstubAllGlobals();
});

describe('正式首页结构', () => {
  it('Dashboard 请求沿用统一客户端并携带 PIN 会话', async () => {
    setPinToken('test-pin-session');
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ success: true, data: createDashboard(), error: null }) });
    vi.stubGlobal('fetch', fetchMock);
    await fetchDashboard();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-App-Pin-Token': 'test-pin-session' });
  });
  it('按桌面顺序渲染 Hero、快捷入口、推荐、三列信息和日历', async () => {
    const wrapper = await mountHomepage();
    const directChildren = Array.from(wrapper.get('.homepage').element.children).map((element) => element.className);

    expect(directChildren).toEqual([
      'home-hero',
      'quick-actions',
      'homepage-section homepage-section--recommendations',
      'dashboard-info-grid',
      'homepage-section calendar-section',
      'app-card app-card--flat homepage-tip'
    ]);
    expect(wrapper.findAll('.today-records-card')).toHaveLength(1);
  });

  it('渲染四个快捷入口和最多六张推荐卡片', async () => {
    const wrapper = await mountHomepage();

    expect(wrapper.findAll('.quick-action-card')).toHaveLength(4);
    expect(wrapper.findAll('.recipe-card')).toHaveLength(6);
    expect(wrapper.find('.recipe-scroller').exists()).toBe(true);
    expect(wrapper.get('.recipe-card').attributes('href')).toBe('/recipes/recipe-0');
  });

  it('使用 Dashboard 的动态问候和用户昵称', async () => {
    const wrapper = await mountHomepage(
      createDashboard({ greetingPeriod: 'morning', greetingText: '今天也要好好吃饭呀～', userNickname: '小厨房' })
    );

    expect(wrapper.get('h1').text()).toContain('早上好，小厨房');
    expect(wrapper.text()).toContain('今天也要好好吃饭呀～');
  });

  it('Dashboard 推荐为空时显示真实空状态', async () => {
    const wrapper = await mountHomepage(createDashboard({ recommendedRecipes: [] }));

    expect(wrapper.find('.recipe-scroller').exists()).toBe(false);
    expect(wrapper.text()).toContain('还没有推荐菜谱');
  });

  it('Dashboard 请求失败时显示错误状态', async () => {
    const router = createTestRouter();
    await router.push('/');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('网络不可用')));
    const wrapper = mount(HomePage, { global: { plugins: [createPinia(), router] } });
    await flushPromises();

    expect(wrapper.text()).toContain('首页数据暂时不可用');
    expect(wrapper.text()).toContain('网络不可用');
  });

  it('切换周时读取真实 calendar API，不伪造平移后的空数据', async () => {
    const wrapper = await mountHomepage();
    await wrapper.get('button[aria-label="下一周"]').trigger('click');
    await flushPromises();
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/calendar?start=2026-08-10&end=2026-08-16'))
    ).toBe(true);
    expect(wrapper.find('.calendar-day[data-status="recorded"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('8/10');
  });
});
