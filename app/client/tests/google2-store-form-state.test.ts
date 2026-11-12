import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const productionInlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n;\n');
const bodyMarkup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

const storePriceClearSource = "q('#formStorePrice').value = '';";
const mutatedStorePriceSource = "q('#formStorePrice').value = '35';";

const legacyState = (root: Element) =>
  [...root.querySelectorAll('input, textarea, select')].map((element) => ({
    id: element.id,
    value: (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value,
    checked: element instanceof HTMLInputElement && element.type === 'checkbox' ? element.checked : undefined,
    selectedIndex: element instanceof HTMLSelectElement ? element.selectedIndex : undefined
  }));

const loadMutatedProductionScripts = () => {
  const occurrences = productionInlineScripts.split(storePriceClearSource).length - 1;
  if (occurrences !== 1) throw new Error(`expected exactly one production replacement, got ${occurrences}`);
  return productionInlineScripts.replace(storePriceClearSource, mutatedStorePriceSource);
};

const jsonOf = (data: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ success: true, data })
});

function bootRealPage(scripts = productionInlineScripts) {
  document.body.innerHTML = bodyMarkup;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonOf({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 }))
  );
  window.eval(scripts);
}

const store = (overrides: Record<string, unknown> = {}) => ({
  id: 'store-1',
  name: '真实店铺',
  category: '江南面点',
  price: 35,
  phone: '123456',
  hours: '09:00-18:00',
  address: '真实地址',
  notes: '真实备注',
  supportsDineIn: false,
  supportsTakeout: true,
  menuItems: [
    { id: 'menu-2', name: '第二道', price: null, icon: '旧图标', desc: '旧描述', isSignature: false, sortOrder: 1 },
    { id: 'menu-1', name: '第一道', price: 0, icon: null, desc: null, isSignature: true, sortOrder: 0 }
  ],
  ...overrides
});

const fields = ['Name', 'Phone', 'Hours', 'Address', 'Notes'];

describe('Google2 店铺 Modal 回填与空态', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    bootRealPage();
  });

  it('新建只作用于正式 Modal，不改重复 legacy 表单，且所有字段与菜单价为空', () => {
    const legacy = document.querySelector('#storeFormContainer') as HTMLElement;
    legacy.querySelectorAll('input, textarea, select').forEach((element) => {
      if (element instanceof HTMLInputElement) {
        element.value = 'legacy-sentinel';
        if (element.type === 'checkbox') element.checked = false;
      } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
        element.value = 'legacy-sentinel';
    });
    const legacyTitle = legacy.querySelector('#storeFormTitle') as HTMLElement;
    legacyTitle.textContent = 'legacy-sentinel';
    const beforeLegacyState = legacyState(legacy);
    (window as any).BentoModal.setupStoreForm();
    const modal = document.querySelector('#modalStoreForm') as HTMLElement;
    expect(legacyTitle.textContent).toBe('legacy-sentinel');
    expect(legacyState(legacy)).toEqual(beforeLegacyState);
    for (const field of fields) expect((modal.querySelector(`#formStore${field}`) as HTMLInputElement).value).toBe('');
    expect((modal.querySelector('#formStorePrice') as HTMLInputElement).value).toBe('');
    expect((modal.querySelector('#formStoreCategory') as HTMLSelectElement).dataset.valueState).toBe('filled');
    expect(modal.querySelectorAll('.store-dish-row')).toHaveLength(1);
    expect((modal.querySelector('.store-dish-price') as HTMLInputElement).value).toBe('');
  });

  it('编辑回填真实字段、nullable 值、顺序/布尔值和 metadata；不可表达品类不擅自默认', () => {
    (window as any).BentoService.stores.data = [store()];
    const legacy = document.querySelector('#storeFormContainer') as HTMLElement;
    (legacy.querySelector('#formStoreName') as HTMLInputElement).value = 'legacy-sentinel';
    (window as any).BentoModal.setupStoreForm('store-1');
    const modal = document.querySelector('#modalStoreForm') as HTMLElement;
    expect((modal.querySelector('#formStoreName') as HTMLInputElement).value).toBe('真实店铺');
    expect((modal.querySelector('#formStorePrice') as HTMLInputElement).value).toBe('35');
    expect((modal.querySelector('#formStoreCategory') as HTMLSelectElement).value).toBe('江南面点');
    expect((modal.querySelector('#formStoreDineIn') as HTMLInputElement).checked).toBe(false);
    expect((modal.querySelector('#formStoreTakeout') as HTMLInputElement).checked).toBe(true);
    expect((legacy.querySelector('#formStoreName') as HTMLInputElement).value).toBe('legacy-sentinel');
    expect(
      [...modal.querySelectorAll('.store-dish-row')].map(
        (row) => (row.querySelector('.store-dish-name') as HTMLInputElement).value
      )
    ).toEqual(['第二道', '第一道']);
    const rows = [...modal.querySelectorAll('.store-dish-row')] as HTMLElement[];
    expect((rows[0].querySelector('.store-dish-price') as HTMLInputElement).value).toBe('');
    expect((rows[1].querySelector('.store-dish-price') as HTMLInputElement).value).toBe('0');
    expect(rows[0].dataset.menuId).toBe('menu-2');
    expect(rows[0].dataset.menuIcon).toBe('旧图标');
    expect(rows[0].dataset.menuDesc).toBe('旧描述');
    expect((rows[0].querySelector('.store-dish-sig') as HTMLInputElement).checked).toBe(false);
    expect((rows[1].querySelector('.store-dish-sig') as HTMLInputElement).checked).toBe(true);
  });

  it('不可表达品类可变为 filled、清空回到 empty，并重置新建状态', () => {
    (window as any).BentoService.stores.data = [store({ category: '未知品类', menuItems: [] })];
    (window as any).BentoModal.setupStoreForm('store-1');
    const modal = document.querySelector('#modalStoreForm') as HTMLElement;
    const category = modal.querySelector('#formStoreCategory') as HTMLSelectElement;
    expect(category.selectedIndex).toBe(-1);
    expect(category.dataset.valueState).toBe('unrepresentable');
    category.value = '日式料理';
    category.dispatchEvent(new Event('change'));
    expect(category.dataset.valueState).toBe('filled');
    category.selectedIndex = -1;
    category.dispatchEvent(new Event('change'));
    expect(category.dataset.valueState).toBe('empty');
    (modal.querySelector('#formStoreName') as HTMLInputElement).value = '残留';
    (window as any).BentoModal.setupStoreForm();
    expect((modal.querySelector('#formStoreName') as HTMLInputElement).value).toBe('');
    expect((modal.querySelector('#formStoreCategory') as HTMLSelectElement).dataset.valueState).toBe('filled');
    expect(modal.querySelectorAll('.store-dish-row')).toHaveLength(1);
  });

  it('真实 requestDestructiveConfirm 链确认后移除菜单，且最后一行护栏不删除', async () => {
    (window as any).BentoModal.setupStoreForm();
    const modal = document.querySelector('#modalStoreForm') as HTMLElement;
    (window as any).addStoreMenuRow('新增', 1, false);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const rows = [...modal.querySelectorAll('.store-dish-row')] as HTMLElement[];
    await (window as any).removeStoreMenuRow(rows[1].querySelector('button'));
    expect(confirm).toHaveBeenCalled();
    expect(modal.querySelectorAll('.store-dish-row')).toHaveLength(1);
    await (window as any).removeStoreMenuRow(modal.querySelector('.store-dish-row button'));
    expect(modal.querySelectorAll('.store-dish-row')).toHaveLength(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it('编辑已打开后目标不存在时隐藏并阻止误创建', () => {
    const modal = document.querySelector('#modalStoreForm') as HTMLElement;
    modal.classList.remove('hidden');
    (window as any).BentoService.stores.data = [];
    (window as any).BentoModal.setupStoreForm('missing-store');
    expect(modal.classList.contains('hidden')).toBe(true);
    expect((modal.querySelector('#formStoreId') as HTMLInputElement).value).toBe('');
  });

  it('真实新建 UI 提交只保存一次，且空白菜单不伪造菜品', () => {
    const stores = (window as any).BentoService.stores;
    const save = vi.spyOn(stores, 'save');
    (window as any).BentoModal.setupStoreForm();
    const modal = document.querySelector('#modalStoreForm') as HTMLElement;
    (modal.querySelector('#formStoreName') as HTMLInputElement).value = '真实新店';
    window.eval(
      "document.getElementById('formStoreName').value = '真实新店'; BentoModal.handleStoreFormSubmit({ preventDefault() {} })"
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(stores.data[0]).toMatchObject({ name: '真实新店', price: 35 });
  });

  it('不存在 id 的表单隐藏后强制提交不产生 save/create（范围仅为真实 UI 隐藏阻止用户操作）', () => {
    const stores = (window as any).BentoService.stores;
    const save = vi.spyOn(stores, 'save');
    const modal = document.querySelector('#modalStoreForm') as HTMLElement;
    (window as any).BentoModal.setupStoreForm('missing-store');
    expect(modal.classList.contains('hidden')).toBe(true);
    const form = modal.querySelector('form') as HTMLFormElement;
    form.requestSubmit();
    expect(save).not.toHaveBeenCalled();
    expect(stores.data).toEqual([]);
  });

  it('内存加载生产脚本变异后，原新建清空断言必须在 newpriceclear 用例失败', () => {
    vi.unstubAllGlobals();
    bootRealPage(loadMutatedProductionScripts());
    const modal = document.querySelector('#modalStoreForm') as HTMLElement;
    expect(() => {
      (window as any).BentoModal.setupStoreForm();
      expect((modal.querySelector('#formStorePrice') as HTMLInputElement).value).toBe('');
    }).toThrow();
  });

  it('逐字符回填双引号与尖括号保持原值', () => {
    const value = '店"铺 <尖> [x]';
    (window as any).BentoService.stores.data = [store({ name: value, address: value, notes: value, menuItems: [] })];
    (window as any).BentoModal.setupStoreForm('store-1');
    const modal = document.querySelector('#modalStoreForm') as HTMLElement;
    expect((modal.querySelector('#formStoreName') as HTMLInputElement).value).toBe(value);
    expect((modal.querySelector('#formStoreAddress') as HTMLInputElement).value).toBe(value);
    expect((modal.querySelector('#formStoreNotes') as HTMLTextAreaElement).value).toBe(value);
    (window as any).addStoreMenuRow(value, 1, false);
    const rows = [...modal.querySelectorAll('.store-dish-row')];
    expect((rows.at(-1)?.querySelector('.store-dish-name') as HTMLInputElement).value).toBe(value);
  });
});
