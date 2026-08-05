import { createRouter, createWebHistory } from 'vue-router';

import HomePage from '../pages/HomePage.vue';
import PlaceholderPage from '../pages/PlaceholderPage.vue';

const placeholderRoutes = [
  { path: '/recommendations', name: 'recommendations', title: '菜谱推荐' },
  { path: '/records', name: 'records', title: '饮食记录' },
  { path: '/inventory', name: 'inventory', title: '食材库存' },
  { path: '/calendar', name: 'calendar', title: '饮食日历' },
  { path: '/statistics', name: 'statistics', title: '统计分析' },
  { path: '/favorites', name: 'favorites', title: '收藏夹' },
  { path: '/shopping', name: 'shopping', title: '购物清单' },
  { path: '/settings', name: 'settings', title: '设置' },
  { path: '/chef', name: 'chef', title: '厨师' },
  { path: '/discovery', name: 'discovery', title: '觅食' },
  { path: '/journal', name: 'journal', title: '日记' }
];

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomePage, meta: { title: '首页' } },
    ...placeholderRoutes.map((route) => ({
      ...route,
      component: PlaceholderPage,
      meta: { title: route.title }
    }))
  ]
});

export default router;
