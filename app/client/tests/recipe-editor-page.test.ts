import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import RecipeEditorPage from '../src/pages/RecipeEditorPage.vue';

function createFixture(overrides: Record<string, unknown> = {}) {
  const ingredients = [
    {
      id: 'ri-1',
      ingredientId: 'ing-1',
      ingredientName: '验收-编辑模式番茄',
      ingredientNameSnapshot: '验收-编辑模式番茄',
      quantity: 200,
      unit: 'GRAM',
      optional: false,
      isPrimary: true,
      sortOrder: 0
    }
  ];
  return {
    id: 'recipe-1',
    name: '验收-编辑模式菜谱',
    version: 3,
    cookingTimeMinutes: 15,
    servings: 2,
    spicyLevel: 1,
    favorite: false,
    enabledForRecommendation: true,
    imagePath: null,
    difficulty: null,
    sourceNote: null,
    notes: null,
    mealTypes: ['DINNER'],
    mealRoles: ['MAIN'],
    tags: [],
    ingredients,
    steps: [{ id: 'step-1', stepNo: 1, content: '验收-步骤' }],
    tools: [],
    ...overrides
  };
}

const inventoryIngredient = {
  id: 'ing-2',
  name: '验收-库存鸡蛋',
  quantity: 12,
  unit: 'PIECE',
  status: 'NORMAL',
  batches: [],
  version: 1
};

interface MountResult {
  wrapper: ReturnType<typeof mount>;
  fetchMock: ReturnType<typeof vi.fn>;
}

async function mountEditor({
  routePath = '/recipes/new',
  recipe = null,
  tools = [],
  inventory = [inventoryIngredient]
}: {
  routePath?: string;
  recipe?: Record<string, unknown> | null;
  tools?: Array<{ id: string; name: string }>;
  inventory?: Array<Record<string, unknown>>;
} = {}): Promise<MountResult> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/recipes/new', component: RecipeEditorPage },
      { path: '/recipes/:id/edit', component: RecipeEditorPage },
      { path: '/recipes', component: { template: '<div />' } },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
    ]
  });
  await router.push(routePath);
  await router.isReady();

  const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> | null = null;
    if (url.includes('/api/v1/recipes/recipe-1') && (!init || init.method === 'GET' || !init.method)) {
      body = { success: true, data: recipe, error: null };
    } else if (url.includes('/api/v1/recipes') && init?.method === 'POST') {
      body = { success: true, data: { id: 'recipe-new-1' }, error: null };
    } else if (url.includes('/api/v1/recipes') && init?.method === 'PUT') {
      body = { success: true, data: { ...recipe, ...JSON.parse(String(init.body)) }, error: null };
    } else if (url.includes('/api/v1/tools')) {
      body = { success: true, data: tools, error: null };
    } else if (url.includes('/api/v1/ingredients')) {
      body = { success: true, data: inventory, error: null };
    } else {
      body = { success: true, data: null, error: null };
    }
    return {
      ok: true,
      json: async () => body
    };
  });
  vi.stubGlobal('fetch', fetchMock);

  const wrapper = mount(RecipeEditorPage, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return { wrapper, fetchMock };
}

function saveCall(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.find(
    (call) => String(call[0]).includes('/api/v1/recipes') && (call[1]?.method === 'POST' || call[1]?.method === 'PUT')
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('菜谱编辑页库存关联', () => {
  it('编辑模式回填已关联库存食材并原样保存 ingredientId 与名称', async () => {
    const recipe = createFixture();
    const { wrapper, fetchMock } = await mountEditor({ routePath: '/recipes/recipe-1/edit', recipe });

    const rows = wrapper.findAll('.ingredient-row');
    expect(rows).toHaveLength(1);
    const select = rows[0].find('select');
    expect((select.element as HTMLSelectElement).value).toBe('ing-1');
    expect(wrapper.text()).not.toContain('未关联库存食材（做饭消耗不会自动扣减库存）');
    expect(rows[0].find('.ingredient-row__hint').exists()).toBe(false);

    await wrapper.get('button.app-button--primary').trigger('click');
    await flushPromises();

    const call = saveCall(fetchMock);
    expect(call).toBeDefined();
    expect(call![1].method).toBe('PUT');
    const body = JSON.parse(String(call![1].body));
    expect(body.ingredients).toHaveLength(1);
    expect(body.ingredients[0].ingredientId).toBe('ing-1');
    expect(body.ingredients[0].ingredientName).toBe('验收-编辑模式番茄');
  });

  it('选择库存食材后提交的食材行携带对应 ingredientId 与名称', async () => {
    const { wrapper, fetchMock } = await mountEditor({});

    await wrapper.findAll('input[type="text"]')[0].setValue('验收-选择食材菜谱');
    const row = wrapper.get('.ingredient-row');
    const nameInput = row.find('input[type="text"]');
    await nameInput.setValue('临时名称');
    const select = row.find('select');
    await select.setValue('ing-2');
    expect((select.element as HTMLSelectElement).value).toBe('ing-2');
    const nameInputAfter = row.find('input[type="text"]');
    expect((nameInputAfter.element as HTMLInputElement).value).toBe('验收-库存鸡蛋');

    await wrapper.get('button.app-button--primary').trigger('click');
    await flushPromises();

    const call = saveCall(fetchMock);
    expect(call).toBeDefined();
    expect(call![1].method).toBe('POST');
    const body = JSON.parse(String(call![1].body));
    expect(body.ingredients).toHaveLength(1);
    expect(body.ingredients[0].ingredientId).toBe('ing-2');
    expect(body.ingredients[0].ingredientName).toBe('验收-库存鸡蛋');
  });

  it('新增行未选择库存食材时显示未关联提示，保存的食材行不带 ingredientId', async () => {
    const { wrapper, fetchMock } = await mountEditor({});

    await wrapper.findAll('input[type="text"]')[0].setValue('验收-未关联菜谱');
    const row = wrapper.get('.ingredient-row');
    await row.find('input[type="text"]').setValue('验收-手动录入食材');
    expect(wrapper.text()).toContain('未关联库存食材（做饭消耗不会自动扣减库存）');

    await wrapper.get('button.app-button--primary').trigger('click');
    await flushPromises();

    const call = saveCall(fetchMock);
    expect(call).toBeDefined();
    expect(call![1].method).toBe('POST');
    const body = JSON.parse(String(call![1].body));
    expect(body.ingredients).toHaveLength(1);
    expect(body.ingredients[0].ingredientId).toBeNull();
    expect(body.ingredients[0].ingredientName).toBe('验收-手动录入食材');
  });

  it('搜索词过滤库存食材下拉只显示匹配项，选择后提交正确 ingredientId，搜索不存在词不改变已有关联', async () => {
    const { wrapper, fetchMock } = await mountEditor({
      inventory: [
        { id: 'ing-search-a', name: '验收-搜索番茄', quantity: 3, unit: 'PIECE' },
        { id: 'ing-search-b', name: '验收-搜索鸡蛋', quantity: 6, unit: 'PIECE' },
        { id: 'ing-search-c', name: '验收-搜索土豆', quantity: 5, unit: 'PIECE' }
      ]
    });

    await wrapper.findAll('input[type="text"]')[0].setValue('验收-搜索菜谱');
    const row = wrapper.get('.ingredient-row');

    // 输入搜索词后，下拉只显示匹配项（不含不匹配的鸡蛋/土豆）
    const searchInput = row.find('input[type="search"]');
    await searchInput.setValue('番茄');
    const select = row.find('select');
    const selectableTexts = select
      .findAll('option')
      .filter((option) => option.attributes('value'))
      .map((option) => option.text());
    expect(selectableTexts).toEqual(['验收-搜索番茄（3 个）']);

    // 选择匹配项后，名称自动带出，提交时携带正确 ingredientId
    await select.setValue('ing-search-a');
    expect((select.element as HTMLSelectElement).value).toBe('ing-search-a');
    const nameInput = row.find('input[type="text"]');
    expect((nameInput.element as HTMLInputElement).value).toBe('验收-搜索番茄');

    // 搜索不存在的词：已选中项仍保留并正确显示，不自动清空
    await searchInput.setValue('不存在的东西');
    expect((select.element as HTMLSelectElement).value).toBe('ing-search-a');
    expect(wrapper.text()).toContain('验收-搜索番茄');

    await wrapper.get('button.app-button--primary').trigger('click');
    await flushPromises();

    const call = saveCall(fetchMock);
    expect(call).toBeDefined();
    expect(call![1].method).toBe('POST');
    const body = JSON.parse(String(call![1].body));
    expect(body.ingredients).toHaveLength(1);
    expect(body.ingredients[0].ingredientId).toBe('ing-search-a');
    expect(body.ingredients[0].ingredientName).toBe('验收-搜索番茄');
  });

  it('编辑模式中已软删的原关联食材不回填时保留原值，提示重新选择', async () => {
    const recipe = createFixture({
      ingredients: [
        {
          id: 'ri-1',
          ingredientId: 'ing-deleted-1',
          ingredientName: '验收-已删除食材',
          ingredientNameSnapshot: '验收-已删除食材',
          quantity: 100,
          unit: 'GRAM',
          optional: false,
          isPrimary: true,
          sortOrder: 0
        }
      ]
    });
    const { wrapper, fetchMock } = await mountEditor({
      routePath: '/recipes/recipe-1/edit',
      recipe,
      inventory: []
    });

    const row = wrapper.get('.ingredient-row');
    const select = row.find('select');
    expect((select.element as HTMLSelectElement).value).toBe('ing-deleted-1');
    expect(wrapper.text()).toContain('原关联食材已删除');
    const nameInput = row.find('input[type="text"]');
    expect((nameInput.element as HTMLInputElement).value).toBe('验收-已删除食材');

    await wrapper.get('button.app-button--primary').trigger('click');
    await flushPromises();

    const call = saveCall(fetchMock);
    expect(call).toBeDefined();
    const body = JSON.parse(String(call![1].body));
    expect(body.ingredients[0].ingredientId).toBe('ing-deleted-1');
    expect(body.ingredients[0].ingredientName).toBe('验收-已删除食材');
  });
});
