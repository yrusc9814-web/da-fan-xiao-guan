import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VAN-32 前端正式接线回归（菜谱 / 饮食记录两张表单）。
 *
 * 与 google2-adapter.test.ts 的差别：本文件执行 **index.html 里真实的 inline 业务脚本**
 * （含真实 setupRecipeForm / setupRecordForm / 真实 DOM 结构与真实控件默认值），再接 adapter，
 * 因此断言的是“正式控件 + 正式表单状态 + 正式提交实现”串联后的真实行为，而不是手写的简化 fixture。
 *
 * 边界：网络仍由 fetch stub 承担（本包不改后端、不跑服务/DB），
 * 所以这里证明的是客户端请求体与表单状态正确，不替代浏览器 Smoke。
 */

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapter = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n;\n');
const bodyMarkup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

const jsonOf = (data: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ success: true, data })
});

/** boot 期间 dashboard / 各域分页 / 购物清单都走这个 stub，返回可继续断言的 fetch mock。 */
function stubBackend() {
  const fetchMock = vi.fn(async (url: string) => {
    const path = String(url);
    if (path.includes('/dashboard')) return jsonOf({});
    if (path.includes('/settings')) return jsonOf({});
    if (path.startsWith('/api/v1/shopping-lists')) return jsonOf({ id: 'list-1', version: 1, items: [] });
    return jsonOf({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callsTo = (fetchMock: ReturnType<typeof vi.fn>, needle: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(needle));

function bootRealPage() {
  document.body.innerHTML = bodyMarkup;
  const fetchMock = stubBackend();
  // 真实 inline 业务脚本：定义真实 BentoService / BentoModal 与真实表单装配逻辑
  window.eval(inlineScripts);
  // adapter 在 readyState !== 'loading' 时立即 boot，接线两张表单的正式提交实现
  window.eval(adapter);
  return fetchMock;
}

/** 等 boot 期间的各域 reload 全部落地，避免它们在断言中途把 service.data 覆盖成空列表。 */
const flushBoot = () => new Promise((done) => setTimeout(done, 0));

const recipeDto = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  name: '照烧鸡腿',
  version: 3,
  calories: null,
  cookingTimeMinutes: 20,
  difficulty: '简单',
  imagePath: null,
  favorite: false,
  enabledForRecommendation: true,
  ingredients: [],
  steps: [],
  tags: [],
  mealTypes: [],
  mealRoles: [],
  tools: [],
  ...overrides
});

const recordDto = (overrides: Record<string, unknown> = {}) => ({
  id: 'rec1',
  recordDate: '2026-09-29',
  mealType: 'LUNCH',
  sourceType: 'HOMEMADE',
  rating: 5,
  satiety: null,
  calories: null,
  cost: null,
  notes: null,
  imagePath: null,
  version: 2,
  items: [{ itemType: 'CUSTOM', customName: '手冲咖啡配贝果', sortOrder: 0 }],
  ...overrides
});

const setupRecipe = (dto: Record<string, unknown>) => {
  const mapped = (window as any).DafanDomainAdapter.mapRecipe(dto);
  (window as any).BentoService.recipes.data = [mapped];
  (window as any).BentoModal.setupRecipeForm(mapped);
  return mapped;
};

const setupRecord = (dto: Record<string, unknown>) => {
  const mapped = (window as any).DafanDomainAdapter.mapRecord(dto);
  (window as any).BentoService.records.data = [mapped];
  (window as any).BentoModal.setupRecordForm(mapped);
  return mapped;
};

/** boot + 等 reload 落地 + 装配指定 DTO 到真实表单。 */
async function openRecipeForm(dto: Record<string, unknown>) {
  const fetchMock = bootRealPage();
  await flushBoot();
  fetchMock.mockClear();
  setupRecipe(dto);
  return fetchMock;
}

async function openRecordForm(dto: Record<string, unknown>) {
  const fetchMock = bootRealPage();
  await flushBoot();
  fetchMock.mockClear();
  setupRecord(dto);
  return fetchMock;
}

const submitRecipe = async (fetchMock: ReturnType<typeof vi.fn>) => {
  const button = document.createElement('button');
  document.querySelector('#modalRecipeForm form')!.append(button);
  await (window as any).BentoModal.handleRecipeFormSubmit({ preventDefault: vi.fn(), submitter: button });
  return { button, calls: callsTo(fetchMock, '/api/v1/recipes/r1') };
};

const submitRecord = async (fetchMock: ReturnType<typeof vi.fn>) => {
  const button = document.createElement('button');
  document.querySelector('#modalRecordForm form')!.append(button);
  await (window as any).BentoModal.handleRecordFormSubmit({ preventDefault: vi.fn(), submitter: button });
  return { button, calls: callsTo(fetchMock, '/api/v1/records') };
};

beforeEach(() => {
  localStorage.clear();
  // jsdom 没有实现 innerText，而正式 index.html 的表单装配代码读它（生产浏览器中存在）
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? '';
    },
    set(this: HTMLElement, value: string) {
      this.textContent = value;
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('VAN-32 菜谱表单（真实 index.html 控件 + 真实 setupRecipeForm）', () => {
  it('编辑：后端 calories 为 null 时留空并记录未填写状态，不伪造成 320', () => {
    bootRealPage();
    setupRecipe(recipeDto({ calories: null }));

    const calories = document.getElementById('formRecipeCalories') as HTMLInputElement;
    expect(calories.value).toBe('');
    expect(calories.dataset.valueState).toBe('empty');
    expect(calories.min).toBe('50');
    expect(calories.max).toBe('2000');
  });

  it('编辑：真实 calories / 时长 / 名称原样回填，不写默认值', () => {
    bootRealPage();
    setupRecipe(recipeDto({ calories: 640, cookingTimeMinutes: 45 }));

    const calories = document.getElementById('formRecipeCalories') as HTMLInputElement;
    expect(calories.value).toBe('640');
    expect(calories.dataset.valueState).toBe('filled');
    expect((document.getElementById('formRecipeTime') as HTMLInputElement).value).toBe('45');
    expect((document.getElementById('formRecipeName') as HTMLInputElement).value).toBe('照烧鸡腿');
  });

  it('编辑：后端没有食材/步骤时只给空白行，不写入 主料300g / 烹饪制作', () => {
    bootRealPage();
    setupRecipe(recipeDto({ ingredients: [], steps: [] }));

    const ingRows = document.querySelectorAll('#formRecipeIngList .recipe-ing-row');
    const stepRows = document.querySelectorAll('#formRecipeStepList .recipe-step-row');
    expect(ingRows).toHaveLength(1);
    expect(stepRows).toHaveLength(1);
    expect((ingRows[0].querySelector('.recipe-ing-name') as HTMLInputElement).value).toBe('');
    expect((ingRows[0].querySelector('.recipe-ing-amount') as HTMLInputElement).value).toBe('');
    expect((stepRows[0].querySelector('.recipe-step-title') as HTMLInputElement).value).toBe('');
    expect((stepRows[0].querySelector('.recipe-step-desc') as HTMLTextAreaElement).value).toBe('');
  });

  it('编辑：真实食材（ingredientNameSnapshot + 后端单位）与步骤完整回填', () => {
    bootRealPage();
    setupRecipe(
      recipeDto({
        ingredients: [
          { id: 'i1', ingredientNameSnapshot: '鸡腿肉', quantity: 300, unit: 'GRAM', optional: false, isPrimary: true }
        ],
        steps: [{ id: 's1', stepNo: 1, content: '中火慢煎至两面金黄', imagePath: '/s1.jpg' }]
      })
    );

    const ingRow = document.querySelector('#formRecipeIngList .recipe-ing-row')!;
    expect((ingRow.querySelector('.recipe-ing-name') as HTMLInputElement).value).toBe('鸡腿肉');
    expect((ingRow.querySelector('.recipe-ing-amount') as HTMLInputElement).value).toBe('300g');
    const stepRow = document.querySelector('#formRecipeStepList .recipe-step-row')!;
    expect((stepRow.querySelector('.recipe-step-desc') as HTMLTextAreaElement).value).toBe('中火慢煎至两面金黄');
  });

  it('新建：初始为空行，没有 鸡腿肉/日式照烧汁/备料与前置处理 等演示数据，热量不预填 320', () => {
    bootRealPage();

    (window as any).BentoModal.setupRecipeForm(null);

    expect(document.querySelectorAll('#formRecipeIngList .recipe-ing-row')).toHaveLength(1);
    expect(document.querySelectorAll('#formRecipeStepList .recipe-step-row')).toHaveLength(1);
    expect(document.getElementById('formRecipeIngList')!.textContent).not.toContain('鸡腿肉');
    expect(document.getElementById('formRecipeIngList')!.textContent).not.toContain('照烧汁');
    expect(document.getElementById('formRecipeStepList')!.textContent).not.toContain('备料与前置处理');
    // 热量控件带 value="320" 演示默认，新建时必须被清空为「未填写」
    expect((document.getElementById('formRecipeCalories') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('formRecipeCalories') as HTMLInputElement).dataset.valueState).toBe('empty');
  });

  it('提交：空行被跳过，热量留空 → 显式 null，餐次/餐位/工具按后端枚举送', async () => {
    const fetchMock = await openRecipeForm(
      recipeDto({
        mealTypes: [{ mealType: 'DINNER' }],
        mealRoles: [{ mealRole: 'MAIN' }],
        tools: [{ toolId: 't1', tool: { id: 't1', name: '空气炸锅' } }],
        tags: [{ tag: { name: '家常' } }],
        ingredients: [{ ingredientNameSnapshot: '鸡腿肉', quantity: 300, unit: 'GRAM' }],
        steps: [{ stepNo: 1, content: '中火慢煎' }]
      })
    );
    fetchMock.mockResolvedValueOnce(jsonOf(recipeDto({ id: 'r1', version: 4 })));

    const { button, calls } = await submitRecipe(fetchMock);
    expect(calls).toHaveLength(1);
    const body = JSON.parse((calls[0][1] as any).body);
    expect(body).toEqual({
      name: '照烧鸡腿',
      category: null,
      imagePath: null,
      ingredientsText: null,
      cookingTimeMinutes: 20,
      difficulty: '简单',
      spicyLevel: null,
      servings: null,
      calories: null,
      sourceNote: null,
      notes: null,
      favorite: false,
      enabledForRecommendation: true,
      ingredients: [
        {
          ingredientId: null,
          name: '鸡腿肉',
          quantity: 300,
          unit: 'GRAM',
          amountText: null,
          optional: false,
          isPrimary: false
        }
      ],
      steps: [{ content: '中火慢煎', imagePath: null, title: null, timerMinutes: null }],
      tags: ['家常'],
      mealTypes: ['DINNER'],
      mealRoles: ['MAIN'],
      toolIds: [{ toolId: 't1', name: '空气炸锅', required: true }],
      version: 3
    });
    expect(button.disabled).toBe(false);
  });

  it('提交：真实 number 热量（640 / 800）真实送达后端，不再 422 阻断', async () => {
    const fetchMock = await openRecipeForm(recipeDto({ calories: 640 }));
    fetchMock.mockResolvedValueOnce(jsonOf(recipeDto({ calories: 800, version: 4 })));

    const calories = document.getElementById('formRecipeCalories') as HTMLInputElement;
    expect(calories.value).toBe('640');
    calories.value = '800';
    const { calls } = await submitRecipe(fetchMock);
    expect(calls).toHaveLength(1);
    expect(JSON.parse((calls[0][1] as any).body).calories).toBe(800);
  });

  it('提交：越界/小数热量（3000 / 320.5）快速失败，不发请求', async () => {
    const fetchMock = await openRecipeForm(recipeDto({ calories: 640 }));

    const calories = document.getElementById('formRecipeCalories') as HTMLInputElement;
    for (const value of ['3000', '320.5', '10']) {
      calories.value = value;
      const { button, calls } = await submitRecipe(fetchMock);
      expect(calls).toHaveLength(0);
      expect(button.disabled).toBe(false);
    }
  });

  it('刷新（重新 boot + reload）：DTO 里持久化的热量/关系重新映射进表单', async () => {
    const fetchMock = bootRealPage();
    fetchMock.mockImplementation(async (url: string) => {
      const path = String(url);
      if (path.includes('/dashboard')) return jsonOf({});
      if (path.includes('/settings')) return jsonOf({});
      if (path.startsWith('/api/v1/shopping-lists')) return jsonOf({ id: 'list-1', version: 1, items: [] });
      if (path.startsWith('/api/v1/recipes?'))
        return jsonOf({
          items: [
            recipeDto({
              calories: 720,
              cookingTimeMinutes: 35,
              mealTypes: [{ mealType: 'AFTERNOON_TEA' }],
              ingredients: [{ ingredientNameSnapshot: '鸡蛋', quantity: 2, unit: 'PIECE' }]
            })
          ],
          page: 1,
          pageSize: 100,
          total: 1,
          totalPages: 1
        });
      return jsonOf({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 });
    });

    await (window as any).BentoService.recipes.reload();
    const persisted = (window as any).BentoService.recipes.getById('r1');
    expect(persisted.calories).toBe(720);
    expect(persisted.mealTypeLabels).toEqual(['下午茶']);

    (window as any).BentoModal.setupRecipeForm(persisted);
    expect((document.getElementById('formRecipeCalories') as HTMLInputElement).value).toBe('720');
    expect((document.getElementById('formRecipeTime') as HTMLInputElement).value).toBe('35');
    expect((document.querySelector('#formRecipeIngList .recipe-ing-name') as HTMLInputElement).value).toBe('鸡蛋');
    expect((document.querySelector('#formRecipeIngList .recipe-ing-amount') as HTMLInputElement).value).toBe('2个');
  });
});

describe('VAN-32 饮食记录表单（真实 index.html 控件 + 真实 setupRecordForm）', () => {
  it('编辑：satiety 为 null → 未选择（selectedIndex=-1），绝不默认成 8，且选项列表未改', () => {
    bootRealPage();
    setupRecord(recordDto({ satiety: null }));

    const satiety = document.getElementById('formRecordSatiety') as HTMLSelectElement;
    expect(satiety.selectedIndex).toBe(-1);
    expect(satiety.value).toBe('');
    expect(satiety.options).toHaveLength(5);
    expect(Array.from(satiety.options).map((o) => o.value)).toEqual(['10', '8', '7', '5', '3']);
    expect(satiety.dataset.valueState).toBe('empty');
  });

  it('编辑：真实 satiety 8 / calories 620 / cost 88 原样回填', () => {
    bootRealPage();
    setupRecord(recordDto({ satiety: 8, calories: 620, cost: 88 }));

    expect((document.getElementById('formRecordSatiety') as HTMLSelectElement).value).toBe('8');
    expect((document.getElementById('formRecordCalories') as HTMLInputElement).value).toBe('620');
    expect((document.getElementById('formRecordCost') as HTMLInputElement).value).toBe('88');
  });

  it('编辑：calories / cost / notes 为 null 时留空（不补 500 / 0，不拼字面 null）', () => {
    bootRealPage();
    const mapped = setupRecord(recordDto({ calories: null, cost: null, notes: null }));

    expect((document.getElementById('formRecordCalories') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('formRecordCost') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('formRecordNotes') as HTMLTextAreaElement).value).toBe('');
    expect(mapped.calories).toBeNull();
    expect(mapped.satiety).toBeNull();
    expect(mapped.cost).toBeNull();
    expect(mapped.notes).toBeNull();
  });

  it('编辑：评分 4.5 之类选项表达不了的值标记 unrepresentable，不静默改成 5', () => {
    bootRealPage();
    setupRecord(recordDto({ rating: 4.5 }));

    const rating = document.getElementById('formRecordRating') as HTMLSelectElement;
    expect(rating.selectedIndex).toBe(-1);
    expect(rating.dataset.valueState).toBe('unrepresentable');
  });

  it('新建：饱腹感沿用原版默认八分饱，热量/花费/评分未选择，无 550 / 0 / 4星 演示默认', () => {
    bootRealPage();

    (window as any).BentoModal.setupRecordForm(null);

    expect((document.getElementById('formRecordCalories') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('formRecordCost') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('formRecordSatiety') as HTMLSelectElement).value).toBe('8');
    expect((document.getElementById('formRecordSatiety') as HTMLSelectElement).selectedIndex).toBe(1);
    expect((document.getElementById('formRecordRating') as HTMLSelectElement).selectedIndex).toBe(-1);
  });

  it('饱腹感清除：5 档选项不变，主动点清除 → 未选择，提交送 null', async () => {
    const fetchMock = await openRecordForm(recordDto({ satiety: 10, calories: null, cost: null }));
    expect((document.getElementById('formRecordSatiety') as HTMLSelectElement).value).toBe('10');
    const satiety = document.getElementById('formRecordSatiety') as HTMLSelectElement;
    expect(Array.from(satiety.options).map((o) => o.value)).toEqual(['10', '8', '7', '5', '3']);

    (window as any).clearRecordSatiety();
    expect(satiety.selectedIndex).toBe(-1);
    expect(satiety.dataset.valueState).toBe('empty');

    fetchMock.mockResolvedValueOnce(jsonOf(recordDto({ version: 3, satiety: null })));
    const { calls } = await submitRecord(fetchMock);
    expect(calls).toHaveLength(1);
    expect(JSON.parse((calls[0][1] as any).body)).toMatchObject({ satiety: null });
    expect(satiety.options).toHaveLength(5);
  });

  it('提交：留空 → body 送真实 null；用户选 8 与填 620/88 → 送真实 number', async () => {
    const fetchMock = await openRecordForm(recordDto({ satiety: null, calories: null, cost: null }));
    fetchMock.mockResolvedValueOnce(jsonOf(recordDto({ version: 3 })));

    let result = await submitRecord(fetchMock);
    expect(result.calls).toHaveLength(1);
    let body = JSON.parse((result.calls[0][1] as any).body);
    expect(body).toMatchObject({ version: 2, satiety: null, calories: null, cost: null, notes: null });

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonOf(recordDto({ version: 4, satiety: 8, calories: 620, cost: 88 })));
    (document.getElementById('formRecordSatiety') as HTMLSelectElement).value = '8';
    (document.getElementById('formRecordSatiety') as HTMLSelectElement).dispatchEvent(new Event('change'));
    (document.getElementById('formRecordCalories') as HTMLInputElement).value = '620';
    (document.getElementById('formRecordCost') as HTMLInputElement).value = '88';

    result = await submitRecord(fetchMock);
    expect(result.calls).toHaveLength(1);
    body = JSON.parse((result.calls[0][1] as any).body);
    expect(body).toMatchObject({ satiety: 8, calories: 620, cost: 88 });
  });

  it('提交：越界/小数营养值（calories 12.5 / cost -1）快速失败，不发请求', async () => {
    const fetchMock = await openRecordForm(recordDto({ satiety: null, calories: null, cost: null }));

    const calories = document.getElementById('formRecordCalories') as HTMLInputElement;
    const cost = document.getElementById('formRecordCost') as HTMLInputElement;

    calories.value = '12.5';
    let result = await submitRecord(fetchMock);
    expect(result.calls).toHaveLength(0);

    calories.value = '';
    cost.value = '-1';
    result = await submitRecord(fetchMock);
    expect(result.calls).toHaveLength(0);
    expect(result.button.disabled).toBe(false);
  });

  it('records.update 对非法 nullable 值（"12abc" / 非法饱腹 "8.5" / 负花费）快速失败且不发请求', async () => {
    const fetchMock = await openRecordForm(recordDto());

    const records = (window as any).BentoService.records;
    await expect(records.update('rec1', { calories: '12abc' })).rejects.toMatchObject({
      code: 'RECORD_CALORIES_INVALID'
    });
    await expect(records.update('rec1', { satiety: '8.5' })).rejects.toMatchObject({
      code: 'RECORD_SATIETY_INVALID'
    });
    await expect(records.update('rec1', { satiety: 4 })).rejects.toMatchObject({ code: 'RECORD_SATIETY_INVALID' });
    await expect(records.update('rec1', { cost: -1 })).rejects.toMatchObject({ code: 'RECORD_COST_INVALID' });
    expect(callsTo(fetchMock, '/api/v1/records')).toHaveLength(0);
  });

  it('就餐时段「下午茶/夜宵」选项接成 AFTERNOON_TEA（选项列表不变仍可保存）', async () => {
    const fetchMock = await openRecordForm(recordDto({ mealType: 'AFTERNOON_TEA' }));
    fetchMock.mockResolvedValueOnce(jsonOf(recordDto({ version: 3, mealType: 'AFTERNOON_TEA' })));

    const slot = document.getElementById('formRecordSlot') as HTMLSelectElement;
    // 选项文本「下午茶/夜宵」与后端中文标签「下午茶」不同，回填按前缀命中同一 option
    expect(slot.value).toBe('下午茶/夜宵');
    expect(Array.from(slot.options).map((o) => o.text.trim())).toEqual(['午餐', '晚餐', '早餐', '下午茶/夜宵']);

    const { calls } = await submitRecord(fetchMock);
    expect(calls).toHaveLength(1);
    expect(JSON.parse((calls[0][1] as any).body)).toMatchObject({ mealType: 'AFTERNOON_TEA' });
  });

  it('后端 SOUP 餐次在记录表单里表达不了：保持未选择，编辑提交省略字段以保留后端原值', async () => {
    const fetchMock = await openRecordForm(recordDto({ mealType: 'SOUP' }));
    fetchMock.mockResolvedValueOnce(jsonOf(recordDto({ version: 3, mealType: 'SOUP' })));

    const slot = document.getElementById('formRecordSlot') as HTMLSelectElement;
    expect(slot.selectedIndex).toBe(-1);
    expect(slot.dataset.valueState).toBe('unrepresentable');

    const { calls } = await submitRecord(fetchMock);
    expect(calls).toHaveLength(1);
    const body = JSON.parse((calls[0][1] as any).body);
    expect(body).not.toHaveProperty('mealType');
    expect(body).toMatchObject({ calories: null, satiety: null, cost: null });
  });
});
