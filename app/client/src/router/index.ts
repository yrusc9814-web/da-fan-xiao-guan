import { createRouter, createWebHistory } from 'vue-router';

import HomePage from '../pages/HomePage.vue';
import CatalogPage from '../pages/CatalogPage.vue';
import FavoritesPage from '../pages/FavoritesPage.vue';
import CalendarPage from '../pages/CalendarPage.vue';
import BackupPage from '../pages/BackupPage.vue';
import InventoryPage from '../pages/InventoryPage.vue';
import MealPlansPage from '../pages/MealPlansPage.vue';
import RecordsPage from '../pages/RecordsPage.vue';
import RecommendationsPage from '../pages/RecommendationsPage.vue';
import RecipeEditorPage from '../pages/RecipeEditorPage.vue';
import ShoppingPage from '../pages/ShoppingPage.vue';
import SearchPage from '../pages/SearchPage.vue';
import SettingsPage from '../pages/SettingsPage.vue';
import StatisticsPage from '../pages/StatisticsPage.vue';
import DeletedItemsPage from '../pages/DeletedItemsPage.vue';
import PlaceholderPage from '../pages/PlaceholderPage.vue';
import RecipeDetailPage from '../pages/RecipeDetailPage.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomePage, meta: { title: '首页' } },
    {
      path: '/recipes',
      name: 'recipes',
      component: CatalogPage,
      props: { kind: 'recipes' },
      meta: { title: '我的菜谱' }
    },
    { path: '/recipes/new', name: 'recipe-new', component: RecipeEditorPage, meta: { title: '新增菜谱' } },
    { path: '/recipes/:id', name: 'recipe-detail', component: RecipeDetailPage, meta: { title: '菜谱详情' } },
    { path: '/recipes/:id/edit', name: 'recipe-edit', component: RecipeEditorPage, meta: { title: '编辑菜谱' } },
    { path: '/complete-meal', name: 'complete-meal', component: PlaceholderPage, meta: { title: '完成一餐' } },
    { path: '/inventory', name: 'inventory', component: InventoryPage, meta: { title: '食材库存' } },
    { path: '/chef', name: 'chef', component: InventoryPage, meta: { title: '厨师' } },
    {
      path: '/discovery',
      name: 'discovery',
      component: CatalogPage,
      props: { kind: 'stores' },
      meta: { title: '觅食' }
    },
    { path: '/diners', name: 'diners', component: CatalogPage, props: { kind: 'diners' }, meta: { title: '食用者' } },
    { path: '/tools', name: 'tools', component: CatalogPage, props: { kind: 'tools' }, meta: { title: '厨房工具' } },
    { path: '/plans', name: 'plans', component: MealPlansPage, meta: { title: '饮食计划' } },
    { path: '/recommendations', name: 'recommendations', component: RecommendationsPage, meta: { title: '菜谱推荐' } },
    { path: '/records', name: 'records', component: RecordsPage, meta: { title: '饮食记录' } },
    { path: '/journal', name: 'journal', component: RecordsPage, meta: { title: '日记' } },
    { path: '/calendar', name: 'calendar', component: CalendarPage, meta: { title: '饮食日历' } },
    { path: '/statistics', name: 'statistics', component: StatisticsPage, meta: { title: '统计分析' } },
    { path: '/shopping', name: 'shopping', component: ShoppingPage, meta: { title: '购物清单' } },
    { path: '/settings', name: 'settings', component: SettingsPage, meta: { title: '设置' } },
    {
      path: '/settings/deleted-items',
      name: 'deleted-items',
      component: DeletedItemsPage,
      meta: { title: '最近删除' }
    },
    { path: '/backup', name: 'backup', component: BackupPage, meta: { title: '备份与恢复' } },
    { path: '/favorites', name: 'favorites', component: FavoritesPage, meta: { title: '收藏夹' } },
    { path: '/search', name: 'search', component: SearchPage, meta: { title: '全局搜索' } }
  ]
});

export default router;
