import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import RecipeDetailPage from '../src/pages/RecipeDetailPage.vue';

interface RecipeFixture {
  id: string;
  name: string;
  imagePath: string | null;
  cookingTimeMinutes: number | null;
  servings: number | null;
  favorite: boolean;
  ingredientsText: string | null;
  ingredients: Array<{
    id: string;
    ingredientNameSnapshot: string;
    quantity: number | null;
    unit: string | null;
    optional: boolean;
  }>;
  steps: Array<{ id: string; stepNo: number; content: string }>;
  tags: Array<{ tag: { id: string; name: string } }>;
  tools: Array<{ id: string; toolNameSnapshot: string; required: boolean }>;
}

function createRecipe(overrides: Partial<RecipeFixture> = {}): RecipeFixture {
  return {
    id: 'recipe-1',
    name: '验收-番茄炒蛋',
    imagePath: null,
    cookingTimeMinutes: 15,
    servings: 2,
    favorite: true,
    ingredientsText: null,
    ingredients: [
      { id: 'ing-1', ingredientNameSnapshot: '验收-番茄', quantity: 200, unit: 'GRAM', optional: false },
      { id: 'ing-2', ingredientNameSnapshot: '验收-鸡蛋', quantity: 3, unit: 'PIECE', optional: false },
      { id: 'ing-3', ingredientNameSnapshot: '验收-葱花', quantity: null, unit: null, optional: false }
    ],
    steps: [{ id: 'step-1', stepNo: 1, content: '验收-热锅冷油，先下蛋液。' }],
    tags: [{ tag: { id: 'tag-1', name: '家常菜' } }],
    tools: [{ id: 'tool-1', toolNameSnapshot: '不粘锅', required: true }],
    ...overrides
  };
}

async function mountDetailPage(recipe: RecipeFixture) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/recipes/:id', component: RecipeDetailPage },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
    ]
  });
  await router.push('/recipes/recipe-1');
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: recipe, error: null })
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(RecipeDetailPage, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return { wrapper, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('菜谱详情页', () => {
  it('按路由参数请求真实详情接口并渲染中文单位标签', async () => {
    const { wrapper, fetchMock } = await mountDetailPage(createRecipe());

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v1/recipes/recipe-1');
    expect(wrapper.findAll('ul li')).toHaveLength(3);
    expect(wrapper.text()).toContain('200 克');
    expect(wrapper.text()).toContain('3 个');
    expect(wrapper.text()).not.toContain('GRAM');
    expect(wrapper.text()).not.toContain('PIECE');
  });

  it('unit 为 null 的食材行保持空白，不出现「未设置」占位', async () => {
    const { wrapper } = await mountDetailPage(createRecipe());

    const row = wrapper.findAll('ul li').find((item) => item.text().includes('验收-葱花'));
    expect(row).toBeDefined();
    expect(row?.text()).toMatch(/^验收-葱花\s*$/);
    expect(row?.text()).not.toContain('未设置');
  });

  it('正常渲染标题、概览、步骤与工具等其他字段', async () => {
    const { wrapper } = await mountDetailPage(createRecipe());

    expect(wrapper.get('h1').text()).toContain('验收-番茄炒蛋');
    expect(wrapper.text()).toContain('15 分钟 · 2 份 · 已收藏');
    expect(wrapper.text()).toContain('工具：不粘锅');
    expect(wrapper.get('ol li').text()).toContain('验收-热锅冷油，先下蛋液。');
  });
});
