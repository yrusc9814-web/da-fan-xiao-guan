// @vitest-environment jsdom
/**
 * T-005 菜谱自定义封面：用户行为契约测试。
 *
 * 只通过真实 DOM 事件与可观察的 API 请求/响应断言行为，不导入或复制生产内部函数：
 * - 历史裸占位文件名（steamed-fish.png / shrimp.png）在纯文本槽位必须是干净 Emoji，绝不出现 <img>；
 * - 合法 /uploads/*.JPG|PNG|WEBP 才允许成为 <img>，加载失败回退 Emoji；
 * - 恶意/穿越路径绝不产生 <img>，也不出现内联事件属性；
 * - 表单选择文件 → 上传 → 菜谱保存的完整链路、替换/移除/未改动/历史脏值、失败重提缓存、
 *   取消重开时在途上传不污染新表单、objectURL 释放。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapterSource = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');
const markup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

type Call = { method: string; path: string; body: any; bodyType: 'json' | 'form' | 'none' };
type Route = (url: string, init?: RequestInit) => unknown;

const apiOk = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  text: async () => JSON.stringify({ success: status >= 200 && status < 300, data })
});

const apiFail = (status: number, code: string, message: string) => ({
  ok: false,
  status,
  headers: new Headers(),
  text: async () => JSON.stringify({ success: false, error: { code, message } })
});

const page = { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 };

const flush = async () => {
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
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

/**
 * fetch 记录器：只保留 method / path / 可观察 body，不保留 headers 或 PIN token，
 * 避免测试失败输出泄露凭据。
 */
function boot(route: Route) {
  document.body.innerHTML = markup;
  defineInnerText();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const path = String(url).replace('/api/v1', '');
    let body: any = null;
    let bodyType: Call['bodyType'] = 'none';
    if (init?.body instanceof FormData) {
      bodyType = 'form';
      body = Array.from(init.body.entries()).map(([key, value]) => [
        key,
        value instanceof File ? { name: value.name, type: value.type, size: value.size } : String(value)
      ]);
    } else if (typeof init?.body === 'string') {
      bodyType = 'json';
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, path, body, bodyType });
    const result = (await route(String(url), init)) as any;
    return result && typeof result.text === 'function' ? result : apiOk(result);
  });
  vi.stubGlobal('fetch', fetchMock);
  window.eval(inline);
  window.eval(adapterSource);
  const find = (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path);
  const uploads = () => calls.filter((call) => call.path === '/uploads/images');
  return { fetchMock, calls, find, uploads };
}

function defaultRoute(url: string, init?: RequestInit) {
  const method = (init?.method || 'GET').toUpperCase();
  if (url.endsWith('/settings/pin/session')) return apiOk({ valid: false });
  if (url.endsWith('/settings')) return apiOk({ version: 1, pinEnabled: false });
  if (url.endsWith('/dashboard')) return apiOk({});
  if (method !== 'GET') return apiOk({});
  return apiOk(page);
}

const service = () => (window as any).BentoService;
const domain = () => (window as any).DafanDomainAdapter;
const modal = () => (window as any).BentoModal;

function recipeDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r-cover',
    name: '封面菜谱',
    category: '快手家常',
    cookingTimeMinutes: 25,
    difficulty: '简单',
    calories: 320,
    imagePath: null,
    ingredients: [],
    steps: [],
    tags: [],
    mealTypes: [],
    mealRoles: [],
    tools: [],
    version: 3,
    ...overrides
  };
}

/** 真实 file input 行为模拟：value='' 会同时清空 files（浏览器语义）。 */
function selectFile(input: HTMLInputElement, file: File) {
  let files: File[] = [file];
  Object.defineProperty(input, 'files', {
    configurable: true,
    get: () => files,
    set: (value: any) => {
      files = value ? Array.from(value) : [];
    }
  });
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => '',
    set: (value: string) => {
      if (!value) files = [];
    }
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input;
}

const file = (name: string, type: string, size = 1024) =>
  new File([new Uint8Array(Math.min(size, 16))], name, { type });

function stubObjectUrl() {
  const create = vi.fn(() => 'blob:http://localhost:3000/cover-preview');
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoke });
  return { create, revoke };
}

/** 不依赖生产内部函数：只检查容器里没有可执行/可外链的活动内容。 */
function expectNoActiveMarkup(container: Element | null) {
  expect(container).toBeTruthy();
  const scope = container as Element;
  expect(scope.querySelectorAll('script,iframe,object,embed')).toHaveLength(0);
  scope.querySelectorAll('*').forEach((node) => {
    Array.from(node.attributes).forEach((attr) => {
      expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
    });
  });
}

function toastText() {
  return document.getElementById('toastText')?.textContent || '';
}

function openRecipeForm(payload: unknown) {
  return modal().open('recipeForm', payload);
}

function recipeForm() {
  return document.querySelector('#modalRecipeForm form') as HTMLFormElement;
}

async function submitRecipeForm() {
  const form = recipeForm();
  await modal().handleRecipeFormSubmit({ preventDefault: vi.fn(), currentTarget: form });
  await flush();
}

const coverInput = () => document.getElementById('recipeCoverFileInput') as HTMLInputElement;
const coverPreview = () => document.getElementById('recipeCoverPreview') as HTMLElement;
const removeCoverButton = () => document.getElementById('btnRemoveRecipeCover') as HTMLElement;
const recipeModal = () => document.getElementById('modalRecipeForm') as HTMLElement;
const isRecipeFormOpen = () => !recipeModal().classList.contains('hidden');

/** 让测试控制响应到达时机（模拟旧保存仍在等待时用户关闭/重开表单）。 */
function deferredResponse<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 每次预览返回不同 objectURL，便于区分「旧会话预览」与「新会话预览」。 */
function stubObjectUrlSequence() {
  let index = 0;
  const create = vi.fn(() => `blob:http://localhost:3000/cover-${(index += 1)}`);
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoke });
  return { create, revoke };
}

let urls: { create: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> };

beforeEach(() => {
  localStorage.clear();
  urls = stubObjectUrl();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (URL as any).createObjectURL;
  delete (URL as any).revokeObjectURL;
  document.body.innerHTML = '';
});

describe('T-005 历史占位文件名与纯文本图标槽位', () => {
  it('steamed-fish.png / shrimp.png 映射为分类 Emoji，coverUrl 为 null，卡片不产生 <img>', () => {
    boot(defaultRoute);
    const fish = domain().mapRecipe(recipeDto({ imagePath: 'steamed-fish.png', category: '鲜美水产' }));
    const shrimp = domain().mapRecipe(recipeDto({ id: 'r-shrimp', imagePath: 'shrimp.png', category: null }));
    expect(fish.coverUrl).toBeNull();
    expect(fish.icon).toBe('🐟');
    expect(shrimp.coverUrl).toBeNull();
    expect(shrimp.icon).toBe('🥘');
    expect(JSON.stringify([fish.icon, shrimp.icon])).not.toContain('.png');

    service().recipes.data = [fish, shrimp];
    (window as any).renderRecipes();
    const grid = document.getElementById('recipesCardGrid') as HTMLElement;
    expect(grid.querySelectorAll('img')).toHaveLength(0);
    expect(grid.textContent).not.toContain('.png');
    expectNoActiveMarkup(grid);
  });

  it('食材/店铺/排餐目标的纯文本槽位同样不泄露文件名', () => {
    boot(defaultRoute);
    const pantry = domain().mapPantryItem({ id: 'i1', name: '鲈鱼', imagePath: 'steamed-fish.png' });
    const store = domain().mapStore({ id: 's1', name: '小店', imagePath: 'shrimp.png', cuisine: '日式料理' });
    const plan = domain().mapPlan({
      id: 'p1',
      planDate: '2026-11-15',
      mealType: 'LUNCH',
      items: [{ itemType: 'RECIPE', recipe: { id: 'r1', name: '清蒸鲈鱼', imagePath: 'steamed-fish.png' } }]
    });
    // C5：食材图标按名称关键词派生（鲈鱼 → 🐟），不再全员 🥬
    expect(pantry.icon).toBe('🐟');
    expect(store.icon).toBe('🍱');
    // 排餐目标自身的 icon 由 mapPlan 的 p.icon 覆盖，这里只断言纯文本槽位绝不泄露文件名/上传路径
    [pantry.icon, store.icon, plan.icon].forEach((icon) => {
      expect(String(icon ?? '')).not.toMatch(/\.(png|jpe?g|webp)$/i);
      expect(String(icon ?? '')).not.toContain('/uploads/');
    });
  });
});

describe('T-005 合法封面与恶意路径', () => {
  it.each(['/uploads/a.JPG', '/uploads/b.PNG', '/uploads/c.WEBP', '/uploads/2026/11/photo.jpeg'])(
    '合法上传路径 %s 成为 coverUrl 并渲染安全 <img>',
    (imagePath) => {
      boot(defaultRoute);
      const mapped = domain().mapRecipe(recipeDto({ imagePath }));
      expect(mapped.coverUrl).toBe(imagePath);
      expect(mapped.icon).toBe('🍳');

      service().recipes.data = [mapped];
      (window as any).renderRecipes();
      const cover = document.querySelector('#recipesCardGrid .h-28') as HTMLElement;
      const image = cover.querySelector('img') as HTMLImageElement;
      expect(image).toBeTruthy();
      expect(image.getAttribute('src')).toBe(imagePath);
      expect(image.className).toContain('object-cover');
      expect(cover.textContent).toContain('🍳');
      expectNoActiveMarkup(cover);
    }
  );

  it.each([
    '/uploads/../secret.jpg',
    '/uploads/a\\b.png',
    '/uploads/<svg onload=alert(1)>.png',
    '/uploads/evil.jpg" onerror="window.__xss=1',
    'https://evil.example/a.jpg',
    'javascript:alert(1)',
    'steamed-fish.png',
    '"><img src=x onerror=window.__xss=1>'
  ])('恶意封面值 %s 不产生 <img> 也不产生事件属性', (imagePath) => {
    boot(defaultRoute);
    delete (window as any).__xss;
    const mapped = domain().mapRecipe(recipeDto({ imagePath }));
    expect(mapped.coverUrl).toBeNull();
    service().recipes.data = [mapped];
    (window as any).renderRecipes();
    (window as any).renderFavorites();
    const grid = document.getElementById('recipesCardGrid') as HTMLElement;
    const favorites = document.getElementById('favoritesCardGrid') as HTMLElement;
    expect(grid.querySelectorAll('img')).toHaveLength(0);
    expect(favorites.querySelectorAll('img')).toHaveLength(0);
    expect(grid.textContent).not.toContain('onerror');
    expect(grid.textContent).not.toContain('steamed-fish.png');
    expect((window as any).__xss).toBeUndefined();
    expectNoActiveMarkup(grid);
  });

  it('封面 <img> 加载失败时移除自身并露出 Emoji 兜底', () => {
    boot(defaultRoute);
    const mapped = domain().mapRecipe(recipeDto({ imagePath: '/uploads/missing.png', category: '暖胃炖菜' }));
    service().recipes.data = [mapped];
    (window as any).renderRecipes();
    const cover = document.querySelector('#recipesCardGrid .h-28') as HTMLElement;
    const image = cover.querySelector('img') as HTMLImageElement;
    expect(image).toBeTruthy();
    image.dispatchEvent(new Event('error'));
    expect(cover.querySelectorAll('img')).toHaveLength(0);
    expect(cover.textContent).toContain('🥘');
  });
});

describe('T-005 全站封面展示', () => {
  it('详情弹窗展示可放大的封面，点击后灯箱使用同一合法地址', () => {
    boot(defaultRoute);
    const mapped = domain().mapRecipe(recipeDto({ imagePath: '/uploads/detail.png' }));
    service().recipes.data = [mapped];
    modal().setupRecipeDetail(mapped);
    const iconBox = document.getElementById('recipeDetailIcon') as HTMLElement;
    const image = iconBox.querySelector('img') as HTMLImageElement;
    expect(image).toBeTruthy();
    expect(image.getAttribute('src')).toBe('/uploads/detail.png');
    image.click();
    expect(document.getElementById('modalImageLightbox')?.classList.contains('hidden')).toBe(false);
    expect((document.getElementById('lightboxImg') as HTMLImageElement).getAttribute('src')).toBe(
      '/uploads/detail.png'
    );
    expectNoActiveMarkup(iconBox);
  });

  it('收藏页与食材详情关联菜谱显示封面缩略图，无封面时保持 Emoji', async () => {
    boot(defaultRoute);
    const withCover = domain().mapRecipe(
      recipeDto({ id: 'r-fav', name: '封面收藏菜', imagePath: '/uploads/fav.png', favorite: true })
    );
    const plain = domain().mapRecipe(recipeDto({ id: 'r-plain', name: '无封面菜', favorite: false }));
    service().recipes.data = [withCover, plain];
    service().pantry.data = [
      { id: 'i-fish', name: '鲈鱼', stock: 2, unit: '个', category: '水产', storageLocation: '冷藏室' }
    ];
    service().pantry.getById = (id: string) => service().pantry.data.find((x: any) => x.id === id);
    (window as any).renderFavorites();
    const favoriteCard = document.querySelector('#favoritesCardGrid img') as HTMLImageElement;
    expect(favoriteCard).toBeTruthy();
    expect(favoriteCard.getAttribute('src')).toBe('/uploads/fav.png');

    const related = domain().mapRecipe(
      recipeDto({
        id: 'r-related',
        name: '鲈鱼煲',
        imagePath: '/uploads/related.png',
        ingredients: [{ name: '鲈鱼', amount: '1条', quantity: 1, unit: 'PIECE', ingredientId: null }]
      })
    );
    service().recipes.data = [related];
    modal().setupIngredientDetail('i-fish');
    const relatedBox = document.getElementById('ingredientDetailRelatedRecipes') as HTMLElement;
    const relatedImage = relatedBox.querySelector('img') as HTMLImageElement;
    expect(relatedImage).toBeTruthy();
    expect(relatedImage.getAttribute('src')).toBe('/uploads/related.png');
    expectNoActiveMarkup(relatedBox);
  });

  it('首页今日推荐：合法封面渲染 <img>，历史占位名恢复默认 🥘 且无 <img>', () => {
    boot(defaultRoute);
    (window as any).DafanDashboardAdapter.mapDashboard({
      recommendedRecipes: [
        { id: 'r1', name: '有封面', imagePath: '/uploads/home.png', tags: [], cookingTimeMinutes: 20 },
        { id: 'r2', name: '历史占位', imagePath: 'steamed-fish.png', tags: [], cookingTimeMinutes: 20 }
      ]
    });
    const cards = Array.from(document.querySelectorAll('[data-binding="recommendedRecipes"] > div')) as HTMLElement[];
    const firstCover = cards[0].querySelector('.h-24') as HTMLElement;
    const secondCover = cards[1].querySelector('.h-24') as HTMLElement;
    expect(firstCover.querySelector('img')?.getAttribute('src')).toBe('/uploads/home.png');
    expect(secondCover.querySelectorAll('img')).toHaveLength(0);
    expect(secondCover.textContent).toContain('🥘');
    expect(secondCover.textContent).not.toContain('.png');
    expectNoActiveMarkup(firstCover);
  });
});

describe('T-005 详情空字段与空列表', () => {
  it('分类/难度/热量缺失时无孤立分隔点、无空难度胶囊，副标题行隐藏', () => {
    boot(defaultRoute);
    const mapped = domain().mapRecipe(
      recipeDto({ id: 'r-empty-meta', category: null, difficulty: null, calories: null, cookingTimeMinutes: 25 })
    );
    service().recipes.data = [mapped];
    modal().setupRecipeDetail(mapped);
    const row = document.getElementById('recipeDetailMetaRow') as HTMLElement;
    expect(row.textContent).toContain('⏱ 25分钟');
    expect(row.textContent).not.toContain('·');
    expect(row.querySelectorAll('.bg-amber-100')).toHaveLength(0);
    expect(row.textContent).not.toContain('难度');

    const blank = domain().mapRecipe(
      recipeDto({
        id: 'r-all-empty',
        category: null,
        difficulty: null,
        calories: null,
        cookingTimeMinutes: null
      })
    );
    service().recipes.data = [blank];
    modal().setupRecipeDetail(blank);
    expect(row.classList.contains('hidden')).toBe(true);
    expect((row.textContent || '').trim()).toBe('');
  });

  it('四项元数据齐全时用真实项之间的分隔符，难度胶囊保留', () => {
    boot(defaultRoute);
    const mapped = domain().mapRecipe(
      recipeDto({ id: 'r-full-meta', category: '快手家常', difficulty: '简单', calories: 320, cookingTimeMinutes: 25 })
    );
    service().recipes.data = [mapped];
    modal().setupRecipeDetail(mapped);
    const row = document.getElementById('recipeDetailMetaRow') as HTMLElement;
    expect(row.querySelectorAll('.bg-amber-100')).toHaveLength(1);
    expect(row.textContent).toContain('快手家常');
    expect(row.textContent).toContain('⏱ 25分钟');
    expect(row.textContent).toContain('简单难度');
    expect(row.textContent).toContain('320 kcal');
    expect((row.textContent.match(/·/g) || []).length).toBe(3);
    expect(row.textContent).not.toContain('•');
  });

  it('食材与步骤为空时给出明确空状态提示，不留空白列表', () => {
    boot(defaultRoute);
    const mapped = domain().mapRecipe(recipeDto({ id: 'r-no-lists', ingredients: [], steps: [] }));
    service().recipes.data = [mapped];
    modal().setupRecipeDetail(mapped);
    const ingredients = document.getElementById('recipeDetailIngredientsList') as HTMLElement;
    const steps = document.getElementById('recipeDetailStepsList') as HTMLElement;
    expect(ingredients.textContent).toContain('暂未录入食材配方');
    expect(steps.textContent).toContain('暂未录入分步做法');
    expectNoActiveMarkup(ingredients);
    expectNoActiveMarkup(steps);
  });

  it('卡片难度为空时不渲染空难度胶囊', () => {
    boot(defaultRoute);
    const mapped = domain().mapRecipe(recipeDto({ id: 'r-no-diff', difficulty: null, calories: null }));
    service().recipes.data = [mapped];
    (window as any).renderRecipes();
    const grid = document.getElementById('recipesCardGrid') as HTMLElement;
    expect(grid.querySelectorAll('.bg-amber-100')).toHaveLength(0);
    expect(grid.textContent).not.toContain('null');
  });

  it.each(['', '   '])('难度为空白字符串 %j 时详情不出现空胶囊或孤立分隔点，卡片不出现空胶囊', (difficulty) => {
    boot(defaultRoute);
    const blankOnly = domain().mapRecipe(
      recipeDto({
        id: 'r-blank-diff',
        difficulty,
        category: null,
        calories: null,
        cookingTimeMinutes: null
      })
    );
    service().recipes.data = [blankOnly];
    modal().setupRecipeDetail(blankOnly);
    const row = document.getElementById('recipeDetailMetaRow') as HTMLElement;
    expect(row.querySelectorAll('.bg-amber-100')).toHaveLength(0);
    expect(row.textContent).not.toContain('难度');
    expect(row.textContent).not.toContain('·');
    expect(row.classList.contains('hidden')).toBe(true);

    // 难度空白但其他元数据存在：只保留真实项，分隔符数量等于「真实项 - 1」
    const withTime = domain().mapRecipe(
      recipeDto({ id: 'r-blank-diff-time', difficulty, category: null, calories: 320, cookingTimeMinutes: 25 })
    );
    service().recipes.data = [withTime];
    modal().setupRecipeDetail(withTime);
    expect(row.querySelectorAll('.bg-amber-100')).toHaveLength(0);
    expect(row.textContent).not.toContain('难度');
    expect(row.textContent).toContain('⏱ 25分钟');
    expect(row.textContent).toContain('320 kcal');
    expect((row.textContent.match(/·/g) || []).length).toBe(1);
    expect(row.classList.contains('hidden')).toBe(false);

    (window as any).renderRecipes();
    const grid = document.getElementById('recipesCardGrid') as HTMLElement;
    expect(grid.querySelectorAll('.bg-amber-100')).toHaveLength(0);
    expect(grid.textContent).not.toContain('null');
  });
});

describe('T-005 新建/编辑表单标题图标', () => {
  it('先编辑历史占位文件名菜谱，再新建：标题图标重置为 🍳 且不显示文件名', async () => {
    boot(defaultRoute);
    const mapped = domain().mapRecipe(
      recipeDto({ id: 'r-legacy', name: '历史菜', imagePath: 'shrimp.png', category: '快手家常' })
    );
    service().recipes.data = [mapped];
    await openRecipeForm('r-legacy');
    expect((document.getElementById('formRecipeIconPreview') as HTMLElement).textContent).toBe('🍳');
    expect((document.getElementById('formRecipeIcon') as HTMLInputElement).value).toBe('🍳');
    expect((document.getElementById('formRecipeIconPreview') as HTMLElement).textContent).not.toContain('.png');
    modal().close(true);
    await openRecipeForm(null);
    expect((document.getElementById('formRecipeIconPreview') as HTMLElement).textContent).toBe('🍳');
    expect((document.getElementById('formRecipeIcon') as HTMLInputElement).value).toBe('🍳');
    expect((document.getElementById('formRecipeName') as HTMLInputElement).value).toBe('');
  });
});

describe('T-005 封面文件选择校验', () => {
  it('不支持的 MIME 被拒绝：Toast 提示、input 清空、无预览、提交不发上传请求', async () => {
    const { uploads } = boot(defaultRoute);
    await openRecipeForm(null);
    selectFile(coverInput(), file('note.txt', 'text/plain'));
    await flush();
    expect(toastText()).toContain('JPG');
    expect(coverPreview().querySelectorAll('img')).toHaveLength(0);
    expect(coverInput().files).toHaveLength(0);
    (document.getElementById('formRecipeName') as HTMLInputElement).value = '非法封面菜';
    (document.getElementById('formRecipeTime') as HTMLInputElement).value = '20';
    await submitRecipeForm();
    expect(uploads()).toHaveLength(0);
  });

  it('超过 8MB 的图片被拒绝：Toast 提示、input 清空、无预览', async () => {
    boot(defaultRoute);
    await openRecipeForm(null);
    const big = file('big.jpg', 'image/jpeg');
    Object.defineProperty(big, 'size', { configurable: true, value: 8 * 1024 * 1024 + 1 });
    selectFile(coverInput(), big);
    await flush();
    expect(toastText()).toContain('8MB');
    expect(coverPreview().querySelectorAll('img')).toHaveLength(0);
    expect(coverInput().files).toHaveLength(0);
  });

  it.each([
    ['image/jpeg', 'a.jpg'],
    ['image/png', 'a.png'],
    ['image/webp', 'a.webp']
  ])('接受 %s 并在预览区显示受控 <img> 与移除按钮', async (type, name) => {
    boot(defaultRoute);
    await openRecipeForm(null);
    selectFile(coverInput(), file(name, type));
    await flush();
    const image = coverPreview().querySelector('img') as HTMLImageElement;
    expect(image).toBeTruthy();
    expect(image.getAttribute('src')).toBe('blob:http://localhost:3000/cover-preview');
    expect(image.className).toContain('object-cover');
    expect((document.getElementById('btnChooseRecipeCover') as HTMLElement).textContent).toContain('更换封面');
    expect(removeCoverButton().classList.contains('hidden')).toBe(false);
    expect(document.getElementById('recipeCoverHint')?.classList.contains('hidden')).toBe(true);
    expectNoActiveMarkup(coverPreview());
  });

  it('编辑合法封面时回显既有图；移除后回到引导态并释放 objectURL', async () => {
    boot(defaultRoute);
    const mapped = domain().mapRecipe(recipeDto({ id: 'r-existing', imagePath: '/uploads/existing.png' }));
    service().recipes.data = [mapped];
    await openRecipeForm('r-existing');
    const existingImage = coverPreview().querySelector('img') as HTMLImageElement;
    expect(existingImage.getAttribute('src')).toBe('/uploads/existing.png');

    selectFile(coverInput(), file('new.png', 'image/png'));
    await flush();
    expect(coverPreview().querySelector('img')?.getAttribute('src')).toBe('blob:http://localhost:3000/cover-preview');
    removeCoverButton().click();
    await flush();
    expect(coverPreview().querySelectorAll('img')).toHaveLength(0);
    expect(coverPreview().textContent).toContain('点击上传成品美图');
    expect(removeCoverButton().classList.contains('hidden')).toBe(true);
    expect(urls.revoke).toHaveBeenCalledWith('blob:http://localhost:3000/cover-preview');
  });
});

describe('T-005 封面上传与菜谱保存链路', () => {
  it('新建：FormData 上传后 POST /recipes 携带 imagePath，且 FormData 不写 Content-Type', async () => {
    const { calls, uploads, fetchMock } = boot((url, init) => {
      if (url.endsWith('/uploads/images')) return apiOk({ url: '/uploads/new-cover.png', thumbnailUrl: null });
      if (url.endsWith('/recipes') && init?.method === 'POST')
        return apiOk(recipeDto({ id: 'r-new', imagePath: '/uploads/new-cover.png' }));
      return defaultRoute(url, init);
    });
    await openRecipeForm(null);
    (document.getElementById('formRecipeName') as HTMLInputElement).value = '新建封面菜';
    (document.getElementById('formRecipeTime') as HTMLInputElement).value = '30';
    selectFile(coverInput(), file('cover.png', 'image/png'));
    await flush();
    await submitRecipeForm();

    const upload = uploads()[0];
    expect(upload).toBeTruthy();
    expect(upload.bodyType).toBe('form');
    expect(upload.body).toEqual([['file', { name: 'cover.png', type: 'image/png', size: 16 }]]);
    const uploadInit = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/uploads/images'))?.[1];
    const uploadHeaders = (uploadInit?.headers || {}) as Record<string, string>;
    expect(Object.keys(uploadHeaders).some((key) => key.toLowerCase() === 'content-type')).toBe(false);

    const post = calls.find((call) => call.method === 'POST' && call.path === '/recipes');
    expect(post).toBeTruthy();
    expect(post!.body.imagePath).toBe('/uploads/new-cover.png');
  });

  it('编辑替换封面：PUT 携带新上传地址', async () => {
    const { calls, uploads } = boot((url, init) => {
      if (url.endsWith('/uploads/images')) return apiOk({ url: '/uploads/replaced.webp' });
      if (url.includes('/recipes/r-edit') && init?.method === 'PUT')
        return apiOk(recipeDto({ id: 'r-edit', imagePath: '/uploads/replaced.webp' }));
      return defaultRoute(url, init);
    });
    const mapped = domain().mapRecipe(recipeDto({ id: 'r-edit', imagePath: '/uploads/old.png' }));
    service().recipes.data = [mapped];
    await openRecipeForm('r-edit');
    selectFile(coverInput(), file('replace.webp', 'image/webp'));
    await flush();
    await submitRecipeForm();
    expect(uploads()).toHaveLength(1);
    const put = calls.find((call) => call.method === 'PUT' && call.path === '/recipes/r-edit');
    expect(put!.body.imagePath).toBe('/uploads/replaced.webp');
  });

  it('编辑未触碰封面：保留既有 imagePath，不发上传请求', async () => {
    const { calls, uploads } = boot((url, init) => {
      if (url.includes('/recipes/r-keep') && init?.method === 'PUT')
        return apiOk(recipeDto({ id: 'r-keep', imagePath: '/uploads/keep.jpg' }));
      return defaultRoute(url, init);
    });
    const mapped = domain().mapRecipe(recipeDto({ id: 'r-keep', imagePath: '/uploads/keep.jpg' }));
    service().recipes.data = [mapped];
    await openRecipeForm('r-keep');
    await submitRecipeForm();
    expect(uploads()).toHaveLength(0);
    const put = calls.find((call) => call.method === 'PUT' && call.path === '/recipes/r-keep');
    expect(put!.body.imagePath).toBe('/uploads/keep.jpg');
  });

  it('编辑历史裸占位文件名且未触碰封面：保存显式 null 修正脏值', async () => {
    const { calls } = boot((url, init) => {
      if (url.includes('/recipes/r-dirty') && init?.method === 'PUT')
        return apiOk(recipeDto({ id: 'r-dirty', imagePath: null }));
      return defaultRoute(url, init);
    });
    const mapped = domain().mapRecipe(recipeDto({ id: 'r-dirty', imagePath: 'steamed-fish.png' }));
    service().recipes.data = [mapped];
    await openRecipeForm('r-dirty');
    await submitRecipeForm();
    const put = calls.find((call) => call.method === 'PUT' && call.path === '/recipes/r-dirty');
    expect(put!.body.imagePath).toBeNull();
  });

  it('编辑点移除封面：保存 imagePath null', async () => {
    const { calls } = boot((url, init) => {
      if (url.includes('/recipes/r-remove') && init?.method === 'PUT')
        return apiOk(recipeDto({ id: 'r-remove', imagePath: null }));
      return defaultRoute(url, init);
    });
    const mapped = domain().mapRecipe(recipeDto({ id: 'r-remove', imagePath: '/uploads/remove.png' }));
    service().recipes.data = [mapped];
    await openRecipeForm('r-remove');
    removeCoverButton().click();
    await flush();
    await submitRecipeForm();
    const put = calls.find((call) => call.method === 'PUT' && call.path === '/recipes/r-remove');
    expect(put!.body.imagePath).toBeNull();
  });

  it('上传成功但保存菜谱失败：重提复用已上传地址，不重复上传', async () => {
    let recipeAttempts = 0;
    const { calls, uploads } = boot((url, init) => {
      if (url.endsWith('/uploads/images')) return apiOk({ url: '/uploads/cached.png' });
      if (url.endsWith('/recipes') && init?.method === 'POST') {
        recipeAttempts += 1;
        return recipeAttempts === 1
          ? apiFail(500, 'INTERNAL_ERROR', '保存失败')
          : apiOk(recipeDto({ id: 'r-retry', imagePath: '/uploads/cached.png' }));
      }
      return defaultRoute(url, init);
    });
    await openRecipeForm(null);
    (document.getElementById('formRecipeName') as HTMLInputElement).value = '重试封面菜';
    (document.getElementById('formRecipeTime') as HTMLInputElement).value = '20';
    selectFile(coverInput(), file('retry.jpg', 'image/jpeg'));
    await flush();
    await submitRecipeForm();
    expect(uploads()).toHaveLength(1);
    expect(recipeAttempts).toBe(1);
    await submitRecipeForm();
    expect(uploads()).toHaveLength(1);
    expect(recipeAttempts).toBe(2);
    const posts = calls.filter((call) => call.method === 'POST' && call.path === '/recipes');
    expect(posts.map((call) => call.body.imagePath)).toEqual(['/uploads/cached.png', '/uploads/cached.png']);
  });

  it('取消并重开：旧上传完成后不 POST 旧菜谱，也不污染新表单预览', async () => {
    let resolveUpload!: (value: unknown) => void;
    const { calls } = boot((url, init) => {
      if (url.endsWith('/uploads/images'))
        return new Promise((resolve) => {
          resolveUpload = resolve;
        });
      if (url.endsWith('/recipes') && init?.method === 'POST')
        return apiOk(recipeDto({ id: 'r-new-after-cancel', imagePath: '/uploads/slow.png' }));
      return defaultRoute(url, init);
    });
    await openRecipeForm(null);
    (document.getElementById('formRecipeName') as HTMLInputElement).value = '旧表单';
    (document.getElementById('formRecipeTime') as HTMLInputElement).value = '20';
    selectFile(coverInput(), file('slow.png', 'image/png'));
    await flush();
    const pendingSubmit = modal().handleRecipeFormSubmit({
      preventDefault: vi.fn(),
      currentTarget: recipeForm()
    });
    await flush();
    modal().close(true);
    await openRecipeForm(null);
    expect((document.getElementById('formRecipeName') as HTMLInputElement).value).toBe('');
    expect(coverPreview().querySelectorAll('img')).toHaveLength(0);
    selectFile(coverInput(), file('fresh.png', 'image/png'));
    await flush();
    expect(coverPreview().querySelector('img')?.getAttribute('src')).toBe('blob:http://localhost:3000/cover-preview');

    resolveUpload(apiOk({ url: '/uploads/slow.png' }));
    await pendingSubmit;
    await flush();
    expect(calls.filter((call) => call.method === 'POST' && call.path === '/recipes')).toHaveLength(0);
    expect((document.getElementById('formRecipeName') as HTMLInputElement).value).toBe('');
    expect(urls.revoke).toHaveBeenCalledWith('blob:http://localhost:3000/cover-preview');
  });

  it('重开表单会释放上一次本地预览 objectURL', async () => {
    boot(defaultRoute);
    await openRecipeForm(null);
    selectFile(coverInput(), file('preview.png', 'image/png'));
    await flush();
    expect(urls.create).toHaveBeenCalledTimes(1);
    modal().close(true);
    await openRecipeForm(null);
    expect(urls.revoke).toHaveBeenCalledWith('blob:http://localhost:3000/cover-preview');
  });

  it('表单内联 onsubmit 接线到生产提交处理器并走同一上传与保存链路', async () => {
    const { uploads, calls } = boot((url, init) => {
      if (url.endsWith('/uploads/images')) return apiOk({ url: '/uploads/event.png' });
      if (url.endsWith('/recipes') && init?.method === 'POST')
        return apiOk(recipeDto({ id: 'r-event', imagePath: '/uploads/event.png' }));
      return defaultRoute(url, init);
    });
    await openRecipeForm(null);
    (document.getElementById('formRecipeName') as HTMLInputElement).value = '事件提交';
    (document.getElementById('formRecipeTime') as HTMLInputElement).value = '18';
    selectFile(coverInput(), file('event.png', 'image/png'));
    await flush();
    const form = recipeForm();
    // jsdom 内联处理器只认 window 上的裸标识符（生产页面由 window.BentoModal 提供），
    // 因此这里断言接线目标，再以浏览器提交时的同一入参调用该处理器。
    expect(form.getAttribute('onsubmit')).toContain('BentoModal.handleRecipeFormSubmit');
    expect(typeof (form as any).onsubmit).toBe('function');
    const preventDefault = vi.fn();
    await modal().handleRecipeFormSubmit({ preventDefault, currentTarget: form });
    await flush();
    await flush();
    expect(preventDefault).toHaveBeenCalled();
    expect(uploads()).toHaveLength(1);
    const post = calls.find((call) => call.method === 'POST' && call.path === '/recipes');
    expect(post?.body.imagePath).toBe('/uploads/event.png');
  });
});

describe('T-005 旧保存等待期间关闭/重开：会话隔离', () => {
  it('旧保存 pending 时关闭并重开，新表单仍可关闭；旧响应到达后不关闭新表单、不释放新预览', async () => {
    const firstSave = deferredResponse<any>();
    const { calls } = boot((url, init) => {
      if (url.endsWith('/recipes') && init?.method === 'POST') return firstSave.promise;
      return defaultRoute(url, init);
    });
    const sequence = stubObjectUrlSequence();

    await openRecipeForm(null);
    (document.getElementById('formRecipeName') as HTMLInputElement).value = '旧表单';
    (document.getElementById('formRecipeTime') as HTMLInputElement).value = '20';
    const oldSubmit = modal().handleRecipeFormSubmit({ preventDefault: vi.fn(), currentTarget: recipeForm() });
    await flush();
    expect(calls.filter((call) => call.method === 'POST' && call.path === '/recipes')).toHaveLength(1);
    expect(isRecipeFormOpen()).toBe(true);

    // 旧保存仍在等待时用户关闭表单
    modal().close(true);
    expect(isRecipeFormOpen()).toBe(false);

    await openRecipeForm(null);
    expect(isRecipeFormOpen()).toBe(true);
    expect((document.getElementById('formRecipeName') as HTMLInputElement).value).toBe('');
    selectFile(coverInput(), file('fresh.png', 'image/png'));
    await flush();
    expect(coverPreview().querySelector('img')?.getAttribute('src')).toBe('blob:http://localhost:3000/cover-1');

    // 核心回归：旧请求在途时，新表单必须仍能正常关闭，且不弹出脏检查确认框
    modal().close(true);
    expect(isRecipeFormOpen()).toBe(false);
    expect(document.getElementById('modalFormGuardConfirm')?.classList.contains('hidden')).toBe(true);

    // 再开新表单并保留新预览，让旧保存响应在此时到达
    await openRecipeForm(null);
    selectFile(coverInput(), file('fresh2.png', 'image/png'));
    await flush();
    const keptPreview = coverPreview().querySelector('img')?.getAttribute('src');
    expect(keptPreview).toBe('blob:http://localhost:3000/cover-2');

    firstSave.resolve(apiOk(recipeDto({ id: 'r-old', name: '旧表单', imagePath: null })));
    await oldSubmit;
    await flush();

    expect(isRecipeFormOpen()).toBe(true);
    expect((document.getElementById('formRecipeName') as HTMLInputElement).value).toBe('');
    expect(coverPreview().querySelector('img')?.getAttribute('src')).toBe(keptPreview);
    expect(sequence.revoke).not.toHaveBeenCalledWith(keptPreview);
    expect(document.getElementById('modalFormGuardConfirm')?.classList.contains('hidden')).toBe(true);
    // 旧会话的 toast 也不得弹到新会话上
    expect(toastText()).not.toContain('菜谱已创建');
    expect(toastText()).not.toContain('菜谱已更新');
  });

  it('旧保存 pending 时新会话仍能提交：不被旧表单的提交锁吞掉', async () => {
    const firstSave = deferredResponse<any>();
    const secondSave = deferredResponse<any>();
    let recipePosts = 0;
    const { calls } = boot((url, init) => {
      if (url.endsWith('/recipes') && init?.method === 'POST') {
        recipePosts += 1;
        return recipePosts === 1 ? firstSave.promise : secondSave.promise;
      }
      return defaultRoute(url, init);
    });

    await openRecipeForm(null);
    (document.getElementById('formRecipeName') as HTMLInputElement).value = '旧表单';
    (document.getElementById('formRecipeTime') as HTMLInputElement).value = '20';
    const oldSubmit = modal().handleRecipeFormSubmit({ preventDefault: vi.fn(), currentTarget: recipeForm() });
    await flush();
    expect(recipePosts).toBe(1);

    modal().close(true);
    await openRecipeForm(null);
    (document.getElementById('formRecipeName') as HTMLInputElement).value = '新表单';
    (document.getElementById('formRecipeTime') as HTMLInputElement).value = '15';

    // 真实 submit 事件 + 表单上注册的提交监听（与浏览器同一路径）。
    // jsdom 的内联 onsubmit 属性处理器无法解析裸标识符 BentoModal，故先摘掉属性，
    // 由 adapter 绑定到同一生产处理器 handleRecipeFormSubmit 的 submit 监听接管。
    const form = recipeForm();
    form.removeAttribute('onsubmit');
    const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);
    await flush();
    expect(submitEvent.defaultPrevented).toBe(true);
    expect(recipePosts).toBe(2);
    const posts = calls.filter((call) => call.method === 'POST' && call.path === '/recipes');
    expect(posts.map((call) => call.body.name)).toEqual(['旧表单', '新表单']);

    // 旧响应到达：不得关闭新表单
    firstSave.resolve(apiOk(recipeDto({ id: 'r-old', name: '旧表单', imagePath: null })));
    await oldSubmit;
    await flush();
    expect(isRecipeFormOpen()).toBe(true);

    // 新会话自己的响应到达：正常关闭
    secondSave.resolve(apiOk(recipeDto({ id: 'r-new', name: '新表单', imagePath: null })));
    await flush();
    expect(isRecipeFormOpen()).toBe(false);
  });
});

describe('T-005 表单封面加载失败恢复引导', () => {
  it('既有封面 <img> 加载失败时移除图片并恢复上传引导', async () => {
    boot(defaultRoute);
    const mapped = domain().mapRecipe(recipeDto({ id: 'r-broken', imagePath: '/uploads/broken.png' }));
    service().recipes.data = [mapped];
    await openRecipeForm('r-broken');
    const image = coverPreview().querySelector('img') as HTMLImageElement;
    expect(image?.getAttribute('src')).toBe('/uploads/broken.png');
    expect(removeCoverButton().classList.contains('hidden')).toBe(false);

    image.dispatchEvent(new Event('error'));
    await flush();

    expect(coverPreview().querySelectorAll('img')).toHaveLength(0);
    const hint = document.getElementById('recipeCoverHint') as HTMLElement;
    expect(hint).toBeTruthy();
    expect(hint.classList.contains('hidden')).toBe(false);
    expect(hint.textContent).toContain('点击上传成品美图');
    expectNoActiveMarkup(coverPreview());
  });
});

describe('T-005R 封面来源路径规范化', () => {
  const uuid = '1ae489b3-bb8d-419e-ad67-9621312e84fe';
  const validPaths = [`/uploads/${uuid}.jpg`, `/uploads/${uuid}.png`, `/uploads/${uuid}.webp`];
  const rejectedPaths = [
    '/uploads//a.png',
    '/uploads/./a.png',
    '/uploads/x/./a.png',
    '/uploads/x//a.png',
    '//evil.example/a.png'
  ];

  it('两个对外安全判定一致：// 与 /./ 拒绝，合法 uuid 三格式通过', () => {
    boot(defaultRoute);
    const guards: Array<[string, (value: unknown) => boolean]> = [
      ['window.isSafeUploadedCoverUrl', (window as any).isSafeUploadedCoverUrl],
      ['DafanCoverAdapter.isSafeUploadedCoverUrl', (window as any).DafanCoverAdapter.isSafeUploadedCoverUrl]
    ];
    guards.forEach(([label, guard]) => {
      expect(typeof guard, label).toBe('function');
      validPaths.forEach((path) => expect(guard(path), `${label} ${path}`).toBe(true));
      rejectedPaths.forEach((path) => expect(guard(path), `${label} ${path}`).toBe(false));
    });
  });

  it('映射层：// 与 /./ 路径不进入 coverUrl，合法 uuid 三格式保留原值并渲染 <img>', () => {
    boot(defaultRoute);
    rejectedPaths.forEach((imagePath) => {
      const mapped = domain().mapRecipe(recipeDto({ imagePath }));
      expect(mapped.coverUrl, imagePath).toBeNull();
    });
    validPaths.forEach((imagePath) => {
      const mapped = domain().mapRecipe(recipeDto({ imagePath }));
      expect(mapped.coverUrl).toBe(imagePath);
      service().recipes.data = [mapped];
      (window as any).renderRecipes();
      const cover = document.querySelector('#recipesCardGrid .h-28') as HTMLElement;
      expect(cover.querySelector('img')?.getAttribute('src')).toBe(imagePath);
    });
  });

  it('灯箱来源校验（safeImageSource 真实行为）：// 与 /./ 不打开，合法 uuid 三格式正常打开', () => {
    boot(defaultRoute);
    const lightbox = () => document.getElementById('modalImageLightbox') as HTMLElement;
    const image = () => document.getElementById('lightboxImg') as HTMLImageElement;

    rejectedPaths.forEach((src) => {
      (window as any).closeImageLightbox();
      (window as any).openImageLightbox(src);
      expect(lightbox().classList.contains('hidden'), src).toBe(true);
      expect(image().getAttribute('src'), src).not.toBe(src);
    });

    validPaths.forEach((src) => {
      (window as any).closeImageLightbox();
      (window as any).openImageLightbox(src);
      expect(lightbox().classList.contains('hidden'), src).toBe(false);
      expect(image().getAttribute('src')).toBe(src);
    });
  });
});
