import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import RecordsPage from '../src/pages/RecordsPage.vue';

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ success: true, data, error: null }) };
}

function record(id: string, date = '2046-08-20') {
  return {
    id,
    recordDate: date,
    recordTime: '12:00',
    mealType: 'LUNCH',
    sourceType: 'CUSTOM',
    status: 'CONFIRMED',
    rating: null,
    favorite: false,
    notes: id,
    version: 1,
    items: [{ id: `${id}-item`, customName: id }]
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RecordsPage 分页与筛选', () => {
  it('第一页后加载更多无重复，筛选后回第一页', async () => {
    const page1 = Array.from({ length: 20 }, (_, index) => record(`r-${String(index + 1).padStart(2, '0')}`));
    const page2 = Array.from({ length: 5 }, (_, index) => record(`r-${String(index + 21).padStart(2, '0')}`));
    const fetchMock = vi.fn().mockImplementation((input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/recipes') || url.pathname.endsWith('/stores') || url.pathname.endsWith('/diners')) {
        return Promise.resolve(jsonResponse({ items: [] }));
      }
      const page = url.searchParams.get('page') ?? '1';
      const status = url.searchParams.get('status');
      if (status === 'DRAFT') {
        return Promise.resolve(
          jsonResponse({ items: [record('draft-1')], total: 1, page: 1, pageSize: 20, totalPages: 1 })
        );
      }
      if (page === '2') {
        return Promise.resolve(jsonResponse({ items: page2, total: 25, page: 2, pageSize: 20, totalPages: 2 }));
      }
      return Promise.resolve(jsonResponse({ items: page1, total: 25, page: 1, pageSize: 20, totalPages: 2 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/records', component: RecordsPage }]
    });
    await router.push('/records');
    const wrapper = mount(RecordsPage, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('r-01');
    expect(wrapper.text()).not.toContain('r-21');
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('加载更多'))!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('r-21');
    expect(wrapper.findAll('.business-card').length).toBeGreaterThanOrEqual(25);
    await wrapper.get('select').setValue('DRAFT');
    await wrapper.get('select').trigger('change');
    await flushPromises();
    expect(wrapper.text()).toContain('draft-1');
    expect(wrapper.text()).not.toContain('r-21');
  });

  it('加载更多失败后页码不前进，再次点击仍请求第二页而不是第三页', async () => {
    const page1 = Array.from({ length: 20 }, (_, index) => record(`r-${String(index + 1).padStart(2, '0')}`));
    const page2 = Array.from({ length: 5 }, (_, index) => record(`r-${String(index + 21).padStart(2, '0')}`));
    const requestedPages: string[] = [];
    let page2Failed = false;
    const fetchMock = vi.fn().mockImplementation((input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/recipes') || url.pathname.endsWith('/stores') || url.pathname.endsWith('/diners')) {
        return Promise.resolve(jsonResponse({ items: [] }));
      }
      const page = url.searchParams.get('page') ?? '1';
      requestedPages.push(page);
      if (page === '2' && !page2Failed) {
        page2Failed = true;
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({
            success: false,
            data: null,
            error: { code: 'INTERNAL_ERROR', message: '第二页加载失败' }
          })
        });
      }
      if (page === '2') {
        return Promise.resolve(jsonResponse({ items: page2, total: 25, page: 2, pageSize: 20, totalPages: 2 }));
      }
      return Promise.resolve(jsonResponse({ items: page1, total: 25, page: 1, pageSize: 20, totalPages: 2 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/records', component: RecordsPage }]
    });
    await router.push('/records');
    const wrapper = mount(RecordsPage, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('r-01');
    const loadMoreButton = () =>
      wrapper.findAll('button').find((button) => button.text().includes('加载更多')) as HTMLButtonElement;
    await loadMoreButton().trigger('click');
    await flushPromises();
    // 追加页失败：不弹全局错误、不清空已加载列表，“加载更多”按钮仍在原地
    expect(wrapper.text()).not.toContain('记录读取失败');
    expect(wrapper.text()).toContain('r-01');
    expect(wrapper.text()).not.toContain('r-21');
    // 再次点击重试：仍请求第 2 页（而不是跳到第 3 页），成功后追加数据
    await loadMoreButton().trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('r-21');
    expect(requestedPages).toEqual(['1', '2', '2']);
    expect(requestedPages).not.toContain('3');
  });
});
