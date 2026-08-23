import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';

import AppButton from '../src/components/ui/AppButton.vue';
import AppDialog from '../src/components/ui/AppDialog.vue';
import DesktopSidebar from '../src/layouts/DesktopSidebar.vue';
import MobileBottomNav from '../src/layouts/MobileBottomNav.vue';
import PinGate from '../src/components/PinGate.vue';

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/recommendations', component: { template: '<div />' } },
    { path: '/recipes', component: { template: '<div />' } },
    { path: '/plans', component: { template: '<div />' } },
    { path: '/tools', component: { template: '<div />' } },
    { path: '/records', component: { template: '<div />' } },
    { path: '/inventory', component: { template: '<div />' } },
    { path: '/calendar', component: { template: '<div />' } },
    { path: '/statistics', component: { template: '<div />' } },
    { path: '/favorites', component: { template: '<div />' } },
    { path: '/shopping', component: { template: '<div />' } },
    { path: '/settings', component: { template: '<div />' } },
    { path: '/chef', component: { template: '<div />' } },
    { path: '/discovery', component: { template: '<div />' } },
    { path: '/journal', component: { template: '<div />' } }
  ]
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('layout navigation', () => {
  it('renders the desktop sidebar entries and highlights the current route', async () => {
    await router.push('/inventory');
    const wrapper = mount(DesktopSidebar, { global: { plugins: [router, createPinia()] } });

    expect(wrapper.find('[aria-label="桌面端主导航"]').exists()).toBe(true);
    expect(wrapper.findAll('.desktop-nav-link')).toHaveLength(12);
    expect(wrapper.find('.desktop-nav-link--active').text()).toContain('食材库存');
    expect(wrapper.find('.desktop-sidebar__tip').text()).toContain('搭饭小贴士');
    expect(wrapper.text()).not.toMatch(/会员专享|升级会员/);
  });

  it('renders the mobile bottom navigation with four entries', async () => {
    await router.push('/chef');
    const wrapper = mount(MobileBottomNav, { global: { plugins: [router] } });

    expect(wrapper.find('[aria-label="移动端主导航"]').exists()).toBe(true);
    expect(wrapper.findAll('.mobile-nav-link')).toHaveLength(4);
    expect(wrapper.find('.mobile-nav-link--active').text()).toContain('厨师');
  });
});

describe('public component states', () => {
  it('首次启动收集昵称和默认食用者后进入应用', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: { version: 1, pinEnabled: false, onboardingCompleted: false, userNickname: null },
          error: null
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: { version: 2, pinEnabled: false, onboardingCompleted: true, userNickname: '小饭' },
          error: null
        })
      });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(PinGate);
    await flushPromises();
    expect(wrapper.text()).toContain('欢迎来到搭饭小馆');
    const inputs = wrapper.findAll('input');
    await inputs[0]!.setValue('小饭');
    await inputs[1]!.setValue('我');
    await wrapper.get('button').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.findAll('button').at(-1)!.trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.findAll('button').at(-1)!.trigger('click');
    await flushPromises();
    expect(wrapper.emitted('unlocked')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('disables a loading button and exposes busy state', () => {
    const wrapper = mount(AppButton, { props: { loading: true }, slots: { default: '保存' } });

    expect(wrapper.get('button').attributes('disabled')).toBeDefined();
    expect(wrapper.get('button').attributes('aria-busy')).toBe('true');
  });

  it('opens and closes a dialog with Escape', async () => {
    const wrapper = mount(AppDialog, { attachTo: document.body, props: { modelValue: true, title: '测试弹窗' } });
    await wrapper.vm.$nextTick();

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false]);
    wrapper.unmount();
  });

});
