import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type Ingredient = {
  id?: string;
  ingredientId: string | null;
  ingredientNameSnapshot?: string;
  name?: string;
  quantity?: number | null;
  unit?: string | null;
  amountText?: string | null;
  optional: boolean;
  isPrimary: boolean;
};
type Step = { title: string | null; content: string; timerMinutes?: number | null };
type Recipe = { id: string; name: string; ingredients: Ingredient[]; steps: Step[]; version: number };
type Payload = { name: string; ingredients: Ingredient[]; steps: Step[]; version?: number };
type Frontend = Window &
  typeof globalThis & {
    DafanDomainAdapter: { mapRecipe(dto: Recipe): Recipe };
    BentoService: { recipes: { data: Recipe[]; getByIdRemote(id: string): Promise<Recipe> } };
    BentoModal: {
      setupRecipeDetail(id: string): void;
      setupRecipeForm(dto?: Recipe): void;
      handleRecipeFormSubmit(event: { preventDefault(): void }): Promise<unknown>;
    };
    renderRecipes(): void;
    addRecipeIngRow(name?: string, amount?: string): void;
    addRecipeStepRow(title?: string, content?: string, timer?: string): void;
    __p1Injected?: number;
  };
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string, options: Record<string, unknown>) => { window: Frontend };
};
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const adapter = readFileSync(resolve(process.cwd(), 'public/google2-adapter.js'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n;\n');
const windows: Frontend[] = [];
const dto = (ingredients: Ingredient[] = [], steps: Step[] = []): Recipe => ({
  id: 'r1',
  name: '测试菜',
  ingredients,
  steps,
  version: 1
});
function backend(initial?: Recipe) {
  let stored = initial;
  const writes: Array<{ method: string; payload: Payload }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url, 'http://localhost').pathname;
    let data: unknown = { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 };
    if (path.startsWith('/api/v1/recipes')) {
      if (method === 'POST' || method === 'PUT') {
        const payload = JSON.parse(String(init?.body)) as Payload;
        writes.push({ method, payload });
        stored = {
          ...payload,
          id: 'r1',
          version: (stored?.version ?? 0) + 1,
          ingredients: payload.ingredients.map(({ name, ...i }, index) => ({
            ...i,
            id: `row-${index}`,
            ingredientNameSnapshot: name
          })),
          steps: payload.steps.map((s, index) => ({ ...s, id: `step-${index}`, stepNo: index + 1 }))
        };
        data = stored;
      } else
        data =
          path === '/api/v1/recipes'
            ? { items: stored ? [stored] : [], page: 1, pageSize: 100, total: stored ? 1 : 0, totalPages: 1 }
            : stored;
    }
    return {
      ok: true,
      status: method === 'POST' ? 201 : 200,
      text: async () => JSON.stringify({ success: true, data })
    };
  };
  return {
    writes,
    fetchImpl,
    get: () => {
      if (!stored) throw new Error('Recipe was not saved');
      return stored;
    }
  };
}
async function boot(api: ReturnType<typeof backend>) {
  const w = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''), {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  }).window;
  windows.push(w);
  w.fetch = api.fetchImpl as unknown as typeof fetch;
  w.HTMLCanvasElement.prototype.getContext = () => null;
  Object.defineProperty(w.Element.prototype, 'innerText', {
    configurable: true,
    get(this: Element) {
      return this.textContent || '';
    },
    set(this: Element, value: string) {
      this.textContent = value;
    }
  });
  w.eval(scripts);
  w.eval(adapter);
  await new Promise<void>((done) => w.document.addEventListener('DOMContentLoaded', () => done(), { once: true }));
  const field = (selector: string) => {
    const e = w.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (!e) throw new Error(`Missing form field ${selector}`);
    return e;
  };
  const open = async () => {
    const mapped = await w.BentoService.recipes.getByIdRemote('r1');
    w.renderRecipes();
    expect(
      w.document.querySelectorAll('#recipesCardGrid [data-p1-injected], #recipesCardGrid img, #recipesCardGrid script')
        .length
    ).toBe(0);
    expect(w.document.querySelector('[data-recipe-ingredient-summary]')?.textContent).toContain(
      mapped.ingredients.map((i) => i.name).join('、')
    );
    w.BentoModal.setupRecipeDetail(mapped.id);
    expect(
      w.document.querySelectorAll(
        '#modalRecipeDetail [data-p1-injected], #modalRecipeDetail img, #modalRecipeDetail script'
      ).length
    ).toBe(0);
    expect(w.__p1Injected).toBeUndefined();
    w.BentoModal.setupRecipeForm(mapped);
  };
  const save = async () => {
    const count = api.writes.length;
    await w.BentoModal.handleRecipeFormSubmit({ preventDefault() {} });
    expect(api.writes.length).toBe(count + 1);
    return api.writes.at(-1)!.payload;
  };
  return { w, field, open, save };
}
afterEach(() => {
  for (const w of windows.splice(0)) w.close();
});
const special = [
  { name: '低钠"盐"', amount: '1量勺（标记"A"）', title: '炒至"断生"', content: '炒至"断生"' },
  { name: "厨师'盐 < > & 中文", amount: "半勺' < > & 中文", title: "步骤' < > & 中文", content: "做法' < > & 中文" },
  {
    name: '"><img data-p1-injected src=x onerror="window.__p1Injected=1">',
    amount: '" autofocus onfocus="window.__p1Injected=1" < > &',
    title: '"><input data-p1-injected onfocus="window.__p1Injected=1">',
    content:
      '</textarea><img data-p1-injected src=x onerror="window.__p1Injected=1"><script>window.__p1Injected=1</script>中文 & " \' < >'
  }
];
function exactForm(f: Awaited<ReturnType<typeof boot>>) {
  const values = (selector: string) =>
    Array.from(f.w.document.querySelectorAll<HTMLInputElement>(selector), (e) => e.value);
  expect(values('#formRecipeIngList .recipe-ing-name')).toEqual(special.map((s) => s.name));
  expect(values('#formRecipeIngList .recipe-ing-amount')).toEqual(special.map((s) => s.amount));
  expect(values('#formRecipeStepList .recipe-step-title')).toEqual(special.map((s) => s.title));
  expect(values('#formRecipeStepList .recipe-step-desc')).toEqual(special.map((s) => s.content));
  expect(
    f.w.document.querySelectorAll(
      '#modalRecipeForm [data-p1-injected], #formRecipeIngList img, #formRecipeStepList img, #formRecipeStepList script'
    ).length
  ).toBe(0);
  expect(f.w.__p1Injected).toBeUndefined();
}
function exactData(data: Payload | Recipe, saved = false) {
  expect(
    data.ingredients.map((i) => ({ name: saved ? i.ingredientNameSnapshot : i.name, amount: i.amountText }))
  ).toEqual(special.map(({ name, amount }) => ({ name, amount })));
  expect(data.steps.map(({ title, content }) => ({ title, content }))).toEqual(
    special.map(({ title, content }) => ({ title, content }))
  );
}

describe('recipe P1 identity and safe roundtrip regression', () => {
  it('untouched ingredient retains distinct inventory ID and both flags', async () => {
    const api = backend(
      dto([
        {
          id: 'recipe-row',
          ingredientId: 'inventory-potato',
          ingredientNameSnapshot: '土豆',
          quantity: 25,
          unit: 'GRAM',
          optional: true,
          isPrimary: true
        }
      ])
    );
    const f = await boot(api);
    await f.open();
    expect((await f.save()).ingredients[0]).toMatchObject({
      ingredientId: 'inventory-potato',
      optional: true,
      isPrimary: true
    });
  });
  it.each(['same', 'changed'])('renaming clears the old inventory ID and preserves flags (%s amount)', async (kind) => {
    const api = backend(
      dto([
        {
          id: 'recipe-row',
          ingredientId: 'inventory-potato',
          ingredientNameSnapshot: '土豆',
          quantity: 25,
          unit: 'GRAM',
          optional: true,
          isPrimary: true
        }
      ])
    );
    const f = await boot(api);
    await f.open();
    f.field('.recipe-ing-name').value = '胡萝卜';
    if (kind === 'changed') f.field('.recipe-ing-amount').value = '30g';
    expect((await f.save()).ingredients[0]).toMatchObject({
      ingredientId: null,
      name: '胡萝卜',
      optional: true,
      isPrimary: true
    });
  });
  it('new row does not inherit deleted row identity or flags by position', async () => {
    const api = backend(
      dto([
        {
          id: 'recipe-row',
          ingredientId: 'inventory-potato',
          ingredientNameSnapshot: '土豆',
          quantity: 25,
          unit: 'GRAM',
          optional: true,
          isPrimary: true
        }
      ])
    );
    const f = await boot(api);
    await f.open();
    f.field('.recipe-ing-row').remove();
    f.w.addRecipeIngRow('胡萝卜', '25g');
    expect((await f.save()).ingredients[0]).toMatchObject({
      ingredientId: null,
      name: '胡萝卜',
      optional: false,
      isPrimary: false
    });
  });
  it('exact special text survives POST/GET/reopen/unchanged PUT/GET/fresh DOM reopen without HTML injection', async () => {
    const api = backend();
    const f = await boot(api);
    f.w.BentoModal.setupRecipeForm();
    f.field('#formRecipeName').value = '特殊字符';
    f.field('#formRecipeTime').value = '20';
    f.field('.recipe-ing-row').remove();
    f.field('.recipe-step-row').remove();
    for (const s of special) {
      f.w.addRecipeIngRow(s.name, s.amount);
      f.w.addRecipeStepRow(s.title, s.content, '0');
    }
    exactForm(f);
    exactData(await f.save());
    expect(api.writes[0].method).toBe('POST');
    exactData(api.get(), true);
    await f.open();
    exactForm(f);
    exactData(await f.save());
    expect(api.writes[1].method).toBe('PUT');
    exactData(api.get(), true);
    f.w.close();
    const fresh = await boot(api);
    expect(fresh.w.document).not.toBe(f.w.document);
    await fresh.open();
    exactForm(fresh);
    exactData(await fresh.save());
    exactData(api.get(), true);
  });
});
