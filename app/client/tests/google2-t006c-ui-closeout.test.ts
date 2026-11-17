// @vitest-environment jsdom
// T-006C 回归：顶栏/假状态栏移除、主题迁入系统设置、导航文案统一、GO 常驻与并发锁、
// cook 空态引导、首页周历 7 格、移动端删除确认框深色机制。
// 真实 index.html markup + inline 脚本 + 真实 google2-adapter.js；动态行为均通过 DOM/请求观察。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapterSource = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');
const markup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

const page = (items: unknown[] = []) => ({ items, page: 1, pageSize: 100, total: items.length, totalPages: 1 });
const jsonOk = (data: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  text: async () => JSON.stringify({ success: true, data })
});

const defaultRoute = (url: string) => {
  if (url.endsWith('/settings/pin/session')) return jsonOk({ valid: false });
  if (url.endsWith('/settings')) return jsonOk({ version: 1, pinEnabled: false });
  if (url.endsWith('/dashboard')) return jsonOk({});
  return jsonOk(page());
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

function stubCanvas() {
  const ctx = {
    clearRect: () => undefined,
    beginPath: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    rotate: () => undefined,
    fillRect: () => undefined
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
}

/** 可观测的 matchMedia：同时支持 addEventListener / addListener，并可主动模拟系统主题变化。 */
function stubMatchMedia(initialDark = false) {
  const listeners: Array<(event: { matches: boolean; media: string }) => void> = [];
  const mql = {
    matches: initialDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, callback: (event: { matches: boolean; media: string }) => void) =>
      listeners.push(callback),
    removeEventListener: () => undefined,
    addListener: (callback: (event: { matches: boolean; media: string }) => void) => listeners.push(callback),
    removeListener: () => undefined,
    dispatchEvent: () => true
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql)
  );
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn(() => mql) });
  return {
    mql,
    emitSystemTheme(nextDark: boolean) {
      mql.matches = nextDark;
      listeners.forEach((callback) => callback({ matches: nextDark, media: mql.media }));
    }
  };
}

function boot(route: (url: string, init?: RequestInit) => unknown = defaultRoute) {
  document.body.innerHTML = markup;
  document.documentElement.removeAttribute('data-theme');
  defineInnerText();
  stubCanvas();
  const fetchMock = vi.fn((url: string, init?: RequestInit) => route(String(url), init));
  vi.stubGlobal('fetch', fetchMock);
  window.eval(inline);
  window.eval(adapterSource);
  return fetchMock;
}

const settle = async () => {
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
};

const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() || '';
const toastText = () => document.getElementById('toastText')?.textContent || '';

const luminance = (value: string) => {
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!rgb && !hex) return null;
  const [r, g, b] = rgb
    ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
    : [parseInt(hex![1].slice(0, 2), 16), parseInt(hex![1].slice(2, 4), 16), parseInt(hex![1].slice(4, 6), 16)];
  const [lr, lg, lb] = [r, g, b].map((channelValue) => {
    const channel = channelValue / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};

function contrast(rgbA: string, rgbB: string) {
  const a = luminance(rgbA);
  const b = luminance(rgbB);
  if (a == null || b == null) return null;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
});

describe('T-006C 顶栏展厅条与手机假状态栏移除', () => {
  it('页面不再包含顶部控制台、双端切换、音效开关与 12:30 / 5G 假状态栏', () => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    expect(parsed.querySelector('.top-toolbar')).toBeNull();
    expect(parsed.querySelector('.mobile-notch-bar')).toBeNull();
    expect(parsed.querySelector('#btnAudioToggle')).toBeNull();
    expect(parsed.querySelector('#btnDesktopMode')).toBeNull();
    expect(parsed.querySelector('#btnMobileMode')).toBeNull();
    // 只检查真正渲染的可见文案：inline <script> 内的字符串常量不算页面文案
    parsed.querySelectorAll('script').forEach((node) => node.remove());
    const body = parsed.body.textContent || '';
    // 顶栏展厅条与手机假状态栏专属文案必须彻底消失
    for (const banned of ['全景体验展厅', '双重视角', '音效：', '5G 100%', '12:30']) {
      expect(body, banned).not.toContain(banned);
    }
    expect(parsed.querySelector('title')?.textContent?.trim()).toBe('搭饭小馆');
  });

  it('移除顶栏后 setDeviceMode / toggleAudio 等全局入口调用不抛错', () => {
    boot();
    // setDeviceMode 依赖已随顶栏删除的双端按钮，这里只要求内部判空、不因缺按钮抛错
    expect(() => (window as any).toggleAudio()).not.toThrow();
    expect(() => (window as any).setDeviceMode('mobile')).not.toThrow();
    expect(() => (window as any).setDeviceMode('desktop')).not.toThrow();
    expect(() => (window as any).applyAutoMobileMode()).not.toThrow();
  });
});

describe('T-006C 主题切换迁入系统设置并保留持久化 / 系统态响应', () => {
  it('三个主题按钮位于 #page-settings，旧「视觉风格 / 已激活」占位行已移除', () => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const settings = parsed.querySelector('#page-settings');
    expect(settings).toBeTruthy();
    for (const id of ['btnThemeLight', 'btnThemeDark', 'btnThemeSystem']) {
      expect(settings?.querySelector(`#${id}`)).toBeTruthy();
      expect(parsed.querySelectorAll(`#${id}`)).toHaveLength(1);
    }
    const settingsText = settings?.textContent || '';
    expect(settingsText).not.toContain('视觉风格');
    expect(settingsText).not.toContain('已激活');
    expect(settingsText).toContain('食用者忌口偏好');
    expect(settingsText).toContain('数据备份与导出');
  });

  it('保留 adapter 精确匹配的两个 h4 标题，忌口行不再声称「暂无可用数据」', () => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const titles = Array.from(parsed.querySelectorAll('#page-settings h4')).map((node) => node.textContent?.trim());
    expect(titles).toContain('食用者忌口偏好');
    expect(titles).toContain('数据备份与导出');
    const rowOf = (title: string) =>
      Array.from(parsed.querySelectorAll('#page-settings h4')).find((node) => node.textContent?.trim() === title)
        ?.parentElement?.parentElement;
    expect(rowOf('食用者忌口偏好')?.querySelector('button')).toBeTruthy();
    expect(rowOf('数据备份与导出')?.querySelector('button')).toBeTruthy();
    expect(parsed.querySelector('#page-settings')?.textContent || '').not.toContain('暂无可用数据');
  });

  it('三态切换实时更新 data-theme 与 localStorage，并同步按钮 active', async () => {
    stubMatchMedia(false);
    boot(defaultRoute);
    await settle();
    // jsdom 不执行 content attribute 里的 onclick（内联脚本整体在闭包内），
    // 因此与仓库既有用例一致，直接驱动内联脚本导出的真实入口，而非复制实现。
    const setAppTheme = (window as any).setAppTheme;
    expect(typeof setAppTheme).toBe('function');

    setAppTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('mochi_theme')).toBe('dark');
    expect(document.getElementById('btnThemeDark')?.classList.contains('active')).toBe(true);
    expect(document.getElementById('btnThemeLight')?.classList.contains('active')).toBe(false);

    setAppTheme('light');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem('mochi_theme')).toBe('light');
    expect(document.getElementById('btnThemeLight')?.classList.contains('active')).toBe(true);
  });

  it('刷新后按 localStorage 恢复主题；系统态跟随系统并响应变化事件', async () => {
    localStorage.setItem('mochi_theme', 'dark');
    const media = stubMatchMedia(false);
    boot(defaultRoute);
    await settle();
    // 页面加载时初始化入口按持久化值恢复
    (window as any).initAppTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.getElementById('btnThemeDark')?.classList.contains('active')).toBe(true);

    // 切到系统态：跟随系统当前值并持久化
    media.emitSystemTheme(false);
    (window as any).setAppTheme('system');
    expect(localStorage.getItem('mochi_theme')).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    media.emitSystemTheme(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    media.emitSystemTheme(false);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    // 切回显式主题后，系统变化不得再覆盖用户选择
    (window as any).setAppTheme('light');
    media.emitSystemTheme(true);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem('mochi_theme')).toBe('light');
  });
});

describe('T-006C 导航文案统一为「菜谱推荐」且 wheel 页契约不变', () => {
  it('桌面侧栏 / 移动抽屉 / 底部 Dock 的转盘入口统一为菜谱推荐，页面与 switchPage 保持 wheel', async () => {
    boot(defaultRoute);
    await settle();
    const navTexts = [
      ...Array.from(document.querySelectorAll('.desktop-sidebar-pane .sidebar-link')).map(
        (node) => node.textContent?.trim() || ''
      ),
      ...Array.from(document.querySelectorAll('#mobileDrawerRoot .drawer-item')).map(
        (node) => node.textContent?.trim() || ''
      ),
      ...Array.from(document.querySelectorAll('.mobile-floating-dock .dock-tab')).map(
        (node) => node.textContent?.trim() || ''
      )
    ];
    expect(navTexts.some((value) => value.includes('菜谱推荐'))).toBe(true);
    expect(navTexts.some((value) => value.includes('转盘'))).toBe(false);

    (window as any).switchPage('wheel');
    expect(document.getElementById('page-wheel')?.classList.contains('active')).toBe(true);
    const activeSidebar = document.querySelector('.desktop-sidebar-pane .sidebar-link.active');
    expect(activeSidebar?.textContent || '').toContain('菜谱推荐');
    const activeDock = document.querySelector('.mobile-floating-dock .dock-tab.active');
    expect(activeDock?.textContent || '').toContain('菜谱推荐');
    expect(document.getElementById('page-wheel')?.textContent || '').not.toContain('转盘');
  });
});

describe('T-006C 首页冗余解释词清理与零推荐空态引导', () => {
  const removedCopy = [
    '今日营业',
    '从本地菜谱中挑选',
    '连续记录',
    '查看这一周',
    '看看这一周',
    '纠结吃啥转一下',
    '荤素营养搭一餐',
    '消灭临期不浪费',
    '现有食材聪明配',
    '个性化定制你的搭饭小馆'
  ];

  it('首页与设置页不再渲染纯解释/口号类文案，快捷卡标题与跳转一致', () => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    // 只看渲染文案：内联脚本里的字符串常量不算页面文案
    parsed.querySelectorAll('script').forEach((node) => node.remove());
    const bodyText = parsed.body.textContent || '';
    for (const copy of removedCopy) {
      expect(bodyText, copy).not.toContain(copy);
    }
    expect(parsed.querySelectorAll('.compact-action-desc')).toHaveLength(0);
    const cards = Array.from(parsed.querySelectorAll('.compact-action-card'));
    expect(cards).toHaveLength(4);
    const titles = cards.map((card) => card.querySelector('.compact-action-title')?.textContent?.trim());
    expect(titles).toEqual(['随机决定', '我的菜谱', '库存消耗', '库存推荐']);
    // 第 2 张卡标题与 onclick 跳转的页面一致
    expect(cards[1].getAttribute('onclick') || '').toContain("switchPage('recipes')");
  });

  it('零推荐时动态显示空态引导，有推荐时隐藏', async () => {
    boot(defaultRoute);
    await settle();
    const empty = () => document.querySelector('[data-binding="recommendedRecipesEmpty"]') as HTMLElement;
    const cards = () =>
      Array.from(document.querySelectorAll('[data-binding="recommendedRecipes"] > div')) as HTMLElement[];
    expect(empty()).toBeTruthy();

    (window as any).DafanDashboardAdapter.mapDashboard({
      weeklyStats: {},
      inventory: {},
      recommendedRecipes: [],
      calendarDays: []
    });
    (window as any).syncRecommendedRecipesEmpty();
    expect(empty().classList.contains('hidden')).toBe(false);
    expect(empty().textContent || '').toContain('我的菜谱');
    expect(cards().every((card) => card.hidden)).toBe(true);

    (window as any).DafanDashboardAdapter.mapDashboard({
      weeklyStats: {},
      inventory: {},
      recommendedRecipes: [{ id: 'r1', name: '番茄炒蛋', tags: [], rating: null }],
      calendarDays: []
    });
    (window as any).syncRecommendedRecipesEmpty();
    expect(empty().classList.contains('hidden')).toBe(true);
    expect(cards().filter((card) => !card.hidden)).toHaveLength(1);
  });
});

describe('T-006C 转盘 GO 常驻、并发锁与空态引导', () => {
  const recipes = [
    { id: 'r1', name: '菜一', version: 1, ingredients: [], steps: [] },
    { id: 'r2', name: '菜二', version: 1, ingredients: [], steps: [] }
  ];

  async function bootWheel(route: (url: string, init?: RequestInit) => unknown) {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 16)
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    stubMatchMedia(false);
    const fetchMock = boot(route);
    // 等 adapter 的初始列表加载完成，再把真实菜谱注入缓存，避免被晚到响应清空
    await settle();
    (window as any).BentoService.recipes.data = recipes.map((recipe) =>
      (window as any).DafanDomainAdapter.mapRecipe(recipe)
    );
    (window as any).setWheelCandidateMode('cook');
    // 真实用户从导航进入转盘页；adapter 的晚到响应判定依赖 page-wheel 处于 active
    (window as any).switchPage('wheel');
    return fetchMock;
  }

  const recommendationCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes('/recommendations/random') && init?.method === 'POST'
    ).length;

  it('静止态 GO 无感叹号，未旋转切页不会把底部按钮改成「再转一次决定」', async () => {
    await bootWheel(defaultRoute);
    await settle();
    expect(text('#wheelGoBtn')).toBe('GO');
    expect(text('#btnSpinBottom')).not.toBe('再转一次决定');
    (window as any).switchPage('recipes');
    expect(text('#wheelGoBtn')).toBe('GO');
    expect(text('#btnSpinBottom')).not.toBe('再转一次决定');
    (window as any).switchPage('wheel');
    expect(text('#btnSpinBottom')).not.toBe('再转一次决定');
  });

  it('等待推荐期间锁定按钮（disabled + aria-busy）且重复点击只发一次请求，文字恒为 GO', async () => {
    let release: ((value: unknown) => void) | null = null;
    const fetchMock = await bootWheel((url, init) => {
      if (String(url).includes('/recommendations/random') && init?.method === 'POST')
        return new Promise((resolvePromise) => {
          release = (data: unknown) => resolvePromise(jsonOk(data));
        });
      return defaultRoute(String(url), init);
    });
    await settle();
    const spin = (window as any).triggerSpin();
    await settle();

    const goBtn = document.getElementById('wheelGoBtn') as HTMLButtonElement;
    expect(text('#wheelGoBtn')).toBe('GO');
    expect(goBtn.disabled).toBe(true);
    expect(goBtn.getAttribute('aria-busy')).toBe('true');
    expect(recommendationCalls(fetchMock)).toBe(1);

    void (window as any).triggerSpin();
    await settle();
    expect(recommendationCalls(fetchMock)).toBe(1);

    release?.({ results: [{ resultType: 'RECIPE', resultId: 'r1', title: '菜一' }] });
    await spin;
    await vi.advanceTimersByTimeAsync(0);

    expect(text('#wheelGoBtn')).toBe('GO');
    expect(goBtn.disabled).toBe(true);
    expect(goBtn.getAttribute('aria-busy')).toBe('true');
    expect(recommendationCalls(fetchMock)).toBe(1);

    const rotor = document.getElementById('wheelRotor') as HTMLElement;
    const event = new Event('transitionend', { bubbles: true });
    Object.defineProperty(event, 'propertyName', { value: 'transform' });
    rotor.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(0);

    expect(text('#wheelGoBtn')).toBe('GO');
    expect(goBtn.disabled).toBe(false);
    expect(goBtn.getAttribute('aria-busy')).toBeNull();
  });

  it('旋转中切页会释放锁并保持 GO，再次起转可重新请求', async () => {
    let first = true;
    const fetchMock = await bootWheel((url, init) => {
      if (String(url).includes('/recommendations/random') && init?.method === 'POST') {
        const payload = first
          ? { results: [{ resultType: 'RECIPE', resultId: 'r1', title: '菜一' }] }
          : { results: [{ resultType: 'RECIPE', resultId: 'r2', title: '菜二' }] };
        first = false;
        return jsonOk(payload);
      }
      return defaultRoute(String(url), init);
    });
    await settle();
    await (window as any).triggerSpin();
    await vi.advanceTimersByTimeAsync(0);
    expect(text('#wheelGoBtn')).toBe('GO');
    expect(recommendationCalls(fetchMock)).toBe(1);
    expect((document.getElementById('wheelGoBtn') as HTMLButtonElement).disabled).toBe(true);

    (window as any).switchPage('home');
    const goBtn = document.getElementById('wheelGoBtn') as HTMLButtonElement;
    expect(text('#wheelGoBtn')).toBe('GO');
    expect(goBtn.disabled).toBe(false);
    expect(goBtn.getAttribute('aria-busy')).toBeNull();
    expect(text('#btnSpinBottom')).not.toBe('再转一次决定');

    (window as any).switchPage('wheel');
    await (window as any).triggerSpin();
    await vi.advanceTimersByTimeAsync(0);
    expect(recommendationCalls(fetchMock)).toBe(2);
    expect(text('#wheelGoBtn')).toBe('GO');
  });

  it('推荐等待中离开转盘再返回，旧响应释放后不转动、不弹中奖框且按钮恢复可用', async () => {
    let release: ((value: unknown) => void) | null = null;
    const fetchMock = await bootWheel((url, init) => {
      if (String(url).includes('/recommendations/random') && init?.method === 'POST')
        return new Promise((resolvePromise) => {
          release = (data: unknown) => resolvePromise(jsonOk(data));
        });
      return defaultRoute(String(url), init);
    });
    await settle();
    const spin = (window as any).triggerSpin();
    await settle();
    expect(recommendationCalls(fetchMock)).toBe(1);
    const goBtn = document.getElementById('wheelGoBtn') as HTMLButtonElement;
    const pendingBottomBtn = document.getElementById('btnSpinBottom') as HTMLButtonElement;
    // 先坐实等待期确实上锁，后续「不再为 true」才有意义（非空断言）
    expect(goBtn.disabled).toBe(true);
    expect(goBtn.getAttribute('aria-busy')).toBe('true');
    expect(pendingBottomBtn.disabled).toBe(true);
    expect(pendingBottomBtn.getAttribute('aria-busy')).toBe('true');

    // 请求仍在途时离开转盘再返回：切页只负责释放锁，不得让晚到响应对旧页面起转
    (window as any).switchPage('home');
    (window as any).switchPage('wheel');
    await settle();
    // 切页已释放忙态；随后的晚到响应不得把它写回 true
    expect(goBtn.disabled).toBe(false);
    expect(goBtn.getAttribute('aria-busy')).not.toBe('true');

    release?.({ results: [{ resultType: 'RECIPE', resultId: 'r1', title: '菜一' }] });
    await spin;
    await vi.advanceTimersByTimeAsync(0);

    const rotor = document.getElementById('wheelRotor') as HTMLElement;
    const bottomBtn = document.getElementById('btnSpinBottom') as HTMLButtonElement;
    expect(rotor.style.transform).toBe('');
    expect(document.getElementById('wheelPin')?.classList.contains('pin-shake')).toBe(false);
    // 若晚到响应错误地起了转，补发 transitionend 后中奖框就会弹出：这里必须仍然隐藏
    const settleEvent = new Event('transitionend', { bubbles: true });
    Object.defineProperty(settleEvent, 'propertyName', { value: 'transform' });
    rotor.dispatchEvent(settleEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById('modalWheelWinner')?.classList.contains('hidden')).toBe(true);
    expect(text('#winnerModalTitle')).not.toBe('菜一');
    expect(text('#btnSpinBottom')).not.toBe('再转一次决定');
    expect(text('#wheelGoBtn')).toBe('GO');
    expect(goBtn.disabled).toBe(false);
    expect(goBtn.getAttribute('aria-busy')).not.toBe('true');
    expect(bottomBtn.disabled).toBe(false);
    expect(bottomBtn.getAttribute('aria-busy')).not.toBe('true');
    expect(text('#btnSpinBottom')).not.toContain('推荐中');
    expect(recommendationCalls(fetchMock)).toBe(1);
  });

  it('推荐等待中切换分类，晚到旧响应不复活忙态、不起转也不沿用旧结果', async () => {
    let release: ((value: unknown) => void) | null = null;
    const fetchMock = await bootWheel((url, init) => {
      if (String(url).includes('/recommendations/random') && init?.method === 'POST')
        return new Promise((resolvePromise) => {
          release = (data: unknown) => resolvePromise(jsonOk(data));
        });
      return defaultRoute(String(url), init);
    });
    await settle();
    const spin = (window as any).triggerSpin();
    await settle();
    expect(recommendationCalls(fetchMock)).toBe(1);
    const goBtn = document.getElementById('wheelGoBtn') as HTMLButtonElement;
    const pendingBottomBtn = document.getElementById('btnSpinBottom') as HTMLButtonElement;
    expect(goBtn.disabled).toBe(true);
    expect(goBtn.getAttribute('aria-busy')).toBe('true');
    expect(pendingBottomBtn.disabled).toBe(true);
    expect(pendingBottomBtn.getAttribute('aria-busy')).toBe('true');

    // 等待期切分类：旧代次作废，忙态立即释放（两处按钮都不得残留忙态）
    (window as any).setWheelCandidateMode('dinein');
    await settle();
    expect(goBtn.disabled).toBe(false);
    expect(goBtn.getAttribute('aria-busy')).not.toBe('true');
    expect(pendingBottomBtn.disabled).toBe(false);
    expect(pendingBottomBtn.getAttribute('aria-busy')).not.toBe('true');

    release?.({ results: [{ resultType: 'RECIPE', resultId: 'r1', title: '菜一' }] });
    await spin;
    await vi.advanceTimersByTimeAsync(0);

    const rotor = document.getElementById('wheelRotor') as HTMLElement;
    const bottomBtn = document.getElementById('btnSpinBottom') as HTMLButtonElement;
    expect(rotor.style.transform).toBe('');
    expect(document.getElementById('wheelPin')?.classList.contains('pin-shake')).toBe(false);
    expect(document.getElementById('modalWheelWinner')?.classList.contains('hidden')).toBe(true);
    expect(text('#winnerModalTitle')).not.toBe('菜一');
    // 同样补发结束事件：旧响应若错误起转，这里就会落到旧结果
    const settleEvent = new Event('transitionend', { bubbles: true });
    Object.defineProperty(settleEvent, 'propertyName', { value: 'transform' });
    rotor.dispatchEvent(settleEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById('modalWheelWinner')?.classList.contains('hidden')).toBe(true);
    expect(text('#winnerModalTitle')).not.toBe('菜一');
    expect(text('#btnSpinBottom')).not.toBe('再转一次决定');
    expect(text('#wheelGoBtn')).toBe('GO');
    expect(goBtn.disabled).toBe(false);
    expect(goBtn.getAttribute('aria-busy')).not.toBe('true');
    expect(bottomBtn.disabled).toBe(false);
    expect(bottomBtn.getAttribute('aria-busy')).not.toBe('true');
    expect(text('#btnSpinBottom')).not.toContain('推荐中');
    expect(recommendationCalls(fetchMock)).toBe(1);
  });

  it('等待中离开转盘再返回，首次 GO 立即发起新请求；旧响应晚到不写状态也不释放新锁', async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const fetchMock = await bootWheel((url, init) => {
      if (String(url).includes('/recommendations/random') && init?.method === 'POST')
        return new Promise((resolvePromise) => {
          resolvers.push((data: unknown) => resolvePromise(jsonOk(data)));
        });
      return defaultRoute(String(url), init);
    });
    await settle();
    const goBtn = document.getElementById('wheelGoBtn') as HTMLButtonElement;
    const rotor = document.getElementById('wheelRotor') as HTMLElement;

    const firstSpin = (window as any).triggerSpin();
    await settle();
    expect(recommendationCalls(fetchMock)).toBe(1);
    expect(goBtn.disabled).toBe(true);

    // 请求仍在途时离开转盘再返回：adapter 侧等待锁必须随作用域失效一并释放
    (window as any).switchPage('home');
    (window as any).switchPage('wheel');
    await settle();
    expect(goBtn.disabled).toBe(false);
    expect(goBtn.getAttribute('aria-busy')).not.toBe('true');
    expect(goBtn.dataset.wheelWaiting).toBeUndefined();

    // 关键回归：返回后的第一次点击必须立刻发出第二个请求（旧 promise 仍未落定）
    const secondSpin = (window as any).triggerSpin();
    await settle();
    expect(recommendationCalls(fetchMock)).toBe(2);
    expect(goBtn.disabled).toBe(true);
    expect(goBtn.getAttribute('aria-busy')).toBe('true');

    // 旧响应先落定：不得起转、不得写忙态、不得抢走新请求的锁
    resolvers[0]({ results: [{ resultType: 'RECIPE', resultId: 'r1', title: '菜一' }] });
    await firstSpin;
    await vi.advanceTimersByTimeAsync(0);
    expect(rotor.style.transform).toBe('');
    expect(document.getElementById('wheelPin')?.classList.contains('pin-shake')).toBe(false);
    expect(goBtn.disabled).toBe(true);
    expect(goBtn.getAttribute('aria-busy')).toBe('true');

    // 新请求仍是唯一当前请求：重复点击不得再发
    void (window as any).triggerSpin();
    await settle();
    expect(recommendationCalls(fetchMock)).toBe(2);

    // 新响应落定后按正常路径起转
    resolvers[1]({ results: [{ resultType: 'RECIPE', resultId: 'r2', title: '菜二' }] });
    await secondSpin;
    await vi.advanceTimersByTimeAsync(0);
    expect(rotor.style.transform).not.toBe('');
    expect(document.getElementById('wheelPin')?.classList.contains('pin-shake')).toBe(true);
    expect(document.getElementById('modalWheelWinner')?.classList.contains('hidden')).toBe(true);
  });

  it('等待中切分类后首次 GO 立即发起新请求；旧响应乱序晚到不覆盖新状态与锁', async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const fetchMock = await bootWheel((url, init) => {
      if (String(url).includes('/recommendations/random') && init?.method === 'POST')
        return new Promise((resolvePromise) => {
          resolvers.push((data: unknown) => resolvePromise(jsonOk(data)));
        });
      return defaultRoute(String(url), init);
    });
    await settle();
    const goBtn = document.getElementById('wheelGoBtn') as HTMLButtonElement;
    const rotor = document.getElementById('wheelRotor') as HTMLElement;

    const oldSpin = (window as any).triggerSpin();
    await settle();
    expect(recommendationCalls(fetchMock)).toBe(1);

    (window as any).setWheelCandidateMode('all');
    await settle();
    expect(goBtn.disabled).toBe(false);
    expect(goBtn.getAttribute('aria-busy')).not.toBe('true');

    const newSpin = (window as any).triggerSpin();
    await settle();
    expect(recommendationCalls(fetchMock)).toBe(2);

    // 新响应先到：正常起转
    resolvers[1]({ results: [{ resultType: 'RECIPE', resultId: 'r2', title: '菜二' }] });
    await newSpin;
    await vi.advanceTimersByTimeAsync(0);
    expect(rotor.style.transform).not.toBe('');
    const spinningTransform = rotor.style.transform;

    // 旧响应后到：不得重写扇区、不得清掉旋转期忙态、不得起第二段转
    resolvers[0]({ results: [{ resultType: 'RECIPE', resultId: 'r1', title: '菜一' }] });
    await oldSpin;
    await vi.advanceTimersByTimeAsync(0);
    expect(recommendationCalls(fetchMock)).toBe(2);
    expect(rotor.style.transform).toBe(spinningTransform);
    expect(goBtn.disabled).toBe(true);
    expect(goBtn.getAttribute('aria-busy')).toBe('true');
    expect(text('#wheelGoBtn')).toBe('GO');
    expect(document.getElementById('modalWheelWinner')?.classList.contains('hidden')).toBe(true);
    expect(text('#winnerModalTitle')).not.toBe('菜一');
  });

  it('cook 模式候选为空时引导去【我的菜谱】而不是【觅食小馆】，且不发推荐请求', async () => {
    const fetchMock = await bootWheel(defaultRoute);
    await settle();
    (window as any).BentoService.recipes.data = [];
    (window as any).setWheelCandidateMode('cook');
    await (window as any).triggerSpin();
    await vi.advanceTimersByTimeAsync(0);

    expect(toastText()).toContain('我的菜谱');
    expect(toastText()).not.toContain('觅食小馆');
    expect(recommendationCalls(fetchMock)).toBe(0);
  });
});

describe('T-006C 首页周历 7 格样式收口（桌面 + 移动）', () => {
  const week = [
    { date: '2026-11-16', weekday: '一', dayOfMonth: 16, isToday: false, status: 'recorded' },
    { date: '2026-11-17', weekday: '二', dayOfMonth: 17, isToday: false, status: 'planned' },
    { date: '2026-11-18', weekday: '三', dayOfMonth: 18, isToday: false, status: 'empty' },
    { date: '2026-11-19', weekday: '四', dayOfMonth: 19, isToday: true, status: 'recorded' },
    { date: '2026-11-20', weekday: '五', dayOfMonth: 20, isToday: false, status: 'empty' },
    { date: '2026-11-21', weekday: '六', dayOfMonth: 21, isToday: false, status: 'planned' },
    { date: '2026-11-22', weekday: '日', dayOfMonth: 22, isToday: false, status: 'empty' }
  ];
  const todayClasses = ['border-2', 'border-[#FF6B57]', 'bg-[#FFF8F5]', 'scale-105', 'hover:scale-110'];
  const staticLeftovers = [
    'border-2',
    'border-[#FF6B57]',
    'bg-[#FFF8F5]',
    'border-[#FEE8B8]',
    'border-b-[#D97706]',
    'text-[#D97706]',
    'text-[#FF6B57]'
  ];
  const rowsOf = (selector: string) => Array.from(document.querySelectorAll(selector)) as HTMLElement[];

  it('静态模板第 6/7 格不再写死今日态或固定黄边', () => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const desktop = Array.from(parsed.querySelectorAll('[data-binding="calendarDays"] > div'));
    expect(desktop).toHaveLength(7);
    for (const cell of desktop) {
      for (const leftover of staticLeftovers) {
        expect(cell.classList.contains(leftover)).toBe(false);
      }
    }
  });

  it('真实 adapter 渲染后桌面与移动各 7 天：唯一今日格、非今日格无今日残留、每格都有底色与边框', async () => {
    boot(defaultRoute);
    await settle();
    (window as any).DafanDashboardAdapter.mapDashboard({
      weeklyStats: {},
      inventory: {},
      calendarDays: week
    });

    const views: Array<{ name: string; selector: string }> = [
      { name: 'desktop', selector: '[data-binding="calendarDays"] > div' },
      { name: 'mobile', selector: '.mobile-week-calendar-list [data-binding^="mobileCalendarDay-"]' }
    ];

    for (const view of views) {
      const rows = rowsOf(view.selector);
      expect(rows, view.name).toHaveLength(7);
      expect(
        rows.map((row) => row.dataset.date),
        view.name
      ).toEqual(week.map((day) => day.date));
      expect(
        rows.filter((row) => row.classList.contains('is-today-week-cell')),
        view.name
      ).toHaveLength(1);
      expect(rows[3].classList.contains('is-today-week-cell'), view.name).toBe(true);

      rows.forEach((row, index) => {
        const classes = Array.from(row.classList);
        // 底色/边框可来自工具类，也可来自页面 .week-cell 规则；两者都不允许缺失
        const styled = row.classList.contains('week-cell');
        expect(styled || classes.some((name) => name.startsWith('bg-')), `${view.name} ${index} 缺底色`).toBe(true);
        expect(styled || classes.some((name) => name.startsWith('border')), `${view.name} ${index} 缺边框`).toBe(true);
        if (index !== 3) {
          for (const leftover of todayClasses) {
            expect(row.classList.contains(leftover), `${view.name} ${index} 残留 ${leftover}`).toBe(false);
          }
          // 桌面格有 weekday 叶子、移动列表有 dateBadge 徽标：两者都不得残留今日配色
          for (const slot of ['weekday', 'dayOfMonth', 'dateBadge', 'statusText']) {
            const node = row.querySelector(`[data-business-value="${slot}"]`);
            if (!node) continue;
            expect(node.classList.contains('text-[#FF6B57]'), `${view.name} ${index} ${slot} 残留今日色`).toBe(false);
            expect(node.classList.contains('bg-[#FF6B57]'), `${view.name} ${index} ${slot} 残留今日底色`).toBe(false);
          }
        }
      });
      // 第 6 / 7 格有真实状态文案而不是空白残留
      expect(rows[5].dataset.status).toBe('planned');
      expect(rows[5].textContent || '').not.toBe('');
      expect(rows[6].dataset.status).toBe('empty');
    }
  });

  it('渲染后各 slot 不残留旧工具色，且四态语义类按状态正确挂载（dafan-week-* 单一来源）', async () => {
    boot(defaultRoute);
    await settle();
    (window as any).DafanDashboardAdapter.mapDashboard({
      weeklyStats: {},
      inventory: {},
      calendarDays: week
    });

    // 旧工具色会被 index 带 !important 的全局规则压平四态，必须在周历 slot 上彻底消失
    const legacy = [
      'text-[#2E7D32]',
      'bg-[#EDF7EE]',
      'bg-stone-100',
      'text-stone-600',
      'text-stone-700',
      'text-stone-500',
      'text-[#D97706]',
      'bg-[#FFF8E6]',
      'bg-[#FFFDF0]'
    ];
    const slotClass = (row: HTMLElement, slot: string) =>
      Array.from(row.querySelector(`[data-business-value="${slot}"]`)?.classList ?? []).filter((name) =>
        name.startsWith('dafan-week-')
      );
    const expected = {
      today: {
        text: 'dafan-week-today-text',
        badge: 'dafan-week-today-badge',
        pill: 'dafan-week-today-pill'
      },
      recorded: {
        text: 'dafan-week-recorded-text',
        badge: 'dafan-week-recorded-badge',
        pill: 'dafan-week-recorded-pill'
      },
      planned: {
        text: 'dafan-week-planned-text',
        badge: 'dafan-week-planned-badge',
        pill: 'dafan-week-planned-pill'
      },
      normal: {
        text: 'dafan-week-normal-text',
        badge: 'dafan-week-normal-badge',
        pill: 'dafan-week-normal-pill'
      }
    } as const;
    const stateOf = (day: (typeof week)[number]) =>
      day.isToday ? 'today' : day.status === 'recorded' ? 'recorded' : day.status === 'planned' ? 'planned' : 'normal';

    const views: Array<{ name: 'desktop' | 'mobile'; selector: string }> = [
      { name: 'desktop', selector: '[data-binding="calendarDays"] > div' },
      { name: 'mobile', selector: '.mobile-week-calendar-list [data-binding^="mobileCalendarDay-"]' }
    ];
    for (const view of views) {
      const rows = rowsOf(view.selector);
      expect(rows, view.name).toHaveLength(7);
      rows.forEach((row, index) => {
        const state = stateOf(week[index]);
        expect(row.dataset.weekState, `${view.name} ${index} state`).toBe(state);
        // 行与所有 slot 都不得残留旧工具色
        for (const node of [row, ...Array.from(row.querySelectorAll('[data-business-value]'))]) {
          for (const name of legacy) {
            expect(node.classList.contains(name), `${view.name} ${index} 残留 ${name}`).toBe(false);
          }
        }
        const textSlots = view.name === 'desktop' ? ['weekday', 'dayOfMonth', 'label'] : ['statusText'];
        for (const slot of textSlots) {
          const headingClass = state === 'today' ? 'dafan-week-today-text' : 'dafan-week-muted';
          const wanted = slot === 'weekday' || slot === 'dayOfMonth' ? headingClass : expected[state].text;
          expect(slotClass(row, slot), `${view.name} ${index} ${slot}`).toContain(wanted);
        }
        if (view.name === 'mobile') {
          expect(slotClass(row, 'dateBadge'), `mobile ${index} dateBadge`).toContain(expected[state].badge);
          expect(slotClass(row, 'statusPill'), `mobile ${index} statusPill`).toContain(expected[state].pill);
        }
      });
    }
  });
});

describe('T-006C 移动端破坏性确认框深色机制', () => {
  /**
   * 确定性层叠求解（与 google2-hidden-layout.test.ts 同一思路）：
   * 页面自带 <style> + 模拟 Tailwind CDN 注入的普通工具类 —— 只注入确认框子树真实出现的类。
   * 用 jsdom getComputedStyle 无法正确判断（它不做 !important 层叠），因此这里自行求解。
   */
  type Priority = { important: boolean; specificity: number[]; order: number };
  const specificity = (selector: string) => {
    const withoutPseudoElements = selector.replace(/::[a-z-]+(\([^)]*\))?/g, '');
    const ids = (withoutPseudoElements.match(/#[\w-]+/g) ?? []).length;
    const classes =
      (withoutPseudoElements.match(/\.[\w-]+/g) ?? []).length +
      (withoutPseudoElements.match(/\[[^\]]+\]/g) ?? []).length +
      (withoutPseudoElements.match(/:(?!:)[a-z-]+(\([^)]*\))?/g) ?? []).length;
    const types = (withoutPseudoElements.match(/(^|[\s>+~])([a-z][\w-]*)/gi) ?? []).length;
    return [ids, classes, types];
  };
  const compare = (left: Priority, right: Priority) => {
    if (left.important !== right.important) return left.important ? 1 : -1;
    for (let index = 0; index < 3; index += 1) {
      if (left.specificity[index] !== right.specificity[index])
        return left.specificity[index] - right.specificity[index];
    }
    return left.order - right.order;
  };
  const bareHtml = () => html.replace(/<script[\s\S]*?<\/script>/g, '');

  function buildBoxDom(theme: 'light' | 'dark') {
    const dom = new JSDOM(bareHtml(), { pretendToBeVisual: true });
    const { window: sandbox } = dom;
    if (theme === 'dark') sandbox.document.documentElement.setAttribute('data-theme', 'dark');
    const box = sandbox.document.getElementById('mobileConfirmModalBox') as HTMLElement;
    // Tailwind CDN 会在页面自带 <style> 之后注入工具类。
    const classNames = new Set<string>();
    box.querySelectorAll('*').forEach((node) => node.classList.forEach((name) => classNames.add(name)));
    box.classList.forEach((name) => classNames.add(name));
    const utilities = new Map<string, string>([
      ['bg-white', 'background-color: #FFFFFF'],
      ['text-stone-900', 'color: #1C1917'],
      ['text-stone-500', 'color: #78716C']
    ]);
    const style = sandbox.document.createElement('style');
    style.textContent = Array.from(classNames)
      .filter((name) => utilities.has(name))
      .map((name) => `.${name} { ${utilities.get(name)}; }`)
      .join('\n');
    sandbox.document.head.appendChild(style);
    return { sandbox, box };
  }

  function cascade(dom: ReturnType<typeof buildBoxDom>, property: 'background-color' | 'color', element: Element) {
    const { sandbox } = dom;
    let winner: { value: string; priority: Priority } | null = null;
    let order = 0;
    for (const sheet of Array.from(sandbox.document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        rules = null;
      }
      for (const rule of Array.from(rules ?? [])) {
        if (rule.type !== 1) continue;
        const styleRule = rule as CSSStyleRule;
        const matched = styleRule.selectorText
          .split(',')
          .map((selector) => selector.trim())
          .filter(Boolean)
          .some((selector) => {
            try {
              return element.matches(selector);
            } catch {
              return false;
            }
          });
        if (!matched) continue;
        const value = styleRule.style.getPropertyValue(property).trim();
        if (!value) continue;
        order += 1;
        const candidate = {
          value,
          priority: {
            important: styleRule.style.getPropertyPriority(property) === 'important',
            specificity: specificity(styleRule.selectorText),
            order
          }
        };
        if (!winner || compare(candidate.priority, winner.priority) > 0) winner = candidate;
      }
    }
    if (!winner) return null;
    const resolved = winner.value;
    const variable = /var\((--[\w-]+)/.exec(resolved);
    if (!variable) return resolved;
    return customProperty(dom, variable[1]);
  }

  function customProperty(dom: ReturnType<typeof buildBoxDom>, name: string) {
    const { sandbox } = dom;
    let winner: { value: string; priority: Priority } | null = null;
    let order = 0;
    for (const sheet of Array.from(sandbox.document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        rules = null;
      }
      for (const rule of Array.from(rules ?? [])) {
        if (rule.type !== 1) continue;
        const styleRule = rule as CSSStyleRule;
        const matched = styleRule.selectorText
          .split(',')
          .map((selector) => selector.trim())
          .filter(Boolean)
          .some((selector) => {
            try {
              return sandbox.document.documentElement.matches(selector);
            } catch {
              return false;
            }
          });
        if (!matched) continue;
        const value = styleRule.style.getPropertyValue(name).trim();
        if (!value) continue;
        order += 1;
        const candidate = {
          value,
          priority: {
            important: styleRule.style.getPropertyPriority(name) === 'important',
            specificity: specificity(styleRule.selectorText),
            order
          }
        };
        if (!winner || compare(candidate.priority, winner.priority) > 0) winner = candidate;
      }
    }
    return winner?.value ?? '';
  }

  const measured = (theme: 'light' | 'dark') => {
    const dom = buildBoxDom(theme);
    const title = dom.box.querySelector('#mobileConfirmTitle') as Element;
    const message = dom.box.querySelector('#mobileConfirmMessage') as Element;
    return {
      box: dom.box,
      background: cascade(dom, 'background-color', dom.box),
      titleColor: cascade(dom, 'color', title),
      messageColor: cascade(dom, 'color', message),
      classes: [
        ...Array.from(dom.box.classList),
        ...Array.from(dom.box.querySelectorAll('*')).flatMap((node) => Array.from(node.classList))
      ]
    };
  };

  it('确认框不使用 Tailwind dark: 变体（页面主题走 html[data-theme="dark"]）', () => {
    const { classes } = measured('dark');
    expect(classes.filter((name) => name.startsWith('dark:'))).toEqual([]);
    expect(html).toMatch(/html\[data-theme="dark"\]\s+#mobileConfirmModalBox/);
  });

  it('data-theme=dark 下确认框为深底浅字，标题/正文对比度 ≥ 4.5', () => {
    const dark = measured('dark');
    expect(dark.background).toBeTruthy();
    expect(dark.titleColor).toBeTruthy();
    expect(dark.messageColor).toBeTruthy();
    expect(luminance(dark.background as string) as number).toBeLessThan(0.25);
    expect(contrast(dark.background as string, dark.titleColor as string) as number).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark.background as string, dark.messageColor as string) as number).toBeGreaterThanOrEqual(4.5);
  });

  it('浅色模式不被深色规则污染（规则受 data-theme 作用域约束）', () => {
    const light = measured('light');
    const dark = measured('dark');
    expect(light.background).toBeTruthy();
    expect(luminance(light.background as string) as number).toBeGreaterThan(0.5);
    expect(light.background).not.toBe(dark.background);
    expect(light.titleColor).not.toBe(dark.titleColor);
  });
});
