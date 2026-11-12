import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapter = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n;\n');
const bodyMarkup = new DOMParser()
  .parseFromString(html, 'text/html')
  .body.innerHTML.replace('onsubmit="window.BentoModal.handleStoreFormSubmit(event)"', '');

const response = (data: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ success: true, data })
});
const mutation = () =>
  (fetch as any).mock.calls.filter((call: any[]) => /\/stores(?:\/|$)/.test(String(call[0])) && call[1]?.method).at(-1);

function boot() {
  document.body.innerHTML = bodyMarkup;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) =>
      response({
        id: 's-new',
        name: '新店',
        version: 1,
        menuItems: [],
        ...(options?.method === 'PUT' ? { id: 's1', version: 4 } : {})
      })
    )
  );
  window.eval(inline);
  window.eval(adapter);
  (window as any).DafanDomainAdapter.wireLegacyEntryPoints();
  return (window as any).BentoService.stores;
}

function fillStore(name = '真实新店') {
  const modal = document.querySelector('#modalStoreForm') as HTMLElement;
  (window as any).BentoModal.setupStoreForm();
  (modal.querySelector('#formStoreName') as HTMLInputElement).value = name;
  return modal;
}

function latestStoreMutation() {
  return (fetch as any).mock.calls
    .filter((call: any[]) => /\/stores(?:\/|$)/.test(String(call[0])) && call[1]?.method)
    .at(-1);
}

async function submit(modal: HTMLElement) {
  const form = modal.querySelector('form') as HTMLFormElement;
  form.removeAttribute('onsubmit');
  (window as any).BentoModal.handleStoreFormSubmit({ preventDefault() {}, currentTarget: form });
  await new Promise((resolve) => setTimeout(resolve, 25));
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('Google2 店铺真实 markup + inline + adapter 保存边界', () => {
  it('真实 setup/add-row/submit 收集 name price signature metadata，空白行跳过且空菜单可清空', async () => {
    const stores = boot();
    const modal = fillStore();
    const first = modal.querySelector('.store-dish-row') as HTMLElement;
    (first.querySelector('.store-dish-name') as HTMLInputElement).value = '面';
    (first.querySelector('.store-dish-price') as HTMLInputElement).value = '18';
    (first.querySelector('.store-dish-sig') as HTMLInputElement).checked = true;
    first.dataset.menuIcon = '🍜';
    first.dataset.menuDesc = '招牌';
    (window as any).addStoreMenuRow('', 0, false);
    await expect(
      stores.save({
        name: '真实新店',
        menuItems: [
          { name: '面', price: 18 },
          { name: '', price: 0 }
        ]
      })
    ).rejects.toMatchObject({ code: 'STORE_MENU_INVALID' });
    (modal.querySelectorAll('.store-dish-row')[1] as HTMLElement).remove();
    await submit(modal);
    let body = JSON.parse(latestStoreMutation()[1].body);
    expect(body.menuItems).toEqual([
      { name: '面', price: 18, icon: '🍜', desc: '招牌', isSignature: true, sortOrder: 0 }
    ]);

    stores.data = [{ id: 's1', name: '旧店', version: 3 }];
    await stores.save({ id: 's1', version: 3, name: '旧店', menuItems: [] });
    body = JSON.parse(mutation()[1].body);
    expect(body.menuItems).toEqual([]);
    expect(body.menuItems).not.toContainEqual(expect.objectContaining({ id: expect.anything() }));
  });

  it('canonical null 优先 alias，显式 0 保留，未知 category 清空或选值且不自动写 cuisine', async () => {
    const stores = boot();
    await stores.save({
      name: '新店',
      cuisine: null,
      category: '不应使用',
      averageCost: 0,
      price: 99,
      imagePath: null
    });
    let body = JSON.parse(latestStoreMutation()[1].body);
    expect(body).toMatchObject({ cuisine: null, averageCost: 0, imagePath: null });
    expect(body).not.toHaveProperty('contact');

    stores.data = [{ id: 's1', name: '旧店', version: 2, category: '未知品类' }];
    const modal = document.querySelector('#modalStoreForm') as HTMLElement;
    (window as any).BentoModal.setupStoreForm('s1');
    const category = modal.querySelector('#formStoreCategory') as HTMLSelectElement;
    expect(category.selectedIndex).toBe(-1);
    category.value = '日式料理';
    category.dispatchEvent(new Event('change'));
    (modal.querySelector('#formStoreName') as HTMLInputElement).value = '改名店';
    await submit(modal);
    body = JSON.parse(mutation()[1].body);
    expect(body).not.toHaveProperty('storeType');
    expect(body.cuisine).toBe('日式料理');
  });

  it('原 rating/storeType/recommendation/image/tags 无 editor fields 时不被清空，菜单非法和 name 缺失在 fetch 前拒绝', async () => {
    const stores = boot();
    stores.data = [
      {
        id: 's1',
        name: '旧店',
        version: 3,
        rating: 4.8,
        storeType: '正餐',
        recommendation: '推荐',
        image: '旧图',
        tags: ['旧标签']
      }
    ];
    const modal = fillStore('改名店');
    (modal.querySelector('#formStoreId') as HTMLInputElement).value = 's1';
    await expect(stores.save({ id: 's1', version: 3, name: '改名店' })).resolves.toBeDefined();
    const body = JSON.parse(mutation()[1].body);
    expect(body).not.toHaveProperty('rating');
    expect(body).not.toHaveProperty('storeType');
    expect(body).not.toHaveProperty('recommendedDishes');
    expect(body).not.toHaveProperty('imagePath');
    expect(body).not.toHaveProperty('tagsText');
    const count = (fetch as any).mock.calls.length;
    await expect(stores.save({ name: 'x', menuItems: [{ name: '菜', price: 1000 }] })).rejects.toMatchObject({
      code: 'STORE_MENU_INVALID'
    });
    await expect(stores.save({ name: '', menuItems: [{ name: '菜', price: 1 }] })).rejects.toMatchObject({
      code: 'STORE_NAME_REQUIRED'
    });
    expect((fetch as any).mock.calls.length).toBe(count);
  });

  it('失败不关闭、成功关闭，pending 双提交只写一次；空/负/小数/1000 人均价格拒绝', async () => {
    const stores = boot();
    const modal = fillStore();
    const close = vi.spyOn((window as any).BentoModal, 'close');
    const originalSave = stores.save;
    stores.save = vi.fn(async () => {
      throw new Error('保存失败');
    });
    await submit(modal);
    expect(close).not.toHaveBeenCalledWith(true);
    stores.save = originalSave;
    for (const value of ['-1', '1.5', '1000']) {
      (modal.querySelector('#formStorePrice') as HTMLInputElement).value = value;
      const before = (fetch as any).mock.calls.length;
      await expect(
        (window as any).BentoModal.handleStoreFormSubmit({
          preventDefault() {},
          currentTarget: modal.querySelector('form')
        })
      ).resolves.toBeUndefined();
      expect((fetch as any).mock.calls.length).toBe(before);
    }
    (modal.querySelector('#formStorePrice') as HTMLInputElement).value = '18';
    const postsBeforePending = (fetch as any).mock.calls.filter((call: any[]) => call[1]?.method === 'POST').length;
    const p1 = (window as any).BentoModal.handleStoreFormSubmit({
      preventDefault() {},
      currentTarget: modal.querySelector('form')
    });
    const p2 = (window as any).BentoModal.handleStoreFormSubmit({
      preventDefault() {},
      currentTarget: modal.querySelector('form')
    });
    await Promise.all([p1, p2]);
    expect((fetch as any).mock.calls.filter((call: any[]) => call[1]?.method === 'POST').length).toBe(
      postsBeforePending + 1
    );
  });
});
