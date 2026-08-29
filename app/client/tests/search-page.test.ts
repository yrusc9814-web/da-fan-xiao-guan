import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import SearchPage from '../src/pages/SearchPage.vue';

function jsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () =>
      ok
        ? { success: true, data, error: null }
        : { success: false, data: null, error: { code: 'INTERNAL_ERROR', message: String(data) } }
  };
}

/** fake timers 会劫持 setImmediate，flushPromises 会挂起；路由导航与渲染均为微任务，循环排空即可 */
async function drainMicrotasks(rounds = 50) {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve();
}

async function mountSearch(q = '') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/search', component: SearchPage }]
  });
  await router.push(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  const wrapper = mount(SearchPage, { global: { plugins: [router] } });
  await drainMicrotasks();
  return { wrapper, router };
}

/** submit 触发后组件同步发出 fetch；flushPromises 让路由同步与微任务链全部落定，再操作 resolver */
async function submit(wrapper: Awaited<ReturnType<typeof mountSearch>>['wrapper']) {
  await wrapper.get('form').trigger('submit');
  await flushPromises();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SearchPage 请求竞态', () => {
  it('A 先发 B 后发、B 先返回、A 后返回时最终显示 B', async () => {
    let resolveA: (value: unknown) => void = () => undefined;
    let resolveB: (value: unknown) => void = () => undefined;
    const fetchMock = vi.fn().mockImplementation((input: unknown) => {
      const q = new URL(String(input)).searchParams.get('q');
      if (q === '番') {
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      }
      return new Promise((resolve) => {
        resolveB = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper } = await mountSearch();
    const input = wrapper.find('input');
    await input.setValue('番');
    await submit(wrapper);
    expect(resolveA, '第一次 submit 后 fetch 应已发出').toBeTypeOf('function');
    await input.setValue('番茄');
    await submit(wrapper);
    expect(resolveB, '第二次 submit 后 fetch 应已发出').toBeTypeOf('function');
    resolveB!(jsonResponse({ recipes: [{ id: 'b', name: '番茄炒蛋' }], ingredients: [], stores: [], records: [] }));
    await flushPromises();
    expect(wrapper.text()).toContain('番茄炒蛋');
    resolveA!(jsonResponse({ recipes: [{ id: 'a', name: '番薯' }], ingredients: [], stores: [], records: [] }));
    await flushPromises();
    expect(wrapper.text()).toContain('番茄炒蛋');
    expect(wrapper.text()).not.toContain('番薯');
  });

  it('旧请求 error 不能覆盖新请求成功状态', async () => {
    let rejectA: (reason?: unknown) => void = () => undefined;
    let resolveB: (value: unknown) => void = () => undefined;
    const fetchMock = vi.fn().mockImplementation((input: unknown) => {
      const q = new URL(String(input)).searchParams.get('q');
      if (q === '番') {
        return new Promise((_resolve, reject) => {
          rejectA = reject;
        });
      }
      return new Promise((resolve) => {
        resolveB = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper } = await mountSearch();
    const input = wrapper.find('input');
    await input.setValue('番');
    await submit(wrapper);
    expect(rejectA, '第一次 submit 后 fetch 应已发出').toBeTypeOf('function');
    await input.setValue('番茄');
    await submit(wrapper);
    expect(resolveB, '第二次 submit 后 fetch 应已发出').toBeTypeOf('function');
    resolveB!(jsonResponse({ recipes: [{ id: 'b', name: '番茄炒蛋' }], ingredients: [], stores: [], records: [] }));
    await flushPromises();
    expect(wrapper.text()).toContain('番茄炒蛋');
    rejectA!(new Error('旧搜索失败'));
    await flushPromises();
    expect(wrapper.text()).toContain('番茄炒蛋');
    expect(wrapper.text()).not.toContain('搜索失败');
  });

  it('快速连续三次只认最新请求', async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const fetchMock = vi.fn().mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper } = await mountSearch();
    const input = wrapper.find('input');
    await input.setValue('一');
    await submit(wrapper);
    await input.setValue('二');
    await submit(wrapper);
    await input.setValue('三');
    await submit(wrapper);
    expect(resolvers, '三次 submit 应已发出三次 fetch').toHaveLength(3);
    resolvers[2]!(jsonResponse({ recipes: [{ id: 'c', name: '第三次' }], ingredients: [], stores: [], records: [] }));
    resolvers[0]!(jsonResponse({ recipes: [{ id: 'a', name: '第一次' }], ingredients: [], stores: [], records: [] }));
    resolvers[1]!(jsonResponse({ recipes: [{ id: 'b', name: '第二次' }], ingredients: [], stores: [], records: [] }));
    await flushPromises();
    expect(wrapper.text()).toContain('第三次');
    expect(wrapper.text()).not.toContain('第一次');
    expect(wrapper.text()).not.toContain('第二次');
  });

  it('清空关键词后立即复位状态，旧请求不能恢复旧结果', async () => {
    let resolveOld: (value: unknown) => void = () => undefined;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper } = await mountSearch();
    const input = wrapper.find('input');
    await input.setValue('番茄');
    await submit(wrapper);
    expect(resolveOld, 'submit 后 fetch 应已发出').toBeTypeOf('function');
    await input.setValue('');
    await submit(wrapper);
    // 清空分支：不作废在途请求的话骨架屏会永久卡住；这里断言三件事——
    // 1) 不在 loading（无骨架屏）；2) 结果已清空（显示空态文案）；
    // 3) 输入框保持清空（路由 watcher 没把旧关键词回写）
    expect(wrapper.find('.app-skeleton').exists()).toBe(false);
    expect(wrapper.text()).toContain('没有找到结果');
    expect((input.element as HTMLInputElement).value).toBe('');
    resolveOld!(jsonResponse({ recipes: [{ id: 'old', name: '旧番茄' }], ingredients: [], stores: [], records: [] }));
    await flushPromises();
    // 旧响应已被作废，不得复活旧结果、不得把页面拉回 loading
    expect(wrapper.text()).not.toContain('旧番茄');
    expect(wrapper.text()).toContain('没有找到结果');
    expect(wrapper.find('.app-skeleton').exists()).toBe(false);
  });
});

describe('SearchPage 输入防抖与路由同步', () => {
  it('输入过程中防抖 250ms 后只发一次请求', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper } = await mountSearch();
    const input = wrapper.find('input');
    await input.setValue('番');
    await input.setValue('茄');
    await input.setValue('番茄炒');
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock, '未满 250ms 不应发请求').not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchMock, '连续输入只应在防抖到期后发一次请求').toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('q')).toBe('番茄炒');
    wrapper.unmount();
  });

  it('输入后立即提交，防抖不会对同一关键词重复请求', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper } = await mountSearch();
    const input = wrapper.find('input');
    await input.setValue('番茄');
    await wrapper.get('form').trigger('submit');
    await drainMicrotasks();
    expect(fetchMock, 'submit 立即发一次请求').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock, '防抖到期时关键词已被 submit 处理过，不应重复请求').toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('程序性 replace 的 echo 不回写输入框也不触发重复搜索', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper } = await mountSearch();
    const input = wrapper.find('input');
    await input.setValue('番茄');
    await wrapper.get('form').trigger('submit');
    // replace 尚在途时用户已把输入改写成“番”
    await input.setValue('番');
    await drainMicrotasks();
    // replace 完成后路由变为 ?q=番茄，echo 必须被忽略：输入保持用户最新值，不重复搜索
    expect((input.element as HTMLInputElement).value).toBe('番');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 用户输入的“番”随后经防抖正常搜索
    await vi.advanceTimersByTimeAsync(250);
    await drainMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(url.searchParams.get('q')).toBe('番');
    expect((input.element as HTMLInputElement).value).toBe('番');
    wrapper.unmount();
  });

  it('外部导航（浏览器后退/前进）能正常更新关键词并重新搜索', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/search', component: SearchPage }]
    });
    // 预留一条搜索前历史：['/', '/search', '/search?q=seed']，后退/前进都是真实 POP 导航
    // （vue-router 对相同 location 的 push 是 duplicated failure，不会产生新条目）
    await router.push('/search');
    await router.push('/search?q=seed');
    const wrapper = mount(SearchPage, { global: { plugins: [router] } });
    await drainMicrotasks();
    const input = wrapper.find('input');
    await input.setValue('番茄');
    await wrapper.get('form').trigger('submit');
    await drainMicrotasks();
    expect((input.element as HTMLInputElement).value).toBe('番茄');
    expect(fetchMock).toHaveBeenCalledTimes(2); // mount 时 seed + submit 番茄
    await router.back();
    await drainMicrotasks();
    // 外部导航被正常处理：关键词清空、结果复位（空关键词不触发 fetch）
    expect((input.element as HTMLInputElement).value).toBe('');
    expect(wrapper.text()).toContain('没有找到结果');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await router.forward();
    await drainMicrotasks();
    // 前进回到 ?q=番茄：重新搜索而不是被当作 echo 吞掉
    expect((input.element as HTMLInputElement).value).toBe('番茄');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const url = new URL(String(fetchMock.mock.calls[2]?.[0]));
    expect(url.searchParams.get('q')).toBe('番茄');
    wrapper.unmount();
  });
});
