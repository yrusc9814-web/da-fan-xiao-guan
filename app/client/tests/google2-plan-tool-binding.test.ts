import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const adapter = readFileSync(resolve(process.cwd(), 'public/google2-adapter.js'), 'utf8');
const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const inlineScripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n;\n');
const pageBody = new DOMParser().parseFromString(indexHtml, 'text/html').body.innerHTML;
const bootAdapter = () => {
  document.body.innerHTML = '<div></div>';
  window.eval(adapter);
};
const bootRealPage = () => {
  document.body.innerHTML = pageBody;
  window.eval(inlineScripts);
  window.eval(adapter);
};
const responseOf = (data: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ success: true, data })
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Google2 plan/tool binding', () => {
  it('maps nullable plan four-fields and sends them on POST/PUT without defaults', async () => {
    bootAdapter();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              success: true,
              data: {
                id: 'p1',
                planDate: '2026-10-02',
                mealType: 'LUNCH',
                time: body.time ?? null,
                title: body.title ?? null,
                subtext: body.subtext ?? null,
                icon: body.icon ?? null,
                status: 'PLANNED',
                version: 2,
                items: [{ itemType: 'RECIPE', recipe: { id: 'r1', name: '菜' } }]
              }
            })
        };
      })
    );
    const service = { data: [] as any[] };
    const reload = (window as any).DafanDomainAdapter.replacePlanService(service);
    service.data = [
      {
        id: 'p1',
        planDate: '2026-10-02',
        date: '2026-10-02',
        mealType: 'LUNCH',
        slot: '午餐',
        version: 1,
        targetType: 'recipe',
        targetId: 'r1'
      }
    ];
    await service.update('p1', { time: null, title: null, subtext: null, icon: null });
    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({
      time: null,
      title: null,
      subtext: null,
      icon: null
    });
    expect(
      (window as any).DafanDomainAdapter.mapPlan({ planDate: '2026-10-02', mealType: 'LUNCH', items: [] })
    ).toMatchObject({
      time: null,
      title: null,
      subtext: null,
      icon: null
    });
    expect(reload).toBeTypeOf('function');
  });

  it('submits the real plan picker form with four non-empty fields through the inline handler', async () => {
    bootRealPage();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return responseOf({
          id: 'p-real',
          planDate: body.planDate,
          mealType: body.mealType,
          time: body.time,
          title: body.title,
          subtext: body.subtext,
          icon: body.icon,
          version: 1,
          status: 'PLANNED',
          items: [{ itemType: 'RECIPE', recipe: { id: 'r1', name: '真实菜' } }]
        });
      })
    );
    (window as any).BentoService.recipes.data = [{ id: 'r1', name: '真实菜', icon: '🍜', calories: 520 }];
    (document.getElementById('formPlanId') as HTMLInputElement).value = '';
    (document.getElementById('planPickerSelectTarget') as HTMLInputElement).value = 'recipe:r1';
    (document.getElementById('planPickerDateVal') as HTMLInputElement).value = '2026-10-02';
    (document.getElementById('planPickerTimeVal') as HTMLInputElement).value = '12:30';
    (document.getElementById('planPickerSlotVal') as HTMLInputElement).value = '午餐';
    await (window as any).BentoModal.handlePlanPickerSubmit(new Event('submit', { cancelable: true }));
    const body = JSON.parse(String(requests[0].init?.body));
    expect(body).toMatchObject({
      planDate: '2026-10-02',
      mealType: 'LUNCH',
      time: '12:30',
      title: '真实菜配白米饭',
      icon: '🍜'
    });
    expect(body.subtext).toContain('520');
  });

  it('edits a real plan with PUT metadata and preserves nullable values when omitted', async () => {
    bootRealPage();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return responseOf({
          id: 'p-edit',
          planDate: body.planDate || '2026-10-02',
          mealType: body.mealType || 'LUNCH',
          time: body.time ?? '12:30',
          title: body.title ?? '旧标题',
          subtext: body.subtext ?? '旧副标题',
          icon: body.icon ?? '🍱',
          version: 4,
          status: 'PLANNED',
          items: [{ itemType: 'RECIPE', recipe: { id: 'r1', name: '真实菜' } }]
        });
      })
    );
    const plans: any = {
      data: [
        {
          id: 'p-edit',
          date: '2026-10-02',
          slot: '午餐',
          targetType: 'recipe',
          targetId: 'r1',
          version: 3,
          time: '12:30',
          title: '旧标题',
          subtext: '旧副标题',
          icon: '🍱'
        }
      ]
    };
    (window as any).BentoService.plans = plans;
    const reload = (window as any).DafanDomainAdapter.replacePlanService(plans);
    plans.data = [
      {
        id: 'p-edit',
        date: '2026-10-02',
        slot: '午餐',
        targetType: 'recipe',
        targetId: 'r1',
        version: 3,
        time: null,
        title: null,
        subtext: null,
        icon: null
      }
    ];
    await plans.update('p-edit', { time: null, title: null, subtext: null, icon: null });
    const body = JSON.parse(String(requests[0].init?.body));
    expect(body).toMatchObject({ version: 3, time: null, title: null, subtext: null, icon: null });
    expect(reload).toBeTypeOf('function');
  });

  it('handles a real rendered uncheckin click with visible 409 failure and retry success', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let attempt = 0;
    bootAdapter();
    const toast = vi.fn();
    (window as any).showToast = toast;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (String(url).includes('/uncomplete')) {
          attempt += 1;
          if (attempt === 1) {
            return {
              ok: false,
              status: 409,
              text: async () =>
                JSON.stringify({
                  success: false,
                  error: { code: 'VERSION_CONFLICT', message: '版本冲突，请刷新后重试' }
                })
            };
          }
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                success: true,
                data: {
                  plan: {
                    id: 'p-inline',
                    planDate: '2026-10-02',
                    mealType: 'LUNCH',
                    status: 'PLANNED',
                    version: 8,
                    items: []
                  },
                  removedRecord: { id: 'rec-inline' },
                  idempotent: false
                }
              })
          };
        }
        return responseOf({ items: [], total: 0 });
      })
    );
    bootAdapter();
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener('unhandledrejection', onUnhandled);
    const records: any = { data: [{ id: 'rec-inline' }] };
    const plans: any = {
      data: [
        {
          id: 'p-inline',
          date: '2026-10-02',
          slot: '午餐',
          version: 7,
          isCompleted: true,
          linkedRecordId: 'rec-inline',
          title: '午餐'
        }
      ]
    };
    (window as any).BentoService = { records, plans };
    (window as any).DafanDomainAdapter.replacePlanService(plans);
    (window as any).renderPlans = () => {
      document.body.innerHTML = '<div id="plansListContainer"><div data-plan-id="p-inline"></div></div>';
      const button = document.createElement('button');
      button.type = 'button';
      button.title = '点击取消打卡';
      button.onclick = () => plans.uncheckin('p-inline');
      document.querySelector('[data-plan-id="p-inline"]')?.append(button);
    };
    (window as any).renderPlans();
    const button = document.querySelector('[data-plan-id="p-inline"] button[title]') as HTMLButtonElement;
    expect(button).toBeTruthy();

    button.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('版本冲突，请刷新后重试', 'error'));
    expect(plans.data[0]).toMatchObject({ id: 'p-inline', isCompleted: true, version: 7 });
    expect(records.data).toHaveLength(1);
    expect(unhandled).toHaveLength(0);
    expect(requests.filter((request) => String(request.url).includes('/uncomplete'))).toHaveLength(1);

    button.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('已取消打卡', 'success'));
    expect(plans.data[0]).toMatchObject({ id: 'p-inline', isCompleted: false, version: 8 });
    expect(records.data).toHaveLength(0);
    expect(requests.filter((request) => String(request.url).includes('/uncomplete'))).toHaveLength(2);
    expect(unhandled).toHaveLength(0);
    window.removeEventListener('unhandledrejection', onUnhandled);
  });

  it('sends tool icon as nullable icon and uncheckin updates plan/record cache once', async () => {
    bootAdapter();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        const path = String(url);
        const data = path.includes('/uncomplete')
          ? {
              plan: { id: 'p1', planDate: '2026-10-02', mealType: 'LUNCH', status: 'PLANNED', version: 3, items: [] },
              removedRecord: { id: 'rec1' },
              idempotent: false
            }
          : { id: 't1', name: '锅', icon: null, version: 2 };
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data }) };
      })
    );
    const records = { data: [{ id: 'rec1' }] };
    (window as any).BentoService = { records };
    const tools = { data: [], getById: () => undefined };
    (window as any).DafanDomainAdapter.replaceToolService(tools);
    await tools.save({ name: '锅', icon: null });
    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({ icon: null });

    const plans: any = { data: [{ id: 'p1', version: 2, isCompleted: true }] };
    (window as any).DafanDomainAdapter.replacePlanService(plans);
    const first = plans.uncheckin('p1');
    const second = plans.uncheckin('p1');
    await Promise.all([first, second]);
    expect(requests.filter((x) => String(x.url).includes('/uncomplete'))).toHaveLength(1);
    expect(records.data).toEqual([]);
    expect(plans.data[0]).toMatchObject({ id: 'p1', isCompleted: false, version: 3 });
  });
});
