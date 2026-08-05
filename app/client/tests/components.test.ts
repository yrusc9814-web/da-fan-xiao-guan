import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';

import AppButton from '../src/components/ui/AppButton.vue';
import AppDialog from '../src/components/ui/AppDialog.vue';
import AppDrawer from '../src/components/ui/AppDrawer.vue';
import DesktopSidebar from '../src/layouts/DesktopSidebar.vue';
import MobileBottomNav from '../src/layouts/MobileBottomNav.vue';

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/recommendations', component: { template: '<div />' } },
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
});

describe('layout navigation', () => {
  it('renders the desktop sidebar entries and highlights the current route', async () => {
    await router.push('/inventory');
    const wrapper = mount(DesktopSidebar, { global: { plugins: [router] } });

    expect(wrapper.find('[aria-label="桌面端主导航"]').exists()).toBe(true);
    expect(wrapper.findAll('.desktop-nav-link')).toHaveLength(9);
    expect(wrapper.find('.desktop-nav-link--active').text()).toContain('食材库存');
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

  it('closes a drawer with Escape', async () => {
    const wrapper = mount(AppDrawer, { attachTo: document.body, props: { modelValue: true, title: '测试抽屉' } });
    await wrapper.vm.$nextTick();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false]);
    wrapper.unmount();
  });
});
