import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const adapter = readFileSync(resolve(root, 'public/google2-adapter.js'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n;\n');
const markup = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
const jpeg = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=',
    'base64'
  )
);
const response = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () =>
    JSON.stringify(status >= 200 && status < 300 ? { success: true, data } : { success: false, error: data })
});
const page = { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 };
function boot(routes: (url: string, init?: RequestInit) => unknown = () => page) {
  document.body.innerHTML = markup;
  delete (window as any).__google2RecordPhotoCapture;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const result = (await routes(url, init)) as any;
    return result && typeof result.text === 'function' ? result : response(result);
  });
  vi.stubGlobal('fetch', fetchMock);
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
  window.eval(inline);
  window.eval(adapter);
  (window as any).compressImage = async () => `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`;
  (window as any).BentoService = (window as any).BentoService;
  Object.defineProperty(globalThis, 'BentoService', { configurable: true, value: (window as any).BentoService });
  return fetchMock;
}
function recordDto(photos: string[] = []) {
  return {
    id: 'rec1',
    recordDate: '2026-10-02',
    mealType: 'LUNCH',
    sourceType: 'HOMEMADE',
    title: '午餐',
    photos,
    imagePath: photos[0] ?? null,
    version: 2,
    items: [{ itemType: 'CUSTOM', customName: '午餐', sortOrder: 0 }]
  };
}
function ingredientDto(x: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    name: '土豆',
    quantity: 600,
    unit: 'GRAM',
    version: 3,
    category: '蔬菜',
    location: '冷藏室',
    ...x
  };
}
function uploadFile(input: HTMLInputElement, slot: number) {
  (window as any).triggerRecordPhoto(slot);
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File([jpeg], `source-${slot}.jpg`, { type: 'image/jpeg' })]
  });
  return (window as any).onRecordFileSelected({ target: input });
}
function recordCalls(f: ReturnType<typeof vi.fn>, method?: string) {
  return f.mock.calls.filter(
    ([url, init]) => String(url).includes('/records') && (!method || (init as RequestInit)?.method === method)
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Google2 photo/consume real DOM bindings', () => {
  it('three real slots use the same file input and submit ordered multipart JPEGs', async () => {
    const uploads = ['/uploads/a.jpg', '/uploads/b.jpg', '/uploads/c.jpg'];
    const f = boot((url, init) =>
      url.endsWith('/uploads/images')
        ? { url: uploads[f.mock.calls.filter(([u]) => String(u).endsWith('/uploads/images')).length - 1] }
        : url.endsWith('/records') && init?.method === 'POST'
          ? recordDto(uploads)
          : page
    );
    await (window as any).BentoModal.open('recordForm');
    const input = document.getElementById('recordFileInput') as HTMLInputElement;
    await uploadFile(input, 0);
    await uploadFile(input, 1);
    await uploadFile(input, 2);
    (document.getElementById('formRecordTitle') as HTMLInputElement).value = '午餐';
    const form = document.querySelector('#modalRecordForm form') as HTMLFormElement;
    await (window as any).BentoModal.handleRecordFormSubmit({ preventDefault: vi.fn(), currentTarget: form });
    const parts = f.mock.calls.filter(([u]) => String(u).endsWith('/uploads/images'));
    expect(parts).toHaveLength(3);
    expect(
      parts.map(([, i]) =>
        Array.from((i as RequestInit).body as FormData).map(([k, v]) => [k, (v as File).type, (v as File).name])
      )
    ).toEqual([
      [['file', 'image/jpeg', 'record-1.jpg']],
      [['file', 'image/jpeg', 'record-2.jpg']],
      [['file', 'image/jpeg', 'record-3.jpg']]
    ]);
    expect(recordCalls(f, 'POST')).toHaveLength(1);
    expect(JSON.parse(recordCalls(f, 'POST')[0][1].body as string)).toMatchObject({
      imagePath: uploads[0],
      photos: uploads
    });
  });

  it('failed second upload preserves the form and retry reuses the first upload URL', async () => {
    let secondFailed = true;
    const uploads = ['/uploads/a.jpg', '/uploads/b.jpg', '/uploads/c.jpg'];
    const f = boot((url, init) => {
      if (url.endsWith('/uploads/images')) {
        const n = f.mock.calls.filter(([u]) => String(u).endsWith('/uploads/images')).length;
        if (n === 2 && secondFailed) return response({ code: 'UPLOAD_FAILED', message: '图片上传失败' }, 500);
        return { url: uploads[n - 1] };
      }
      return url.endsWith('/records') && init?.method === 'POST' ? recordDto(uploads) : page;
    });
    await (window as any).BentoModal.open('recordForm');
    const input = document.getElementById('recordFileInput') as HTMLInputElement;
    await uploadFile(input, 0);
    await uploadFile(input, 1);
    await uploadFile(input, 2);
    (document.getElementById('formRecordTitle') as HTMLInputElement).value = '保留标题';
    const form = document.querySelector('#modalRecordForm form') as HTMLFormElement;
    await (window as any).BentoModal.handleRecordFormSubmit({ preventDefault: vi.fn(), currentTarget: form });
    expect(recordCalls(f, 'POST')).toHaveLength(0);
    expect((document.getElementById('formRecordTitle') as HTMLInputElement).value).toBe('保留标题');
    secondFailed = false;
    await (window as any).BentoModal.handleRecordFormSubmit({ preventDefault: vi.fn(), currentTarget: form });
    expect(f.mock.calls.filter(([u]) => String(u).endsWith('/uploads/images'))).toHaveLength(4);
    expect(recordCalls(f, 'POST')).toHaveLength(1);
  });

  it('concurrent submits on one real form have one guarded request and no unhandled rejection', async () => {
    let resolvePost!: (x: unknown) => void;
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const f = boot((url, init) =>
      url.endsWith('/records') && init?.method === 'POST'
        ? new Promise((r) => {
            resolvePost = r;
          })
        : page
    );
    await (window as any).BentoModal.open('recordForm');
    (document.getElementById('formRecordTitle') as HTMLInputElement).value = '并发';
    const form = document.querySelector('#modalRecordForm form') as HTMLFormElement;
    const event = { preventDefault: vi.fn(), currentTarget: form };
    const a = (window as any).BentoModal.handleRecordFormSubmit(event);
    const b = (window as any).BentoModal.handleRecordFormSubmit(event);
    await vi.waitFor(() => expect(recordCalls(f, 'POST')).toHaveLength(1));
    resolvePost(recordDto());
    await Promise.all([a, b]);
    expect((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener('unhandledRejection', unhandled);
  });

  it('real photo removal waits for DOM confirmation and clears update photos without leaking to a new form', async () => {
    const f = boot((url, init) =>
      url.endsWith('/records/rec1') && init?.method === 'PUT'
        ? recordDto([])
        : url.includes('/records')
          ? { ...page, items: [recordDto(['/uploads/old.jpg'])], total: 1 }
          : page
    );
    const errors: string[] = [];
    (window as any).showToast = (message: string) => errors.push(message);
    const viewport = document.getElementById('appViewport');
    viewport?.classList.add('mobile-mode');
    const record = (window as any).DafanDomainAdapter.mapRecord(recordDto(['/uploads/old.jpg']));
    (window as any).BentoService.records.data = [record];
    await (window as any).BentoModal.open('recordForm', record);
    const pending = (window as any).removeRecordPhoto({ stopPropagation() {} }, 0);
    await vi.waitFor(() =>
      expect(document.getElementById('mobileDestructiveConfirmOverlay')?.classList.contains('hidden')).toBe(false)
    );
    expect(document.querySelector('#photoSlotView-0 img')).toBeTruthy();
    (document.getElementById('mobileConfirmCancelBtn') as HTMLButtonElement).click();
    await pending;
    expect(document.querySelector('#photoSlotView-0 img')).toBeTruthy();
    const pending2 = (window as any).removeRecordPhoto({ stopPropagation() {} }, 0);
    await vi.waitFor(() => expect(document.getElementById('mobileConfirmOkBtn')).toBeTruthy());
    (document.getElementById('mobileConfirmOkBtn') as HTMLButtonElement).click();
    await pending2;
    const form = document.querySelector('#modalRecordForm form') as HTMLFormElement;
    await (window as any).BentoModal.handleRecordFormSubmit({ preventDefault: vi.fn(), currentTarget: form });
    expect(recordCalls(f, 'PUT'), JSON.stringify(errors)).toHaveLength(1);
    expect(JSON.parse(recordCalls(f, 'PUT')[0][1].body as string)).toMatchObject({ photos: [], imagePath: null });
    await (window as any).BentoModal.close(true);
    await (window as any).BentoModal.open('recordForm');
    expect(document.querySelector('#photoSlotView-0 img')).toBeNull();
  });

  it('non-GRAM rejects gram buttons visibly without sending a request', async () => {
    const item = ingredientDto({ unit: 'PIECE' });
    const f = boot((url) => (url.endsWith('/ingredients/i1') ? item : page));
    const messages: string[] = [];
    (window as any).showToast = (message: string) => messages.push(message);
    await (window as any).BentoModal.open('ingredientDetail', 'i1');
    (document.querySelector('#modalIngredientDetail button[onclick*="100"]') as HTMLButtonElement).click();
    expect(messages.some((message) => message.includes('GRAM'))).toBe(true);
    expect(f.mock.calls.some(([url]) => String(url).includes('/consume'))).toBe(false);
  });

  it('409 refreshes the visible detail version and the next real click retries with it', async () => {
    let attempt = 0;
    let item = ingredientDto();
    const f = boot((url) => {
      if (url.endsWith('/ingredients/i1/consume')) {
        attempt += 1;
        if (attempt === 1) {
          item = ingredientDto({ version: 4, quantity: 550 });
          return response({ code: 'VERSION_CONFLICT', message: '版本冲突' }, 409);
        }
        item = ingredientDto({ version: 5, quantity: 450 });
        return { ingredient: item };
      }
      return url.endsWith('/ingredients/i1') ? item : page;
    });
    const messages: string[] = [];
    (window as any).showToast = (message: string) => messages.push(message);
    await (window as any).BentoModal.open('ingredientDetail', 'i1');
    const click = () =>
      (document.querySelector('#modalIngredientDetail button[onclick*="100"]') as HTMLButtonElement).click();
    click();
    await vi.waitFor(() => expect(messages).toContain('版本冲突'));
    expect((window as any).BentoModal.currentPayload.version).toBe(4);
    click();
    await vi.waitFor(() => expect((window as any).BentoModal.currentPayload.version).toBe(5));
    const calls = f.mock.calls.filter(([url]) => String(url).includes('/consume'));
    expect(calls.map(([, init]) => JSON.parse(init.body as string).ingredientVersion)).toEqual([3, 4]);
    expect((window as any).BentoService.pantry.getById('i1').quantity).toBe(450);
  });

  it('late compression cannot populate a newly opened record form', async () => {
    boot();
    await (window as any).BentoModal.open('recordForm');
    let finish!: (value: string) => void;
    (window as any).compressImage = () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      });
    const pending = uploadFile(document.getElementById('recordFileInput') as HTMLInputElement, 0);
    await (window as any).BentoModal.close(true);
    await (window as any).BentoModal.open('recordForm');
    finish(`data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`);
    await pending;
    expect(document.querySelector('#photoSlotView-0 img')).toBeNull();
  });

  it.each([
    [100, 'QUANTITY', 100, 'GRAM'],
    [250, 'QUANTITY', 250, 'GRAM'],
    ['all', 'ALL', undefined, undefined]
  ])('ingredient detail real button sends %s body and refreshes DOM', async (amount, mode, quantity, unit) => {
    const next = ingredientDto({ quantity: amount === 'all' ? 0 : 600 - Number(amount), version: 4 });
    const f = boot((url) =>
      url.endsWith('/ingredients/i1/consume')
        ? { ingredient: next }
        : url.endsWith('/ingredients/i1')
          ? ingredientDto()
          : page
    );
    (window as any).BentoService.pantry.data = [(window as any).DafanDomainAdapter.mapPantryItem(ingredientDto())];
    await (window as any).BentoModal.open('ingredientDetail', 'i1');
    const buttons = document.querySelectorAll('#modalIngredientDetail button');
    const button = amount === 100 ? buttons[1] : amount === 250 ? buttons[2] : buttons[3];
    (button as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(
        f.mock.calls.some(([u, i]) => String(u).includes('/consume') && (i as RequestInit)?.method === 'POST')
      ).toBe(true)
    );
    const call = f.mock.calls.find(([u]) => String(u).includes('/consume'))!;
    expect(JSON.parse(call[1].body as string)).toMatchObject({
      mode,
      ingredientVersion: 3,
      ...(quantity ? { quantity, unit } : {})
    });
  });
});
