import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerIngredientRoutes } from '../src/modules/ingredients/routes.js';
import { registerRecipeRoutes } from '../src/modules/recipes/routes.js';
import { registerConsumptionRoutes } from '../src/modules/consumption/routes.js';

type Ingredient = {
  id: string;
  ingredientId: string | null;
  ingredientNameSnapshot: string;
  quantity: number | null;
  unit: string | null;
  amountText: string | null;
  optional: boolean;
  isPrimary: boolean;
};
type Step = { title: string | null; content: string; timerMinutes: number | null };
type Recipe = { id: string; name: string; version: number; ingredients: Ingredient[]; steps: Step[] };
type Payload = {
  ingredients: Array<{
    ingredientId: string | null;
    name: string;
    optional: boolean;
    isPrimary: boolean;
    amountText: string | null;
  }>;
  steps: Step[];
  name: string;
};
type Field = { value: string; textContent: string | null; remove(): void; dataset: Record<string, string> };
type TestDocument = {
  querySelector(selector: string): Field | null;
  querySelectorAll(selector: string): ArrayLike<Field>;
};
type FrontendWindow = {
  document: TestDocument;
  eval(code: string): unknown;
  close(): void;
  fetch: (url: string, init?: { method?: string; body?: string }) => Promise<unknown>;
  Element: { prototype: object };
  HTMLCanvasElement: { prototype: { getContext: () => null } };
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
  setTimeout(handler: unknown, timeout?: number, ...args: unknown[]): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
  close(): void;
  __p1Injected?: number;
};
type DomFactory = { JSDOM: new (html: string, options: Record<string, unknown>) => { window: FrontendWindow } };
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as DomFactory;
const client = resolve(process.cwd(), '../client');
const html = readFileSync(resolve(client, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');
const adapter = readFileSync(resolve(client, 'public/google2-adapter.js'), 'utf8');
const windows: FrontendWindow[] = [];
const db = createTestPrismaClient();
let app: FastifyInstance;
const empty = { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 };

async function api<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> {
  const result = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  });
  expect(result.statusCode, result.body).toBe(method === 'POST' && url === '/api/v1/recipes' ? 201 : 200);
  return result.json<{ data: T }>().data;
}
async function frontend() {
  const w = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''), {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  }).window;
  windows.push(w);
  // 测试卫生：jsdom close() 不会取消已排队的宿主 timer（jsdom 已知行为），
  // 迟到回调会在 detach 后的 window 上执行并产生 unhandled rejection。
  // 包装 setTimeout 收集 timer id，由 afterEach 在 close 前统一清除。断言与被测行为零变化。
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  (w as unknown as { __p1PendingTimers: Set<ReturnType<typeof setTimeout>> }).__p1PendingTimers = pendingTimers;
  const originalSetTimeout = w.setTimeout.bind(w) as (...args: unknown[]) => ReturnType<typeof setTimeout>;
  const originalClearTimeout = w.clearTimeout.bind(w);
  (w as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    handler: unknown,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const id = originalSetTimeout(handler, timeout, ...args);
    pendingTimers.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  (w as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    pendingTimers.delete(id);
    return originalClearTimeout(id);
  }) as unknown as typeof clearTimeout;
  const writes: Array<{ method: string; payload: Payload; dto: Recipe }> = [];
  const closed = { value: false };
  (w as unknown as { __p1Closed: { value: boolean } }).__p1Closed = closed;
  // 任何 close 路径（测试内的 f.w.close() 与 afterEach）都先置 closed 标志，
  // 使在途 fetch 在响应构造处永久挂起，切断 close 后的僵尸回调链。
  const originalClose = w.close.bind(w);
  (w as unknown as { close: () => void }).close = () => {
    closed.value = true;
    originalClose();
  };
  w.HTMLCanvasElement.prototype.getContext = () => null;
  Object.defineProperty(w.Element.prototype, 'innerText', {
    configurable: true,
    get(this: { textContent: string }) {
      return this.textContent || '';
    },
    set(this: { textContent: string }, value: string) {
      this.textContent = value;
    }
  });
  w.fetch = async (url, init) => {
    // 测试卫生：window 关闭后挂起的 fetch 永不 resolve——切断 close 后仍在推进的
    // boot/reload 回调链（jsdom detach 后回调访问 document 会产生 unhandled rejection）。
    // 仅影响测试结束后阶段，测试逻辑与断言零变化。
    if (closed.value) return new Promise<never>(() => {});
    const path = new URL(url, 'http://localhost').pathname;
    if (path.startsWith('/api/v1/recipes')) {
      const method = init?.method ?? 'GET';
      const res = await app.inject({
        method: method as 'GET' | 'POST' | 'PUT',
        url: path,
        ...(init?.body ? { payload: JSON.parse(init.body) as Record<string, unknown> } : {})
      });
      // close 发生在 app.inject 在途期间：丢弃响应并永久挂起，阻断 request() 的
      // 后续 text/localStorage/emit 订阅者链在已 detach 的 window 上执行。
      if (closed.value) return new Promise<never>(() => {});
      if (method === 'POST' || method === 'PUT') {
        expect(res.statusCode, res.body).toBe(method === 'POST' ? 201 : 200);
        writes.push({
          method,
          payload: JSON.parse(init?.body ?? '{}') as Payload,
          dto: res.json<{ data: Recipe }>().data
        });
      }
      return { ok: res.statusCode < 400, status: res.statusCode, text: async () => res.body };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: empty }) };
  };
  w.eval(scripts);
  w.eval(adapter);
  await new Promise<void>((done) =>
    w.eval('document.readyState') === 'loading'
      ? (
          w.document as unknown as { addEventListener(name: string, listener: () => void, options: object): void }
        ).addEventListener('DOMContentLoaded', () => done(), { once: true })
      : done()
  );
  const field = (selector: string) => {
    const result = w.document.querySelector(selector);
    if (!result) throw new Error(`Missing frontend field: ${selector}`);
    return result;
  };
  const open = async (id: string) => {
    const mapped = await w.BentoService.recipes.getByIdRemote(id);
    w.renderRecipes();
    expect(
      w.document.querySelectorAll('#recipesCardGrid [data-p1-injected], #recipesCardGrid img, #recipesCardGrid script')
        .length
    ).toBe(0);
    const summaries = Array.from(
      w.document.querySelectorAll('[data-recipe-ingredient-summary]'),
      (element) => element.textContent
    );
    expect(
      summaries.some((text) => text?.includes(mapped.ingredients.map((i) => i.ingredientNameSnapshot).join('、')))
    ).toBe(true);
    w.BentoModal.setupRecipeDetail(mapped.id);
    expect(
      w.document.querySelectorAll(
        '#modalRecipeDetail [data-p1-injected], #modalRecipeDetail img, #modalRecipeDetail script'
      ).length
    ).toBe(0);
    expect(w.__p1Injected).toBeUndefined();
    w.BentoModal.setupRecipeForm(mapped);
    return mapped;
  };
  const save = async () => {
    const before = writes.length;
    await w.BentoModal.handleRecipeFormSubmit({ preventDefault() {} });
    expect(writes.length).toBe(before + 1);
    return writes.at(-1)!;
  };
  return { w, writes, field, open, save };
}
beforeAll(async () => {
  await db.$connect();
  app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
  registerErrorHandlers(app);
  await registerIngredientRoutes(app, db);
  await registerRecipeRoutes(app, db);
  await registerConsumptionRoutes(app, db);
});
afterEach(() => {
  for (const w of windows.splice(0)) {
    (w as unknown as { __p1Closed?: { value: boolean } }).__p1Closed = { value: true };
    const pending = (w as unknown as { __p1PendingTimers?: Set<ReturnType<typeof setTimeout>> }).__p1PendingTimers;
    if (pending) for (const id of pending) w.clearTimeout(id);
    w.close();
  }
});
afterAll(async () => {
  await app.close();
  await db.$disconnect();
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
function exactDto(dto: Recipe) {
  expect(dto.ingredients.map((i) => ({ name: i.ingredientNameSnapshot, amount: i.amountText }))).toEqual(
    special.map(({ name, amount }) => ({ name, amount }))
  );
  expect(dto.steps.map(({ title, content }) => ({ title, content }))).toEqual(
    special.map(({ title, content }) => ({ title, content }))
  );
}
function exactForm(f: Awaited<ReturnType<typeof frontend>>) {
  const values = (selector: string) => Array.from(f.w.document.querySelectorAll(selector), (e) => e.value);
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
function exactPayload(payload: Payload) {
  expect(payload.ingredients.map(({ name, amountText }) => ({ name, amount: amountText }))).toEqual(
    special.map(({ name, amount }) => ({ name, amount }))
  );
  expect(payload.steps.map(({ title, content }) => ({ title, content }))).toEqual(
    special.map(({ title, content }) => ({ title, content }))
  );
}

describe('P1 production frontend → real API/DB roundtrips', () => {
  it.each([
    { optional: false, isPrimary: true, changedAmount: false, replacement: false },
    { optional: true, isPrimary: true, changedAmount: false, replacement: false },
    { optional: false, isPrimary: false, changedAmount: true, replacement: false },
    { optional: true, isPrimary: false, changedAmount: true, replacement: false },
    { optional: true, isPrimary: true, changedAmount: false, replacement: true }
  ])(
    'real edit optional=$optional primary=$isPrimary changedAmount=$changedAmount replacement=$replacement cannot deduct potato',
    async ({ optional, isPrimary, changedAmount, replacement }) => {
      const potato = await db.ingredient.create({
        data: {
          name: `P1土豆-${optional}`,
          unit: 'GRAM',
          quantity: 100,
          inventoryBatches: { create: { quantity: 100, unit: 'GRAM' } }
        },
        include: { inventoryBatches: true }
      });
      const carrot = await db.ingredient.create({
        data: {
          name: `P1胡萝卜-${optional}`,
          unit: 'GRAM',
          quantity: 100,
          inventoryBatches: { create: { quantity: 100, unit: 'GRAM' } }
        },
        include: { inventoryBatches: true }
      });
      const created = await api<Recipe>('POST', '/api/v1/recipes', {
        name: 'P1菜谱',
        cookingTimeMinutes: 20,
        ingredients: [{ ingredientId: potato.id, name: '土豆', quantity: 25, unit: 'GRAM', optional, isPrimary }],
        steps: [{ content: '炒至"断生"' }]
      });
      expect(created.ingredients[0].id).not.toBe(potato.id);
      const f = await frontend();
      await f.open(created.id);
      const untouched = await f.save();
      expect(untouched.payload.ingredients[0]).toMatchObject({ ingredientId: potato.id, optional, isPrimary });
      await f.open(created.id);
      if (replacement) {
        f.field('#formRecipeIngList .recipe-ing-row').remove();
        f.w.addRecipeIngRow('胡萝卜', '25g');
      } else {
        f.field('#formRecipeIngList .recipe-ing-name').value = '胡萝卜';
        if (changedAmount) f.field('#formRecipeIngList .recipe-ing-amount').value = '30g';
      }
      expect(f.field('#formRecipeIngList .recipe-ing-amount').value).toBe(changedAmount ? '30g' : '25g');
      const flags = { optional: replacement ? false : optional, isPrimary: replacement ? false : isPrimary };
      const renamed = await f.save();
      expect(renamed.payload.ingredients[0]).toMatchObject({
        ingredientId: null,
        name: '胡萝卜',
        ...flags
      });
      expect(renamed.dto.ingredients[0]).toMatchObject({
        ingredientId: null,
        ingredientNameSnapshot: '胡萝卜',
        ...flags
      });
      const read = await api<Recipe>('GET', `/api/v1/recipes/${created.id}`);
      expect(read.ingredients[0]).toMatchObject({
        ingredientId: null,
        ingredientNameSnapshot: '胡萝卜',
        ...flags
      });
      const fresh = await frontend();
      await fresh.open(created.id);
      const resaved = await fresh.save();
      expect(resaved.payload.ingredients[0]).toMatchObject({
        ingredientId: null,
        name: '胡萝卜',
        ...flags
      });
      expect((await api<Recipe>('GET', `/api/v1/recipes/${created.id}`)).ingredients[0]).toMatchObject({
        ingredientId: null,
        ...flags
      });
      const context = { recipeId: created.id, mealType: 'LUNCH', sourceType: 'HOMEMADE', recordDate: '2026-10-07' };
      const preview = await api<{ items: Array<{ allocations: Array<{ batchId: string }> }>; previewToken: string }>(
        'POST',
        '/api/v1/consumption/preview-from-recipe',
        context
      );
      expect(preview.items.flatMap((item) => item.allocations)).toEqual([]);
      const confirmed = await api<{ recordId: string }>('POST', '/api/v1/consumption/confirm-from-recipe', {
        ...context,
        previewToken: preview.previewToken,
        operationId: `p1-${created.id}`
      });
      for (const ingredient of [potato, carrot]) {
        expect((await db.ingredient.findUnique({ where: { id: ingredient.id } }))?.quantity).toBe(100);
        expect(
          (await db.inventoryBatch.findUnique({ where: { id: ingredient.inventoryBatches[0].id } }))?.quantity
        ).toBe(100);
      }
      expect(
        await db.inventoryLog.count({ where: { relatedRecordId: confirmed.recordId, changeType: 'COOK_DEDUCT' } })
      ).toBe(0);
    },
    20000
  );
  it('new → POST → GET → reopen → unchanged PUT → GET → genuinely fresh DOM reopen preserves exact hostile text', async () => {
    const f = await frontend();
    f.w.BentoModal.setupRecipeForm();
    f.field('#formRecipeName').value = 'P1特殊字符';
    f.field('#formRecipeTime').value = '20';
    f.field('#formRecipeIngList .recipe-ing-row').remove();
    f.field('#formRecipeStepList .recipe-step-row').remove();
    for (const s of special) {
      f.w.addRecipeIngRow(s.name, s.amount);
      f.w.addRecipeStepRow(s.title, s.content, '0');
    }
    exactForm(f);
    const posted = await f.save();
    expect(posted.method).toBe('POST');
    exactPayload(posted.payload);
    exactDto(posted.dto);
    exactDto(await api<Recipe>('GET', `/api/v1/recipes/${posted.dto.id}`));
    await f.open(posted.dto.id);
    exactForm(f);
    const put = await f.save();
    expect(put.method).toBe('PUT');
    exactPayload(put.payload);
    exactDto(put.dto);
    exactDto(await api<Recipe>('GET', `/api/v1/recipes/${posted.dto.id}`));
    f.w.close();
    const fresh = await frontend();
    expect(fresh.w.document).not.toBe(f.w.document);
    await fresh.open(posted.dto.id);
    exactForm(fresh);
    const final = await fresh.save();
    exactPayload(final.payload);
    exactDto(final.dto);
    exactDto(await api<Recipe>('GET', `/api/v1/recipes/${posted.dto.id}`));
  }, 20000);
});
