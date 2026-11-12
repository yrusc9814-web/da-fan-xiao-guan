import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapter = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n;\n');
const markup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
const dto = (x: Record<string, unknown> = {}) => ({
  id: 'r1',
  name: '菜谱',
  category: null,
  cookingTimeMinutes: 20,
  difficulty: '简单',
  calories: null,
  ingredients: [],
  steps: [],
  tags: [],
  mealTypes: [],
  mealRoles: [],
  tools: [],
  version: 3,
  ...x
});
const response = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () =>
    JSON.stringify(status >= 200 && status < 300 ? { success: true, data } : { success: false, error: data })
});
function boot(fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>) {
  document.body.innerHTML = markup;
  const f = vi.fn(fetchImpl);
  vi.stubGlobal('fetch', f);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  Object.defineProperty(Element.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent || '';
    },
    set(v) {
      this.textContent = v;
    }
  });
  window.eval(scripts);
  window.eval(adapter);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
describe('recipe save contract at production handler', () => {
  it('PUT sends scalar nulls and full relations through real form handler', async () => {
    const f = boot(async (u, i) =>
      i?.method === 'PUT' ? response(dto()) : response({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 })
    );
    const r = (window as any).DafanDomainAdapter.mapRecipe(
      dto({
        ingredientsText: '旧文本',
        sourceNote: '来源',
        tags: [{ tag: { name: '快手' } }],
        tools: [{ toolId: 't1', tool: { name: '锅' }, required: false }]
      })
    );
    (window as any).BentoService.recipes.data = [r];
    await (window as any).BentoModal.open('recipeForm', 'r1');
    await (window as any).BentoModal.handleRecipeFormSubmit({
      preventDefault: vi.fn(),
      currentTarget: document.querySelector('#modalRecipeForm form')
    });
    const save = f.mock.calls.find(
      ([u, i]) => String(u).includes('/recipes/r1') && (i as RequestInit)?.method === 'PUT'
    );
    expect(save).toBeTruthy();
    expect(JSON.parse((save![1] as RequestInit).body as string)).toMatchObject({
      category: null,
      ingredientsText: '旧文本',
      sourceNote: '来源',
      toolIds: [{ toolId: 't1', name: '锅', required: false }]
    });
  });
  it('真实409保留scoped表单、error toast、modal不关闭；恢复后重试真实成功且success toast出现', async () => {
    let puts = 0;
    const toasts: any[] = [];
    boot(async (u, i) =>
      String(u).includes('/recipes/r1') && i?.method === 'PUT'
        ? response(
            ++puts === 1 ? { code: 'VERSION_CONFLICT', message: '版本冲突' } : dto({ version: 4 }),
            puts === 1 ? 409 : 200
          )
        : response({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 })
    );
    vi.stubGlobal('showToast', (message: string, type: string) => toasts.push({ message, type }));
    const r = (window as any).DafanDomainAdapter.mapRecipe(dto({ name: '保留字段' }));
    (window as any).BentoService.recipes.data = [r];
    await (window as any).BentoModal.open('recipeForm', 'r1');
    const modal = document.getElementById('modalRecipeForm')!,
      form = modal.querySelector('form') as HTMLFormElement,
      name = modal.querySelector('#formRecipeName') as HTMLInputElement,
      button = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    name.value = '用户修改后仍保留';
    const event = { preventDefault: vi.fn(), currentTarget: form, submitter: button };
    await (window as any).BentoModal.handleRecipeFormSubmit(event);
    expect(puts).toBe(1);
    expect(modal.classList.contains('hidden')).toBe(false);
    expect(name.value).toBe('用户修改后仍保留');
    expect(button.disabled).toBe(false);
    expect(toasts.some((x) => x.type === 'error' && /冲突/.test(x.message))).toBe(true);
    expect(toasts.some((x) => x.type === 'success')).toBe(false);
    await (window as any).BentoModal.handleRecipeFormSubmit(event);
    expect(puts).toBe(2);
    expect(toasts.some((x) => x.type === 'success')).toBe(true);
  });
});
