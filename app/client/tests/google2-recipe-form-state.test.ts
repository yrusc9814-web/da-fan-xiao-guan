import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapter = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n;\n');
const markup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
const response = (data: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ success: true, data })
});
const dto = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  name: '旧菜',
  category: null,
  cookingTimeMinutes: null,
  difficulty: null,
  calories: null,
  imagePath: null,
  ingredients: [],
  steps: [],
  tags: [],
  mealTypes: [],
  mealRoles: [],
  tools: [],
  version: 1,
  ...overrides
});

function boot() {
  document.body.innerHTML = markup;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return response(dto({ id: 'new-r', version: 1 }));
    return response({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 });
  });
  vi.stubGlobal('fetch', fetchMock);
  window.eval(scripts);
  window.eval(adapter);
  return fetchMock;
}
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const submit = () => (window as any).BentoModal.handleRecipeFormSubmit({ preventDefault: vi.fn() });

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent ?? '';
    },
    set(value) {
      this.textContent = value;
    }
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('recipe form real markup/state', () => {
  it('新建保留自由用量、独立标题/描述，timer 0 与空值分别保真', () => {
    boot();
    (window as any).BentoModal.setupRecipeForm(null);
    input('formRecipeName').value = '新菜';
    input('formRecipeTime').value = '35';
    input('formRecipeCalories').value = '';
    const ing = document.querySelector('.recipe-ing-row')!;
    (ing.querySelector('.recipe-ing-name') as HTMLInputElement).value = '面粉';
    (ing.querySelector('.recipe-ing-amount') as HTMLInputElement).value = '一大勺';
    const step = document.querySelector('.recipe-step-row')!;
    (step.querySelector('.recipe-step-title') as HTMLInputElement).value = '拌匀';
    (step.querySelector('.recipe-step-desc') as HTMLTextAreaElement).value = '慢慢加入';
    (step.querySelector('.recipe-step-timer') as HTMLInputElement).value = '0';
    expect(input('formRecipeTime').value).toBe('35');
    expect((step.querySelector('.recipe-step-timer') as HTMLInputElement).value).toBe('0');
    expect((window as any).DafanDomainAdapter.mapRecipe(dto({ cookingTimeMinutes: null })).category).toBeNull();
  });

  it('编辑 historical null/0 与 unknown category 回填不改写，difficulty/calories 空白保真', () => {
    boot();
    const mapped = (window as any).DafanDomainAdapter.mapRecipe(
      dto({ category: '未知分类', cookingTimeMinutes: 0, difficulty: null, calories: null })
    );
    (window as any).BentoService.recipes.data = [mapped];
    (window as any).BentoModal.setupRecipeForm(mapped);
    expect(input('formRecipeTime').value).toBe('0');
    expect(input('formRecipeCalories').value).toBe('');
    expect(input('formRecipeDifficulty').value).toBe('');
    expect(input('formRecipeCategory').dataset.valueState).toBe('unrepresentable');
  });

  it('真实 submit 保留食材 flags、步骤 title/content/imagePath/timer 与 tool required=false', async () => {
    const fetchMock = boot();
    const source = dto({
      cookingTimeMinutes: 42,
      ingredients: [
        {
          id: 'i1',
          ingredientId: 'i1',
          ingredientNameSnapshot: '盐',
          quantity: 2,
          unit: 'GRAM',
          optional: true,
          isPrimary: true,
          amountText: '两克'
        }
      ],
      steps: [{ id: 's1', stepNo: 1, title: '拌匀', content: '慢慢加入', timerMinutes: 0, imagePath: '/step.jpg' }],
      tools: [{ toolId: 't1', tool: { id: 't1', name: '锅' }, required: false }]
    });
    const mapped = (window as any).DafanDomainAdapter.mapRecipe(source);
    (window as any).BentoService.recipes.data = [mapped];
    (window as any).BentoModal.setupRecipeForm(mapped);
    input('formRecipeName').value = '提交保真';
    await submit();
    const save = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/recipes/r1') && (init as RequestInit)?.method === 'PUT'
    );
    expect(save).toBeTruthy();
    const body = JSON.parse((save![1] as RequestInit).body as string);
    expect(body.ingredients).toEqual([
      { ingredientId: 'i1', name: '盐', quantity: 2, unit: 'GRAM', amountText: '两克', optional: true, isPrimary: true }
    ]);
    expect(body.steps).toEqual([{ content: '慢慢加入', title: '拌匀', timerMinutes: 0, imagePath: '/step.jpg' }]);
    expect(body.toolIds).toEqual([{ toolId: 't1', name: '锅', required: false }]);
  });

  it('动态行保留 metadata，改名后关联脱离且步骤 imagePath 保留', () => {
    boot();
    const mapped = (window as any).DafanDomainAdapter.mapRecipe(
      dto({
        ingredients: [
          { id: 'i1', ingredientNameSnapshot: '盐', quantity: 2, unit: 'GRAM', optional: true, isPrimary: true }
        ],
        steps: [{ id: 's1', stepNo: 1, content: '煮', imagePath: '/step.jpg' }]
      })
    );
    (window as any).BentoService.recipes.data = [mapped];
    (window as any).BentoModal.setupRecipeForm(mapped);
    const row = document.querySelector('.recipe-ing-row')!;
    // 行自身 ID 与库存 ingredientId 分键保存：无库存关联的快照行只有行 ID（ingredientRowId），
    // dataset.ingredientId 只承载真实库存关联，绝不混入行 ID
    expect((row as HTMLElement).dataset.ingredientRowId).toBe('i1');
    expect((row as HTMLElement).dataset.ingredientId).toBeUndefined();
    expect((row as HTMLElement).dataset.quantity).toBe('2');
    expect((row as HTMLElement).dataset.unit).toBe('GRAM');
    expect((row as HTMLElement).dataset.optional).toBe('true');
    expect((row as HTMLElement).dataset.isPrimary).toBe('true');
    expect((row.querySelector('.recipe-ing-amount') as HTMLInputElement).value).toBe('2g');
    (row.querySelector('.recipe-ing-name') as HTMLInputElement).value = '新盐';
    expect((row as HTMLElement).dataset.originalName).toBe('盐');
    const stepRow = document.querySelector('.recipe-step-row') as HTMLElement;
    expect((stepRow.querySelector('.recipe-step-title') as HTMLInputElement).value).toBe('');
    expect((stepRow.querySelector('.recipe-step-desc') as HTMLTextAreaElement).value).toBe('煮');
    expect((stepRow.querySelector('.recipe-step-timer') as HTMLInputElement).value).toBe('');
    expect(stepRow.dataset.imagePath).toBe('/step.jpg');
  });

  it('新建时间空/0拒绝提交，编辑合法范围允许 0', async () => {
    const fetchMock = boot();
    (window as any).BentoModal.setupRecipeForm(null);
    input('formRecipeName').value = '新';
    await submit();
    input('formRecipeTime').value = '0';
    await submit();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url).includes('/recipes') && (init as RequestInit)?.method === 'POST'
      )
    ).toHaveLength(0);
    const mapped = (window as any).DafanDomainAdapter.mapRecipe(dto({ cookingTimeMinutes: 0 }));
    (window as any).BentoService.recipes.data = [mapped];
    (window as any).BentoModal.setupRecipeForm(mapped);
    input('formRecipeName').value = '编辑';
    await submit();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/recipes/r1'))).toHaveLength(1);
  });
});
