// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapterSource = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');
const markup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

const PAYLOADS = {
  img: '<img src=x onerror="window.__xss=1">',
  svg: '"><svg onload="window.__xss=2">',
  script: `'"><script>window.__xss=3</script>`,
  quotes: 'quoted" \' backslash\\ tail'
};

function defineInnerText() {
  Object.defineProperty(Element.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent || '';
    },
    set(value: string) {
      this.textContent = value;
    }
  });
}

function bootInline() {
  document.body.innerHTML = markup;
  defineInnerText();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  window.eval(inline);
}

const apiOk = (data: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  text: async () => JSON.stringify({ success: true, data })
});

const apiFail = (status: number, code: string, message: string, details?: unknown, retryAfter?: number) => ({
  ok: false,
  status,
  headers: new Headers(retryAfter ? { 'retry-after': String(retryAfter) } : {}),
  text: async () => JSON.stringify({ success: false, error: { code, message, details } })
});

const flush = async () => {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
};

const defaultRoute = (url: string, init?: RequestInit) => {
  const method = (init?.method || 'GET').toUpperCase();
  if (url.endsWith('/settings/pin/session')) return apiOk({ valid: false });
  if (url.endsWith('/settings/pin/verify')) return apiOk({ valid: false });
  if (url.endsWith('/settings/pin') && method === 'PUT') return apiOk({});
  if (url.endsWith('/settings')) return apiOk({ version: 1, pinEnabled: false });
  if (url.endsWith('/dashboard')) return apiOk({});
  return apiOk({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 });
};

function bootWithAdapter(route: (url: string, init?: RequestInit) => unknown | Promise<unknown>) {
  document.body.innerHTML = markup;
  defineInnerText();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => route(String(url), init));
  vi.stubGlobal('fetch', fetchMock);
  window.eval(inline);
  window.eval(adapterSource);
  return fetchMock;
}

type RecordedCall = { method: string; path: string; body: any; headers: Record<string, string> };

function recorder() {
  const calls: RecordedCall[] = [];
  const record = (url: string, init?: RequestInit) => {
    const call: RecordedCall = {
      method: (init?.method || 'GET').toUpperCase(),
      path: String(url).replace('/api/v1', ''),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: { ...((init?.headers as Record<string, string>) || {}) }
    };
    calls.push(call);
    return call;
  };
  const find = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
  return { calls, record, find };
}

function expectInert(container: Element | null, allowRootSvg = false) {
  expect(container).toBeTruthy();
  const scope = container as Element;
  expect((window as any).__xss).toBeUndefined();
  const forbidden = allowRootSvg ? 'svg,script,iframe,object,embed' : 'img,svg,script,iframe,object,embed';
  expect(scope.querySelectorAll(forbidden)).toHaveLength(0);
  scope.querySelectorAll('*').forEach((node) => {
    Array.from(node.attributes).forEach((attr) => {
      expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
    });
  });
}

function expectNoInjectedAttributes(container: Element | null) {
  expect(container).toBeTruthy();
  const scope = container as Element;
  expect((window as any).__xss).toBeUndefined();
  expect(scope.querySelectorAll('script,iframe,object,embed')).toHaveLength(0);
  scope.querySelectorAll('*').forEach((node) => {
    Array.from(node.attributes).forEach((attr) => {
      expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
    });
  });
}

const service = () => (window as any).BentoService;

const storeFixture = (payload: string) => ({
  id: `store-${payload}`,
  name: payload,
  icon: payload,
  category: payload,
  dishes: payload,
  address: payload,
  hours: payload,
  price: 28,
  rating: 4.5,
  favorite: true,
  supportsDineIn: true,
  supportsTakeout: true,
  menuItems: [{ name: payload, desc: payload, icon: payload, price: 18, isSignature: true }],
  history: [{ date: '2026-09-01', slot: '午餐', title: payload, note: payload, rating: 5 }]
});

const recipeFixture = (payload: string, id = `recipe-${payload}`) => ({
  id,
  name: payload,
  icon: payload,
  category: payload,
  difficulty: payload,
  cookTimeMinutes: 30,
  calories: 420,
  favorite: true,
  ingredients: [
    {
      name: payload,
      amount: payload,
      amountText: payload,
      pantryKeyword: payload,
      ingredientId: `pantry-${payload}`,
      quantity: 1,
      unit: 'PIECE'
    }
  ],
  steps: [{ stepIndex: 1, title: payload, desc: payload, timerMinutes: 5 }]
});

const pantryFixture = (payload: string) => ({
  id: `pantry-${payload}`,
  name: payload,
  icon: payload,
  category: '蔬菜',
  storageLocation: payload,
  stock: 2,
  unit: 'PIECE',
  purchaseDate: '2026-09-01',
  expireDate: '2026-09-20',
  expireDaysLeft: 12
});

const toolFixture = (payload: string) => ({
  id: `tool-${payload}`,
  name: payload,
  icon: payload,
  category: payload,
  status: '状态良好',
  notes: payload
});

beforeEach(() => {
  localStorage.clear();
  delete (window as any).__xss;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('T-004R 全站动态渲染：三类注入载荷与引号反斜杠只作为纯文本', () => {
  it.each(Object.entries(PAYLOADS))('列表渲染（探店/菜谱/库存/收藏/厨具）对 %s 载荷零注入', (_name, payload) => {
    bootInline();
    const sandbox = service();
    sandbox.stores.data = [storeFixture(payload)];
    sandbox.recipes.data = [recipeFixture(payload)];
    sandbox.pantry.data = [pantryFixture(payload)];
    sandbox.tools.data = [toolFixture(payload)];
    (window as any).renderStores();
    (window as any).renderRecipes();
    (window as any).renderInventory();
    (window as any).renderFavorites();
    (window as any).renderTools();
    const targets = [
      document.getElementById('storeCardGrid'),
      document.getElementById('recipesCardGrid'),
      document.getElementById('inventoryCardGrid'),
      document.getElementById('favoritesCardGrid'),
      document.getElementById('toolsCardGrid')
    ];
    targets.forEach((target) => {
      expectInert(target);
      expect(target?.textContent || '').toContain(payload);
      expect(target?.querySelectorAll('[onclick]')).toHaveLength(0);
    });
    expect(document.querySelectorAll('[onclick] #storeCardGrid, #storeCardGrid [onclick]')).toHaveLength(0);
  });

  it('转盘 SVG 的扇区文本不产生 svg/onload 注入', () => {
    bootInline();
    const payload = PAYLOADS.img;
    service().recipes.data = [recipeFixture(payload, 'r1'), recipeFixture(payload, 'r2')];
    (window as any).setWheelCandidateMode('cook');
    const rotor = document.getElementById('wheelRotor') as Element;
    expectNoInjectedAttributes(rotor);
    expect(rotor.querySelectorAll('svg')).toHaveLength(1);
    const labels = Array.from(rotor.querySelectorAll('text tspan, text')).map((node) => node.textContent || '');
    expect(labels.some((text) => text.includes(payload.slice(0, 5)))).toBe(true);
    expect(rotor.querySelectorAll('foreignObject')).toHaveLength(0);
    expect(rotor.querySelectorAll('script')).toHaveLength(0);
  });

  it('combobox 关键词高亮使用 <mark> 文本分段，点击传原始 value/name', () => {
    bootInline();
    const name = '恶意<script>window.__xss=1</script>番茄炒蛋';
    service().recipes.data = [recipeFixture(name, 'r-cb')];
    service().stores.data = [];
    const modal = (window as any).BentoModal;
    modal.initComboboxData();
    modal.filterPlanCombobox('番茄');
    const list = document.getElementById('comboboxOptionsList') as Element;
    expectInert(list);
    const marks = Array.from(list.querySelectorAll('mark')).map((node) => node.textContent);
    expect(marks).toContain('番茄');
    expect(list.textContent).toContain(name);
    expect(list.querySelectorAll('.bento-combobox-item')).toHaveLength(1);

    modal.filterPlanCombobox('.*');
    expectInert(list);
    expect(list.querySelectorAll('.bento-combobox-item')).toHaveLength(0);

    modal.filterPlanCombobox('');
    (list.querySelector('.bento-combobox-item') as HTMLElement).click();
    const trigger = document.getElementById('comboboxTriggerText') as Element;
    expectInert(trigger);
    expect(trigger.textContent).toContain(name);
    expect((document.getElementById('planPickerSelectTarget') as HTMLInputElement).value).toBe('recipe:r-cb');
  });

  it('店铺/菜谱/食材详情抽屉与备餐推荐对注入载荷保持纯文本', () => {
    bootInline();
    const payload = PAYLOADS.svg;
    const sandbox = service();
    const store = storeFixture(payload);
    const recipe = recipeFixture(payload, 'recipe-detail');
    const item = pantryFixture(payload);
    sandbox.stores.data = [store];
    sandbox.recipes.data = [recipe];
    sandbox.pantry.data = [item];
    const open = vi.spyOn((window as any).BentoModal, 'open').mockResolvedValue(true);

    (window as any).BentoModal.setupStoreDetail(store.id);
    expectInert(document.getElementById('storeDetailMenuList'));
    expect(document.getElementById('storeDetailMenuList')?.textContent).toContain(payload);
    expectInert(document.getElementById('storeDetailHistoryList'));
    expect(document.getElementById('storeDetailHistoryList')?.textContent).toContain(payload);
    (document.querySelector('#storeDetailMenuList button') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith('planPicker', {
      targetType: 'store',
      targetId: store.id,
      targetName: payload
    });

    (window as any).BentoModal.setupRecipeDetail(recipe.id);
    expectInert(document.getElementById('recipeDetailIngredientsList'));
    expect(document.getElementById('recipeDetailIngredientsList')?.textContent).toContain(payload);
    expectInert(document.getElementById('recipeDetailStepsList'));
    expect(document.getElementById('recipeDetailStepsList')?.textContent).toContain(payload);
    const stepButton = document.querySelector('[data-recipe-step-index]') as HTMLButtonElement;
    expect(stepButton).toBeTruthy();
    expect(stepButton.getAttribute('onclick')).toBeNull();

    (window as any).BentoModal.setupIngredientDetail(item.id);
    expectInert(document.getElementById('ingredientDetailRelatedRecipes'));
    expect(document.getElementById('ingredientDetailRelatedRecipes')?.textContent).toContain(payload);

    (window as any).BentoModal.setupPantryRecommend();
    const recommend = document.getElementById('pantryRecommendContent');
    expectInert(recommend);
    expect(recommend?.textContent).toContain(payload);
  });

  it('到期提醒弹窗按 dataset 传原 id，标题/日期文案为纯文本', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 12, 0, 0));
    bootInline();
    const payload = PAYLOADS.script;
    const plan = {
      id: `plan-${payload}`,
      title: payload,
      icon: payload,
      date: '2026-10-02',
      time: '12:00',
      slot: '午餐',
      isCompleted: false
    };
    service().plans.data = [plan];
    const scheduler = (window as any).PlanReminderScheduler;
    const timestamp = (window as any).getScheduledTimestamp(plan);
    scheduler.activeReminderOccurrences.add(`${plan.id}|${timestamp}`);
    scheduler.refreshModalContent();
    const list = document.getElementById('expiredPlansList') as Element;
    expectInert(list);
    expect(list.textContent).toContain(payload);
    const card = list.querySelector('[data-reminder-id]') as HTMLElement;
    expect(card.dataset.reminderId).toBe(plan.id);
  });
});

describe('T-004R 真实点击使用原始 id / 名称（spy 断言）', () => {
  it('探店卡片、排餐、编辑按钮传原始 id 且不拼内联事件', () => {
    bootInline();
    const payload = PAYLOADS.quotes;
    const store = storeFixture(payload);
    service().stores.data = [store];
    const open = vi.spyOn((window as any).BentoModal, 'open').mockResolvedValue(true);
    (window as any).renderStores();
    const card = document.getElementById('storeCardGrid')?.firstElementChild as HTMLElement;
    const buttons = Array.from(card.querySelectorAll('button')) as HTMLButtonElement[];
    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.getAttribute('onclick'))).toEqual([null, null, null, null]);

    card.click();
    expect(open).toHaveBeenLastCalledWith('storeDetail', store.id);
    buttons[1].click();
    expect(open).toHaveBeenLastCalledWith('planPicker', { targetType: 'store', targetId: store.id });
    buttons[2].click();
    expect(open).toHaveBeenLastCalledWith('storeForm', store.id);
    expect(card.querySelectorAll('[onclick]')).toHaveLength(0);
  });

  it('菜谱与库存卡片点击传原始 id', () => {
    bootInline();
    const payload = PAYLOADS.quotes;
    const recipe = recipeFixture(payload, `id-${payload}`);
    const item = pantryFixture(payload);
    service().recipes.data = [recipe];
    service().pantry.data = [item];
    const open = vi.spyOn((window as any).BentoModal, 'open').mockResolvedValue(true);
    (window as any).renderRecipes();
    (window as any).renderInventory();

    const recipeCard = document.getElementById('recipesCardGrid')?.firstElementChild as HTMLElement;
    recipeCard.click();
    expect(open).toHaveBeenLastCalledWith('recipeDetail', recipe.id);
    const recipeButton = recipeCard.querySelector('button') as HTMLButtonElement;
    expect(recipeButton.getAttribute('onclick')).toBeNull();
    recipeButton.click();
    expect(open).toHaveBeenLastCalledWith('recipeDetail', recipe.id);

    const inventoryCard = document.getElementById('inventoryCardGrid')?.firstElementChild as HTMLElement;
    inventoryCard.click();
    expect(open).toHaveBeenLastCalledWith('ingredientDetail', item.id);
    const archive = inventoryCard.querySelector('button') as HTMLButtonElement;
    expect(archive.getAttribute('onclick')).toBeNull();
    archive.click();
    expect(open).toHaveBeenLastCalledWith('ingredientDetail', item.id);
  });

  it('收藏页爱心按钮传原始 id，厨具删除按钮把原始名称交给确认层并调用真实删除', async () => {
    bootInline();
    const payload = PAYLOADS.quotes;
    const recipe = { ...recipeFixture(payload, `fav-${payload}`), favorite: true };
    const tool = toolFixture(payload);
    service().recipes.data = [recipe];
    service().stores.data = [];
    service().tools.data = [tool];
    const toggleFavorite = vi.spyOn(service().recipes, 'toggleFavorite');
    const removeTool = vi.spyOn(service().tools, 'delete');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    (window as any).renderFavorites();
    (window as any).renderTools();

    const favoriteCard = document.getElementById('favoritesCardGrid')?.firstElementChild as HTMLElement;
    const heart = favoriteCard.querySelector('button') as HTMLButtonElement;
    expect(heart.getAttribute('onclick')).toBeNull();
    heart.click();
    expect(toggleFavorite).toHaveBeenCalledWith(recipe.id);

    const toolCard = document.getElementById('toolsCardGrid')?.firstElementChild as HTMLElement;
    const deleteButton = toolCard.querySelector('button') as HTMLButtonElement;
    expect(deleteButton.getAttribute('onclick')).toBeNull();
    confirm.mockClear();
    deleteButton.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0][0])).toContain(payload);
    expect(removeTool).toHaveBeenCalledWith(tool.id);
    expect((window as any).__xss).toBeUndefined();
  });
});

describe('T-004R 照片 preview 与 safeImageSource 白名单', () => {
  const setRecordPhotos = (photos: string[]) => {
    const record = {
      id: 'rec-photo',
      date: '2026-10-02',
      slot: '午餐',
      type: '自烹',
      title: '照片测试',
      photos,
      ingredients: []
    };
    service().records.data = [record];
    (window as any).BentoModal.setupRecordForm(record.id);
  };

  it('接受 /uploads、受控 base64 位图与同源 blob', () => {
    bootInline();
    const base64 = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    const blob = `blob:${window.location.origin}/abc-123`;
    setRecordPhotos(['/uploads/a-1.jpg', base64, blob]);
    const slots = [0, 1, 2].map((slot) => document.getElementById(`photoSlotView-${slot}`) as HTMLElement);
    expect((slots[0].querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('/uploads/a-1.jpg');
    expect((slots[1].querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(base64);
    expect((slots[2].querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(blob);
    slots.forEach((slot) => expectNoInjectedAttributes(slot));
    slots.forEach((slot) => {
      const image = slot.querySelector('img') as HTMLImageElement;
      expect(
        Array.from(image.attributes)
          .map((attr) => attr.name)
          .sort()
      ).toEqual(['alt', 'class', 'src']);
    });
  });

  it.each([
    ['外部 http', 'https://evil.example/x.jpg'],
    ['协议相对', '//evil.example/x.jpg'],
    ['相对路径', 'relative/x.jpg'],
    ['javascript', 'javascript:window.__xss=1'],
    ['路径穿越', '/uploads/../data/app.db'],
    ['反斜杠', '/uploads/ab\\c.jpg'],
    ['svg data url', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['属性注入', '"><img src=x onerror="window.__xss=1">']
  ])('拒绝 %s 照片源并回落到占位符', (_label, source) => {
    bootInline();
    setRecordPhotos([source, source, source]);
    [0, 1, 2].forEach((slot) => {
      const view = document.getElementById(`photoSlotView-${slot}`) as HTMLElement;
      expect(view.querySelector('img')).toBeNull();
      expect(view.innerHTML).not.toContain('<img');
      expect(view.textContent).toContain(slot === 0 ? '主图相框' : `相框 ${slot + 1}`);
      expectInert(view);
    });
  });
});

describe('T-004R 长表单固定底栏结构（移动端防裁切）', () => {
  it.each(['modalRecipeForm', 'modalStoreForm', 'modalRecordForm', 'modalToolForm'])(
    '%s 的表单滚动区与底栏分离，且 submit 仍在 form 内',
    (modalId) => {
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const modal = parsed.getElementById(modalId);
      expect(modal).toBeTruthy();
      const form = modal?.querySelector('form') as HTMLFormElement;
      expect(form).toBeTruthy();
      expect(form.className).toContain('flex-col');
      expect(form.className).toContain('min-h-0');
      expect(form.className).toContain('overflow-hidden');

      const children = Array.from(form.children) as HTMLElement[];
      const scroller = children.find(
        (node) => node.className.includes('overflow-y-auto') && node.className.includes('flex-1')
      );
      const footer = children[children.length - 1];
      expect(scroller).toBeTruthy();
      expect(scroller?.className).toContain('min-h-0');
      expect(footer.className).toContain('flex-shrink-0');
      expect(footer.className).toContain('pt-3');
      expect(footer.className).toContain('border-t');
      expect(footer.className).toContain('bg-[#FCFAF7]');

      const submit = footer.querySelector('button[type="submit"]') as HTMLButtonElement;
      const cancel = Array.from(footer.querySelectorAll('button')).find(
        (button) => button.getAttribute('type') === 'button'
      ) as HTMLButtonElement;
      expect(submit).toBeTruthy();
      expect(submit.form).toBe(form);
      expect(cancel).toBeTruthy();
      expect(cancel.form).toBe(form);
      expect(form.getAttribute('onsubmit') || '').toMatch(/handle/);
    }
  );

  it('真实 recipeForm 多行食材/步骤后 submit 仍在表单内并触发唯一一次保存提交', async () => {
    bootInline();
    const submitHandler = vi.fn((event: Event) => event.preventDefault());
    const form = document.querySelector('#modalRecipeForm form') as HTMLFormElement;
    form.onsubmit = submitHandler;
    const ingList = document.getElementById('formRecipeIngList') as HTMLElement;
    const stepList = document.getElementById('formRecipeStepList') as HTMLElement;
    for (let index = 0; index < 6; index += 1) {
      (window as any).addRecipeIngRow(`食材${index}`, `2${index}`);
      (window as any).addRecipeStepRow(`步骤${index}`, `做法${index}`, `${index + 1}`);
    }
    expect(ingList.querySelectorAll('.recipe-ing-row').length).toBeGreaterThanOrEqual(6);
    expect(stepList.querySelectorAll('.recipe-step-row').length).toBeGreaterThanOrEqual(6);
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.closest('form')).toBe(form);
    (document.getElementById('formRecipeName') as HTMLInputElement).value = '长表单菜谱';
    (document.getElementById('formRecipeTime') as HTMLInputElement).value = '30';
    submit.click();
    expect(submitHandler).toHaveBeenCalledTimes(1);
  });
});

const PIN_IDS = [
  'modalPinSettings',
  'google2PinSettingsForm',
  'google2PinSettingsTitle',
  'google2PinSettingsDescription',
  'google2PinCurrentGroup',
  'google2PinCurrent',
  'google2PinNewGroup',
  'google2PinNew',
  'google2PinConfirmGroup',
  'google2PinConfirm',
  'google2PinSettingsError',
  'google2PinSettingsSubmit',
  'google2PinSettingsCancel',
  'google2PinSettingsClose',
  'google2PinStatus',
  'google2PinEnable',
  'google2PinChange',
  'google2PinDisable'
];

const storedValues = () =>
  Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index)!));

const pinNode = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLElement;
const pinError = () => pinNode('google2PinSettingsError').textContent || '';
const submitPinForm = () => (pinNode('google2PinSettingsSubmit') as HTMLButtonElement).click();

async function mountSettings(
  options: {
    pinEnabled?: boolean;
    version?: number;
    verify?: (pin: string, attempt: number) => unknown;
    put?: (body: any, call: number) => unknown;
  } = {}
) {
  const state = { pinEnabled: options.pinEnabled === true, version: options.version ?? 3, verifyCalls: 0, putCalls: 0 };
  const log = recorder();
  const fetchMock = bootWithAdapter((url, init) => {
    const call = log.record(url, init);
    if (url.endsWith('/settings/pin/session')) return apiOk({ valid: false });
    if (url.endsWith('/settings/pin/verify')) {
      state.verifyCalls += 1;
      if (options.verify) return options.verify(call.body?.pin, state.verifyCalls);
      return apiOk({ valid: true, token: `tok-${state.verifyCalls}` });
    }
    if (url.endsWith('/settings/pin') && call.method === 'PUT') {
      state.putCalls += 1;
      const result = options.put ? options.put(call.body, state.putCalls) : apiOk({});
      if (result && (result as any).ok) state.pinEnabled = call.body.enabled === true;
      return result;
    }
    if (url.endsWith('/settings')) return apiOk({ version: state.version, pinEnabled: state.pinEnabled });
    return defaultRoute(url, init);
  });
  await flush();
  log.calls.length = 0;
  return { log, state, fetchMock };
}

describe('T-004R 设置页本地 PIN：静态契约与 adapter 导出', () => {
  it('index.html 提供全部契约 ID 与默认未启用三态入口', () => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    PIN_IDS.forEach((id) => expect(parsed.getElementById(id)).toBeTruthy());
    const status = parsed.getElementById('google2PinStatus') as HTMLElement;
    expect(status.textContent?.trim()).toBe('未启用');
    expect(parsed.getElementById('google2PinEnable')?.classList.contains('hidden')).toBe(false);
    expect(parsed.getElementById('google2PinChange')?.classList.contains('hidden')).toBe(true);
    expect(parsed.getElementById('google2PinDisable')?.classList.contains('hidden')).toBe(true);
    expect(parsed.getElementById('google2PinSettingsForm')?.getAttribute('novalidate')).not.toBeNull();
    ['google2PinCurrent', 'google2PinNew', 'google2PinConfirm'].forEach((id) => {
      const input = parsed.getElementById(id) as HTMLInputElement;
      expect(input.getAttribute('type')).toBe('password');
      expect(input.getAttribute('inputmode')).toBe('numeric');
      expect(input.getAttribute('autocomplete')).toBe('off');
    });
    const trigger = parsed.querySelector('#page-settings h4')?.parentElement;
    expect(trigger).toBeTruthy();
  });

  it('DafanSettingsAdapter 导出 PIN 三态入口并保留既有 loadSettings/wireSettings', () => {
    bootWithAdapter(defaultRoute);
    const adapterApi = (window as any).DafanSettingsAdapter;
    expect(typeof adapterApi.loadSettings).toBe('function');
    expect(typeof adapterApi.wireSettings).toBe('function');
    expect(typeof adapterApi.openPinSettings).toBe('function');
    expect(typeof adapterApi.closePinSettings).toBe('function');
    expect(typeof adapterApi.submitPinSettings).toBe('function');
  });

  it('GET /settings 驱动状态徽标与按钮显隐（未启用 / 已启用）', async () => {
    await mountSettings({ pinEnabled: false });
    expect(pinNode('google2PinStatus').textContent).toBe('未启用');
    expect(pinNode('google2PinEnable').classList.contains('hidden')).toBe(false);
    expect(pinNode('google2PinChange').classList.contains('hidden')).toBe(true);

    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    await mountSettings({ pinEnabled: true });
    expect(pinNode('google2PinStatus').textContent).toBe('已启用');
    expect(pinNode('google2PinEnable').classList.contains('hidden')).toBe(true);
    expect(pinNode('google2PinChange').classList.contains('hidden')).toBe(false);
    expect(pinNode('google2PinDisable').classList.contains('hidden')).toBe(false);
  });
});

describe('T-004R 本地 PIN 启用闭环（DOM 提交 + fetch mock）', () => {
  it('旧会话按需迁移到任务指定键，两个键同时存在时使用新键', async () => {
    const { log } = await mountSettings({ pinEnabled: false });
    localStorage.setItem('dafan-pin-token', 'legacy-session');
    await (window as any).DafanApiClient.request('/settings');
    expect(log.find('GET', '/settings').at(-1)?.headers['X-App-Pin-Token']).toBe('legacy-session');
    expect(localStorage.getItem('dafan_google2_pin_token')).toBe('legacy-session');
    expect(localStorage.getItem('dafan-pin-token')).toBeNull();

    localStorage.setItem('dafan-pin-token', 'stale-session');
    localStorage.setItem('dafan_google2_pin_token', 'current-session');
    await (window as any).DafanApiClient.request('/settings');
    expect(log.find('GET', '/settings').at(-1)?.headers['X-App-Pin-Token']).toBe('current-session');
    expect(localStorage.getItem('dafan-pin-token')).toBeNull();
  });

  it('启用：格式/一致性校验通过后取最新 version，PUT 严格 body，再用新 PIN 换 token', async () => {
    const { log, state } = await mountSettings({ pinEnabled: false, version: 2 });
    const adapterApi = (window as any).DafanSettingsAdapter;
    expect(adapterApi.openPinSettings('enable')).toBe(true);
    expect(pinNode('modalPinSettings').classList.contains('hidden')).toBe(false);
    expect(pinNode('google2PinCurrentGroup').classList.contains('hidden')).toBe(true);
    expect(pinNode('google2PinSettingsTitle').textContent).toBe('启用本地 PIN 保护');
    expect(pinNode('google2PinSettingsSubmit').textContent).toBe('启用 PIN');

    // 格式不符：不发任何请求
    (pinNode('google2PinNew') as HTMLInputElement).value = '12ab';
    (pinNode('google2PinConfirm') as HTMLInputElement).value = '12ab';
    submitPinForm();
    await flush();
    expect(pinError()).toBe('请输入 4～8 位数字 PIN');
    expect(log.calls).toHaveLength(0);

    // 两次不一致：同样不发请求
    (pinNode('google2PinNew') as HTMLInputElement).value = '135790';
    (pinNode('google2PinConfirm') as HTMLInputElement).value = '135791';
    submitPinForm();
    await flush();
    expect(pinError()).toBe('两次输入的新 PIN 不一致');
    expect(log.calls).toHaveLength(0);

    state.version = 9;
    (pinNode('google2PinConfirm') as HTMLInputElement).value = '135790';
    submitPinForm();
    await flush();

    const put = log.find('PUT', '/settings/pin');
    expect(put).toHaveLength(1);
    expect(put[0].body).toEqual({ version: 9, enabled: true, pin: '135790' });
    expect(log.find('POST', '/settings/pin/verify')).toHaveLength(1);
    expect(log.find('POST', '/settings/pin/verify')[0].body).toEqual({ pin: '135790' });
    // 取版本必须在 PUT 之前；启用前无既有 token，PUT 不应伪造鉴权头
    const order = log.calls.map((call) => `${call.method} ${call.path}`);
    expect(order.indexOf('GET /settings')).toBeLessThan(order.indexOf('PUT /settings/pin'));
    expect(put[0].headers['X-App-Pin-Token']).toBeUndefined();
    expect(localStorage.getItem('dafan_google2_pin_token')).toBe('tok-1');
    expect(localStorage.getItem('dafan-pin-token')).toBeNull();
    expect(pinNode('modalPinSettings').classList.contains('hidden')).toBe(true);
    expect(pinNode('google2PinStatus').textContent).toBe('已启用');
  });

  it('双击提交只产生一次 PUT / verify', async () => {
    const { log } = await mountSettings({ pinEnabled: false, version: 4 });
    (window as any).DafanSettingsAdapter.openPinSettings('enable');
    (pinNode('google2PinNew') as HTMLInputElement).value = '246810';
    (pinNode('google2PinConfirm') as HTMLInputElement).value = '246810';
    const submitButton = pinNode('google2PinSettingsSubmit') as HTMLButtonElement;
    submitButton.click();
    submitButton.click();
    await flush();
    expect(log.find('PUT', '/settings/pin')).toHaveLength(1);
    expect(log.find('POST', '/settings/pin/verify')).toHaveLength(1);
  });

  it('关闭按钮清空输入与错误提示并复位提交文案', async () => {
    await mountSettings({ pinEnabled: false });
    const adapterApi = (window as any).DafanSettingsAdapter;
    adapterApi.openPinSettings('enable');
    (pinNode('google2PinNew') as HTMLInputElement).value = '111222';
    (pinNode('google2PinConfirm') as HTMLInputElement).value = '111222';
    submitPinForm();
    await flush();
    adapterApi.openPinSettings('enable');
    (pinNode('google2PinSettingsError') as HTMLElement).textContent = '占位错误';
    (pinNode('google2PinSettingsCancel') as HTMLButtonElement).click();
    expect(pinNode('modalPinSettings').classList.contains('hidden')).toBe(true);
    expect((pinNode('google2PinNew') as HTMLInputElement).value).toBe('');
    expect((pinNode('google2PinConfirm') as HTMLInputElement).value).toBe('');
    expect(pinError()).toBe('');
    expect(pinNode('google2PinSettingsSubmit').textContent).toBe('启用 PIN');
  });
});

describe('T-004R 本地 PIN 修改 / 关闭 / 冲突 / 冷却', () => {
  it('修改：先 verify 当前 PIN，wrong 时阻断 PUT；正确时 PUT enabled=true 新 PIN 并续期 token', async () => {
    const { log } = await mountSettings({ pinEnabled: true, version: 5 });
    const adapterApi = (window as any).DafanSettingsAdapter;
    expect(adapterApi.openPinSettings('change')).toBe(true);
    expect(pinNode('google2PinSettingsTitle').textContent).toBe('修改本地 PIN');
    expect(pinNode('google2PinCurrentGroup').classList.contains('hidden')).toBe(false);
    expect(pinNode('google2PinNewGroup').classList.contains('hidden')).toBe(false);
    expect(pinNode('google2PinConfirmGroup').classList.contains('hidden')).toBe(false);

    // 当前 PIN 错误：verify 返回 invalid，不得发出 PUT
    (pinNode('google2PinCurrent') as HTMLInputElement).value = '999999';
    (pinNode('google2PinNew') as HTMLInputElement).value = '654321';
    (pinNode('google2PinConfirm') as HTMLInputElement).value = '654321';
    let allow = false;
    (window as any).fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const call = log.record(url, init);
      if (url.endsWith('/settings/pin/verify')) {
        return allow ? apiOk({ valid: true, token: 'tok-change' }) : apiOk({ valid: false });
      }
      if (url.endsWith('/settings/pin') && call.method === 'PUT') return apiOk({});
      if (url.endsWith('/settings')) return apiOk({ version: 5, pinEnabled: true });
      return defaultRoute(url, init);
    });
    log.calls.length = 0;
    submitPinForm();
    await flush();
    expect(pinError()).toBe('当前 PIN 不正确');
    expect((pinNode('google2PinCurrent') as HTMLInputElement).value).toBe('');
    expect(log.find('PUT', '/settings/pin')).toHaveLength(0);

    allow = true;
    (pinNode('google2PinCurrent') as HTMLInputElement).value = '123456';
    submitPinForm();
    await flush();
    const put = log.find('PUT', '/settings/pin');
    expect(put).toHaveLength(1);
    expect(put[0].body).toEqual({ version: 5, enabled: true, pin: '654321' });
    expect(put[0].headers['X-App-Pin-Token']).toBe('tok-change');
    const verifyPins = log.find('POST', '/settings/pin/verify').map((call) => call.body.pin);
    expect(verifyPins).toContain('123456');
    expect(verifyPins).toContain('654321');
    expect(localStorage.getItem('dafan_google2_pin_token')).toBe('tok-change');
    expect(pinNode('google2PinStatus').textContent).toBe('已启用');
  });

  it('关闭：verify 当前 PIN 后 PUT enabled=false/pin=null，并清空本地 token', async () => {
    const { log } = await mountSettings({ pinEnabled: true, version: 7 });
    localStorage.setItem('dafan_google2_pin_token', 'stale-token');
    localStorage.setItem('dafan-pin-token', 'legacy-stale-token');
    const adapterApi = (window as any).DafanSettingsAdapter;
    expect(adapterApi.openPinSettings('disable')).toBe(true);
    expect(pinNode('google2PinSettingsTitle').textContent).toBe('关闭本地 PIN 保护');
    expect(pinNode('google2PinNewGroup').classList.contains('hidden')).toBe(true);
    expect((pinNode('google2PinCurrent') as HTMLInputElement).value).toBe('');

    (pinNode('google2PinCurrent') as HTMLInputElement).value = '135790';
    submitPinForm();
    await flush();
    const put = log.find('PUT', '/settings/pin');
    expect(put).toHaveLength(1);
    expect(put[0].body).toEqual({ version: 7, enabled: false, pin: null });
    expect(log.find('POST', '/settings/pin/verify')[0].body).toEqual({ pin: '135790' });
    expect(localStorage.getItem('dafan_google2_pin_token')).toBeNull();
    expect(localStorage.getItem('dafan-pin-token')).toBeNull();
    expect(pinNode('google2PinStatus').textContent).toBe('未启用');
    expect(pinNode('modalPinSettings').classList.contains('hidden')).toBe(true);
  });

  it('关闭模式下关闭 PIN 时未启用不允许打开', async () => {
    await mountSettings({ pinEnabled: false });
    expect((window as any).DafanSettingsAdapter.openPinSettings('disable')).toBe(false);
    expect(pinNode('modalPinSettings').classList.contains('hidden')).toBe(true);
  });

  it('PUT 409 VERSION_CONFLICT 时刷新最新状态并提示，不重复提交', async () => {
    const { log } = await mountSettings({
      pinEnabled: false,
      version: 11,
      put: () => apiFail(409, 'VERSION_CONFLICT', '版本冲突')
    });
    (window as any).DafanSettingsAdapter.openPinSettings('enable');
    (pinNode('google2PinNew') as HTMLInputElement).value = '246810';
    (pinNode('google2PinConfirm') as HTMLInputElement).value = '246810';
    submitPinForm();
    await flush();
    expect(log.find('PUT', '/settings/pin')).toHaveLength(1);
    expect(pinError()).toBe('设置已被其他页面修改，已刷新最新状态，请重新提交');
    expect(log.find('GET', '/settings').length).toBeGreaterThanOrEqual(2);
    expect(localStorage.getItem('dafan_google2_pin_token')).toBeNull();
  });

  it('429 PIN_ATTEMPTS_EXCEEDED 进入倒计时并禁用提交，冷却结束恢复', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 12, 0, 0));
    await mountSettings({
      pinEnabled: true,
      version: 3,
      verify: () => apiFail(429, 'PIN_ATTEMPTS_EXCEEDED', '尝试次数过多', { retryAfter: 3 })
    });
    (window as any).DafanSettingsAdapter.openPinSettings('disable');
    (pinNode('google2PinCurrent') as HTMLInputElement).value = '135790';
    submitPinForm();
    await vi.advanceTimersByTimeAsync(0);
    expect(pinError()).toContain('尝试次数过多，请 3 秒后再试');
    const submitButton = pinNode('google2PinSettingsSubmit') as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);

    submitButton.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(pinError()).toContain('尝试次数过多，请 3 秒后再试');

    await vi.advanceTimersByTimeAsync(1000);
    expect(pinError()).toContain('2 秒后再试');
    await vi.advanceTimersByTimeAsync(2500);
    expect(submitButton.disabled).toBe(false);
    expect(pinError()).toBe('可以再次尝试验证');
  });

  it('PIN 明文与 token 不进入 DOM 属性、console 或 Toast', async () => {
    const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = consoleMethods.map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
    const toast = vi.fn();
    const { log } = await mountSettings({ pinEnabled: false, version: 1 });
    (window as any).showToast = toast;
    (window as any).DafanSettingsAdapter.openPinSettings('enable');
    (pinNode('google2PinNew') as HTMLInputElement).value = '482913';
    (pinNode('google2PinConfirm') as HTMLInputElement).value = '482913';
    submitPinForm();
    await flush();

    expect(log.find('PUT', '/settings/pin')).toHaveLength(1);
    const token = localStorage.getItem('dafan_google2_pin_token')!;
    expect(token).toBeTruthy();
    const body = document.body.innerHTML;
    expect(body).not.toContain('482913');
    expect(body).not.toContain(token);
    document.querySelectorAll('#page-settings *, #modalPinSettings *').forEach((node) => {
      Array.from(node.attributes).forEach((attr) => {
        expect(attr.value).not.toContain(token);
        expect(attr.value).not.toContain('482913');
      });
    });
    spies.forEach((spy) => {
      spy.mock.calls.forEach((args) => {
        const text = args.map((arg) => String(arg)).join(' ');
        expect(text).not.toContain(token);
        expect(text).not.toContain('482913');
      });
    });
    toast.mock.calls.forEach((args) => {
      const text = args.map((arg) => String(arg)).join(' ');
      expect(text).not.toContain(token);
      expect(text).not.toContain('482913');
    });
    expect(storedValues().every((value) => typeof value === 'string')).toBe(true);
  });
});

type PendingUnlockVerify = {
  pin: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type UnlockSettlement = { status: 'pending' | 'resolved' | 'rejected'; value?: unknown; error?: unknown };

function mountUnlockSessions() {
  const verifies: PendingUnlockVerify[] = [];
  const unlockedTokens: string[] = [];
  let requirePin = false;
  bootWithAdapter((url, init) => {
    if (url.endsWith('/settings/pin/verify')) {
      const body = JSON.parse(String(init?.body || '{}'));
      return new Promise<unknown>((resolve, reject) => {
        verifies.push({ pin: body.pin, resolve, reject });
      });
    }
    if (url.endsWith('/stores')) {
      if (!requirePin) return apiOk({ items: [] });
      const token = (init?.headers as Record<string, string> | undefined)?.['X-App-Pin-Token'];
      if (!token) return apiFail(401, 'UNAUTHORIZED', '需要 PIN 解锁');
      unlockedTokens.push(token);
      return apiOk({ items: [] });
    }
    return defaultRoute(url, init);
  });
  return {
    verifies,
    unlockedTokens,
    arm: () => {
      requirePin = true;
    }
  };
}

function triggerUnlockRequest(): UnlockSettlement {
  const settled: UnlockSettlement = { status: 'pending' };
  const pending = (window as any).DafanApiClient.get('/stores');
  pending.then(
    (value: unknown) => {
      settled.status = 'resolved';
      settled.value = value;
    },
    (error: unknown) => {
      settled.status = 'rejected';
      settled.error = error;
    }
  );
  return settled;
}

const unlockModalHidden = () => pinNode('modalPinUnlock').classList.contains('hidden');
const unlockSubmitDisabled = () => (pinNode('google2PinSubmit') as HTMLButtonElement).disabled;

function submitUnlockForm(pin: string) {
  (pinNode('google2PinInput') as HTMLInputElement).value = pin;
  (pinNode('google2PinSubmit') as HTMLButtonElement).click();
}

function dispatchUnlockSubmit() {
  document
    .getElementById('google2PinUnlockForm')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

async function startUnlockSession(harness: ReturnType<typeof mountUnlockSessions>, pin: string) {
  const settlement = triggerUnlockRequest();
  await flush();
  expect(unlockModalHidden()).toBe(false);
  submitUnlockForm(pin);
  await flush();
  return settlement;
}

async function cancelUnlockSession() {
  (pinNode('google2PinCancel') as HTMLButtonElement).click();
  await flush();
  expect(unlockModalHidden()).toBe(true);
}

describe('T-004R 解锁弹窗取消失败后重开：旧在途 verify 不得落到新会话（B1 竞态）', () => {
  it('旧成功响应不得写入 token、关闭新弹窗或 resolve 新 promise', async () => {
    const harness = mountUnlockSessions();
    await flush();
    harness.arm();

    const first = await startUnlockSession(harness, '111111');
    expect(harness.verifies.map((entry) => entry.pin)).toEqual(['111111']);
    await cancelUnlockSession();
    expect(first.status).toBe('rejected');
    expect((first.error as any)?.code).toBe('PIN_UNLOCK_CANCELLED');

    const second = await startUnlockSession(harness, '222222');
    expect(harness.verifies.map((entry) => entry.pin)).toEqual(['111111', '222222']);

    // 旧请求先返回成功：不得写 token、不得关闭仍在验证中的新弹窗、不得 resolve 新 promise
    harness.verifies[0].resolve(apiOk({ valid: true, token: 'TOKEN-OLD' }));
    await flush();
    expect(localStorage.getItem('dafan_google2_pin_token')).toBeNull();
    expect(unlockModalHidden()).toBe(false);
    expect(second.status).toBe('pending');
    expect(unlockSubmitDisabled()).toBe(true);
    expect(harness.unlockedTokens).toEqual([]);

    // 新会话自己的响应才允许生效
    harness.verifies[1].resolve(apiOk({ valid: true, token: 'TOKEN-NEW' }));
    await flush();
    expect(localStorage.getItem('dafan_google2_pin_token')).toBe('TOKEN-NEW');
    expect(unlockModalHidden()).toBe(true);
    expect(second.status).toBe('resolved');
    expect(second.value).toEqual({ items: [] });
    expect(harness.unlockedTokens).toEqual(['TOKEN-NEW']);
    expect(harness.verifies).toHaveLength(2);
  });

  it('旧 valid:false 不得清空新请求的验证中状态、清空新输入或允许并发提交', async () => {
    const harness = mountUnlockSessions();
    await flush();
    harness.arm();

    await startUnlockSession(harness, '111111');
    await cancelUnlockSession();
    const second = await startUnlockSession(harness, '222222');

    harness.verifies[0].resolve(apiOk({ valid: false, required: true }));
    await flush();
    expect(pinNode('google2PinError').textContent).not.toBe('PIN 不正确，请重试');
    expect((pinNode('google2PinInput') as HTMLInputElement).value).toBe('222222');
    expect(unlockSubmitDisabled()).toBe(true);
    expect(unlockModalHidden()).toBe(false);
    expect(second.status).toBe('pending');

    // 提交按钮与表单级提交都不得让新请求在途时再并发一次 verify
    (pinNode('google2PinSubmit') as HTMLButtonElement).click();
    await flush();
    dispatchUnlockSubmit();
    await flush();
    expect(harness.verifies).toHaveLength(2);

    harness.verifies[1].resolve(apiOk({ valid: true, token: 'TOKEN-NEW' }));
    await flush();
    expect(second.status).toBe('resolved');
    expect(localStorage.getItem('dafan_google2_pin_token')).toBe('TOKEN-NEW');
    expect(unlockModalHidden()).toBe(true);
  });

  it('旧请求失败时的 catch/finally 不得污染新会话文案，也不得错置提交按钮状态', async () => {
    const harness = mountUnlockSessions();
    await flush();
    harness.arm();

    await startUnlockSession(harness, '111111');
    await cancelUnlockSession();
    const second = await startUnlockSession(harness, '222222');

    harness.verifies[0].reject(Object.assign(new Error('boom'), { status: 500, code: 'INTERNAL_ERROR' }));
    await flush();
    expect(pinNode('google2PinError').textContent).not.toContain('PIN 验证失败');
    expect(unlockSubmitDisabled()).toBe(true);
    expect(unlockModalHidden()).toBe(false);
    expect(second.status).toBe('pending');

    (pinNode('google2PinSubmit') as HTMLButtonElement).click();
    await flush();
    expect(harness.verifies).toHaveLength(2);

    harness.verifies[1].resolve(apiOk({ valid: true, token: 'TOKEN-NEW' }));
    await flush();
    expect(second.status).toBe('resolved');
    expect(localStorage.getItem('dafan_google2_pin_token')).toBe('TOKEN-NEW');
    expect(unlockModalHidden()).toBe(true);
  });
});

const PIN_RENEW_FAILED = 'PIN 已更新，但当前页面会话续期失败，请重新解锁';
const PIN_UPDATE_FAILED = 'PIN 设置更新失败，请稍后重试';

async function runRenewFailure(mode: 'enable' | 'change') {
  let renewAttempted = false;
  const { log } = await mountSettings({
    pinEnabled: mode === 'change',
    version: mode === 'change' ? 5 : 2,
    verify: (pin: string) => {
      if (mode === 'change' && pin === '123456') return apiOk({ valid: true, token: 'tok-current' });
      if (!renewAttempted) {
        renewAttempted = true;
        return apiFail(500, 'INTERNAL_ERROR', '续期失败');
      }
      return apiOk({ valid: true, token: 'tok-unlock' });
    }
  });
  const adapterApi = (window as any).DafanSettingsAdapter;
  expect(adapterApi.openPinSettings(mode)).toBe(true);
  if (mode === 'change') (pinNode('google2PinCurrent') as HTMLInputElement).value = '123456';
  (pinNode('google2PinNew') as HTMLInputElement).value = '135790';
  (pinNode('google2PinConfirm') as HTMLInputElement).value = '135790';
  submitPinForm();
  await flush();
  return { log };
}

describe('T-004R PIN 更新已生效但新 PIN 会话续期失败（N1 文案与可重新解锁）', () => {
  it.each(['enable', 'change'] as const)('%s：提示续期失败而非修改失败，状态为已启用且可重新解锁', async (mode) => {
    const { log } = await runRenewFailure(mode);

    const put = log.find('PUT', '/settings/pin');
    expect(put).toHaveLength(1);
    expect(put[0].body).toEqual({ version: mode === 'change' ? 5 : 2, enabled: true, pin: '135790' });
    const verifies = log.find('POST', '/settings/pin/verify');
    expect(verifies.map((call) => call.body.pin)).toContain('135790');
    expect(localStorage.getItem('dafan_google2_pin_token')).toBeNull();
    expect(pinNode('google2PinStatus').textContent).toBe('已启用');
    expect(pinNode('google2PinEnable').classList.contains('hidden')).toBe(true);
    expect(pinNode('google2PinChange').classList.contains('hidden')).toBe(false);
    expect(pinError()).toBe(PIN_RENEW_FAILED);
    expect(pinError()).not.toBe(PIN_UPDATE_FAILED);

    // 会话续期失败后仍可重新解锁，新 token 正常落盘
    const unlocked = (window as any).DafanPinAdapter.ensurePinUnlock();
    await flush();
    expect(unlockModalHidden()).toBe(false);
    submitUnlockForm('135790');
    await flush();
    await expect(unlocked).resolves.toBe('tok-unlock');
    expect(localStorage.getItem('dafan_google2_pin_token')).toBe('tok-unlock');
    expect(unlockModalHidden()).toBe(true);
  });

  it('续期在途时取消并重开，旧失败不得写入新设置弹窗', async () => {
    let finishRenew!: (value: unknown) => void;
    const pendingRenew = new Promise((resolve) => {
      finishRenew = resolve;
    });
    const { log } = await mountSettings({ verify: () => pendingRenew });
    const settings = (window as any).DafanSettingsAdapter;
    settings.openPinSettings('enable');
    (pinNode('google2PinNew') as HTMLInputElement).value = '135790';
    (pinNode('google2PinConfirm') as HTMLInputElement).value = '135790';
    submitPinForm();
    await flush();
    expect(log.find('PUT', '/settings/pin')).toHaveLength(1);
    (pinNode('google2PinSettingsCancel') as HTMLButtonElement).click();
    expect(settings.openPinSettings('enable')).toBe(true);
    (pinNode('google2PinNew') as HTMLInputElement).value = '246810';
    finishRenew(apiFail(500, 'INTERNAL_ERROR', '续期失败'));
    await flush();
    expect(pinError()).toBe('');
    expect((pinNode('google2PinNew') as HTMLInputElement).value).toBe('246810');
    expect(pinNode('modalPinSettings').classList.contains('hidden')).toBe(false);
  });
});

describe('T-004R 收藏与编辑关系数据完整性', () => {
  const fullRecipe = () => ({
    id: 'recipe-relations',
    version: 1,
    name: `菜谱${PAYLOADS.img}`,
    favorite: false,
    cookingTimeMinutes: 20,
    ingredients: [{ ingredientNameSnapshot: `食材${PAYLOADS.svg}`, amountText: '2个' }],
    steps: [{ stepNo: 1, title: `步骤${PAYLOADS.quotes}`, content: `正文${PAYLOADS.script}`, timerMinutes: 1 }],
    tags: [{ name: '家常' }],
    mealTypes: ['LUNCH'],
    mealRoles: ['MAIN'],
    tools: []
  });

  it('初次列表加载后直接展示收藏，无需点击筛选', async () => {
    const recipe = { ...fullRecipe(), favorite: true };
    const store = { id: 'store-relations', name: `店铺${PAYLOADS.svg}`, favorite: true, supportsDineIn: true };
    bootWithAdapter((url, init) => {
      if (/\/recipes(?:\?|$)/.test(url)) return apiOk({ items: [recipe], totalPages: 1 });
      if (/\/stores(?:\?|$)/.test(url)) return apiOk({ items: [store], totalPages: 1 });
      return defaultRoute(url, init);
    });
    await flush();
    const favorites = document.getElementById('favoritesCardGrid')!;
    expect(favorites.querySelectorAll('.favorite-item-card')).toHaveLength(2);
    expect(favorites.textContent).toContain(recipe.name);
    expect(favorites.textContent).toContain(store.name);
    expectInert(favorites);
  });

  it('收藏基础响应不清除已加载关系，编辑字段仍逐值回填', async () => {
    const recipe = fullRecipe();
    bootWithAdapter((url, init) => {
      if (url.endsWith('/recipes/recipe-relations/favorite'))
        return apiOk({ id: recipe.id, name: recipe.name, version: 2, favorite: true });
      if (url.endsWith('/recipes/recipe-relations')) return apiOk({ ...recipe, version: 2, favorite: true });
      if (/\/recipes(?:\?|$)/.test(url)) return apiOk({ items: [recipe], totalPages: 1 });
      return defaultRoute(url, init);
    });
    await flush();
    await service().recipes.toggleFavorite(recipe.id);
    const cached = service().recipes.getById(recipe.id);
    expect(cached.ingredients).toHaveLength(1);
    expect(cached.steps).toHaveLength(1);
    expect(cached.mealTypeKeys).toEqual(['LUNCH']);
    expect(cached.mealRoleKeys).toEqual(['MAIN']);
    expect(cached.tagNames).toEqual(['家常']);
    (window as any).BentoModal.setupRecipeForm(recipe.id);
    expect((document.querySelector('#formRecipeIngList .recipe-ing-name') as HTMLInputElement).value).toBe(
      recipe.ingredients[0].ingredientNameSnapshot
    );
    expect((document.querySelector('#formRecipeStepList .recipe-step-title') as HTMLInputElement).value).toBe(
      recipe.steps[0].title
    );
    expect((document.querySelector('#formRecipeStepList .recipe-step-desc') as HTMLTextAreaElement).value).toBe(
      recipe.steps[0].content
    );
  });

  it('详情 DTO 编辑入口重新取远端，补全不完整缓存', async () => {
    const recipe = fullRecipe();
    const fetchMock = bootWithAdapter((url, init) => {
      if (url.endsWith('/recipes/recipe-relations')) return apiOk(recipe);
      return defaultRoute(url, init);
    });
    await flush();
    service().recipes.data = [{ id: recipe.id, name: recipe.name, version: 1, ingredients: [], steps: [] }];
    fetchMock.mockClear();
    (window as any).openEditRecipe(recipe);
    await flush();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/recipes/recipe-relations'))).toBe(true);
    expect((document.querySelector('#formRecipeIngList .recipe-ing-name') as HTMLInputElement).value).toBe(
      recipe.ingredients[0].ingredientNameSnapshot
    );
    expect((document.querySelector('#formRecipeStepList .recipe-step-title') as HTMLInputElement).value).toBe(
      recipe.steps[0].title
    );
  });
});

describe('T-004R 详情 DTO 动作与计时完成回归', () => {
  it.each(['recipes', 'stores'] as const)('%s 详情排餐 DTO 自动预选并提交当前真实 ID', async (domain) => {
    bootInline();
    const entity = domain === 'recipes' ? recipeFixture(PAYLOADS.quotes) : storeFixture(PAYLOADS.quotes);
    service()[domain].data = [entity];
    const modal = (window as any).BentoModal;
    modal.setupPlanPicker({ targetType: domain === 'recipes' ? 'recipe' : 'store', targetId: entity });
    const selected = (document.getElementById('planPickerSelectTarget') as HTMLInputElement).value;
    expect(selected).toContain(entity.id);
    expect(document.getElementById('comboboxTriggerText')?.textContent).toContain(entity.name);
    const add = vi.spyOn(service().plans, 'add').mockReturnValue(true);
    modal.handlePlanPickerSubmit({ preventDefault: vi.fn() });
    expect(add).toHaveBeenCalledOnce();
    expect(add.mock.calls[0][0]).toMatchObject({
      targetId: entity.id,
      targetType: domain === 'recipes' ? 'recipe' : 'store'
    });
    expect((window as any).__xss).toBeUndefined();
  });

  it.each(['recipes', 'stores'] as const)('%s 收藏入口接受详情 DTO 并传原始 ID', async (domain) => {
    bootInline();
    const entity = domain === 'recipes' ? recipeFixture(PAYLOADS.quotes) : storeFixture(PAYLOADS.quotes);
    entity.favorite = false;
    service()[domain].data = [entity];
    const toggle = vi.spyOn(service()[domain], 'toggleFavorite').mockResolvedValue(true);
    const action = domain === 'recipes' ? 'confirmToggleRecipeFavorite' : 'confirmToggleStoreFavorite';
    await (window as any)[action](entity);
    expect(toggle).toHaveBeenCalledExactlyOnceWith(entity.id);
  });

  it.each(['recipes', 'stores', 'pantry'] as const)(
    '%s 删除入口接受详情 DTO，确认原文后删除原始 ID',
    async (domain) => {
      bootInline();
      const entity =
        domain === 'recipes'
          ? recipeFixture(PAYLOADS.quotes)
          : domain === 'stores'
            ? storeFixture(PAYLOADS.quotes)
            : pantryFixture(PAYLOADS.quotes);
      service()[domain].data = [entity];
      const remove = vi.spyOn(service()[domain], 'delete').mockResolvedValue(true);
      vi.spyOn((window as any).BentoModal, 'close').mockImplementation(() => undefined);
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const action =
        domain === 'recipes'
          ? 'confirmDeleteRecipe'
          : domain === 'stores'
            ? 'confirmDeleteStore'
            : 'confirmDeletePantryItem';
      await (window as any)[action](entity);
      expect(String(confirm.mock.calls[0][0])).toContain(entity.name);
      expect(remove).toHaveBeenCalledExactlyOnceWith(entity.id);
    }
  );

  it('真实步骤按钮完成后仅关闭闹铃，不重新起计时；暂停与继续仍正常', async () => {
    vi.useFakeTimers();
    bootInline();
    const recipe = recipeFixture('计时菜谱', 'timer-recipe');
    recipe.steps[0].timerMinutes = 1;
    service().recipes.data = [recipe];
    const audio = (window as any).BentoAudioManager;
    vi.spyOn(audio, 'playTimerAlarm').mockImplementation(() => undefined);
    const stop = vi.spyOn(audio, 'stopTimerAlarm').mockImplementation(() => undefined);
    (window as any).BentoModal.setupRecipeDetail(recipe.id);
    const button = document.getElementById('stepTimerBtn-0') as HTMLButtonElement;
    const capsule = document.getElementById('globalTimerCapsule') as HTMLElement;
    button.click();
    await vi.advanceTimersByTimeAsync(1000);
    button.click();
    expect(button.textContent).toContain('继续计时');
    button.click();
    await vi.advanceTimersByTimeAsync(60000);
    expect(button.textContent).toContain('点击关闭闹铃');
    button.click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(stop).toHaveBeenCalledExactlyOnceWith('timer-recipe_step_0');
    expect(button.textContent).toBe('✓ 计时已完成');
    expect(capsule.classList.contains('hidden')).toBe(true);
    button.click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.textContent).toBe('✓ 计时已完成');
    expect(capsule.classList.contains('hidden')).toBe(true);
    vi.clearAllTimers();
  });
});
