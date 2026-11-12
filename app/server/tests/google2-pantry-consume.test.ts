import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPrismaClient } from '../src/database/test-database.js';
import { registerErrorHandlers } from '../src/plugins/error-handler.js';
import { runtimeValidationFastifyOptions } from '../src/plugins/schema-validation.js';
import { registerIngredientRoutes } from '../src/modules/ingredients/routes.js';

/**
 * Google2 库存详情固定按钮的聚合消耗契约（真实 HTTP + 真实 Prisma，无 mock）。
 *
 * UI 事实来源：app/client/index.html index 3414–3416
 *   `BentoService.pantry.consume(currentPayload, 100 | 250 | 'all')`
 * → POST /api/v1/ingredients/:id/consume
 *   { mode:'QUANTITY', quantity, unit, ingredientVersion } 或 { mode:'ALL', ingredientVersion }
 *
 * 覆盖：服务端批次顺序（consumePriority desc → expiryDate asc → createdAt asc → id asc）、
 * 跨单位换算、事务乐观锁、冲突 fail-closed（无部分扣减）、ALL 真实全清、
 * InventoryLog 逐批次记录、汇总同步、不足/负数/无兼容单位拒绝。
 */

const database = createTestPrismaClient();
let app: FastifyInstance;

const createdIngredientIds: string[] = [];

interface BatchSpec {
  quantity: number;
  unit: 'GRAM' | 'KILOGRAM' | 'PIECE';
  expiryDate?: string | null;
  consumePriority?: boolean;
  location?: string | null;
}

async function inject(
  method: 'POST' | 'GET',
  url: string,
  payload?: unknown
): Promise<{ statusCode: number; body: any }> {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  });
  return { statusCode: response.statusCode, body: response.json() };
}

async function createIngredient(name: string, batches: BatchSpec[]): Promise<any> {
  const { statusCode, body } = await inject('POST', '/api/v1/ingredients', {
    name,
    unit: 'GRAM',
    batches
  });
  expect(statusCode).toBe(201);
  createdIngredientIds.push(body.data.id);
  return body.data;
}

async function fetchIngredient(id: string): Promise<any> {
  const { statusCode, body } = await inject('GET', `/api/v1/ingredients/${id}`);
  expect(statusCode).toBe(200);
  return body.data;
}

async function batchRows(id: string) {
  return database.inventoryBatch.findMany({
    where: { ingredientId: id, deletedAt: null },
    orderBy: [{ consumePriority: 'desc' }, { expiryDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
  });
}

async function logsOf(id: string) {
  return database.inventoryLog.findMany({
    where: { ingredientId: id, changeType: 'MANUAL_DEDUCT' },
    orderBy: { createdAt: 'asc' }
  });
}

/** 直接落真实批次行（含 API 不允许创建的不可换算单位批次），模拟真实历史数据。 */
async function seedIngredientWithBatches(name: string, batches: BatchSpec[]): Promise<string> {
  const created = await database.ingredient.create({
    data: {
      name,
      unit: 'GRAM',
      quantity: 0,
      inventoryBatches: {
        create: batches.map((batch) => ({
          quantity: batch.quantity,
          unit: batch.unit,
          expiryDate: batch.expiryDate ?? null,
          consumePriority: batch.consumePriority ?? false,
          location: batch.location ?? null
        }))
      }
    }
  });
  createdIngredientIds.push(created.id);
  return created.id;
}

describe('Google2 库存聚合消耗 API（真实持久化）', () => {
  beforeAll(async () => {
    await database.$connect();
    app = Fastify({ logger: false, ...runtimeValidationFastifyOptions });
    registerErrorHandlers(app);
    await registerIngredientRoutes(app, database);
  });

  afterAll(async () => {
    if (createdIngredientIds.length) {
      await database.inventoryLog.deleteMany({ where: { ingredientId: { in: createdIngredientIds } } });
      await database.inventoryBatch.deleteMany({ where: { ingredientId: { in: createdIngredientIds } } });
      await database.ingredient.deleteMany({ where: { id: { in: createdIngredientIds } } });
    }
    await app.close();
    await database.$disconnect();
  });

  it('QUANTITY：按服务端批次顺序跨批次扣减，换算真实，日志与汇总同步', async () => {
    const dto = await createIngredient('聚合消耗契约·跨批次', [
      { quantity: 100, unit: 'GRAM', expiryDate: '2026-12-10' },
      { quantity: 0.3, unit: 'KILOGRAM', expiryDate: '2026-12-20', consumePriority: true },
      { quantity: 200, unit: 'GRAM', expiryDate: '2026-12-05' }
    ]);
    // 顺序：consumePriority 优先（KILOGRAM 批），其余按到期日升序（12-05 在 12-10 前）
    const order = await batchRows(dto.id);
    expect(order.map((b) => [b.quantity, b.unit, b.expiryDate])).toEqual([
      [0.3, 'KILOGRAM', '2026-12-20'],
      [200, 'GRAM', '2026-12-05'],
      [100, 'GRAM', '2026-12-10']
    ]);

    const consumed = await inject('POST', `/api/v1/ingredients/${dto.id}/consume`, {
      mode: 'QUANTITY',
      quantity: 350,
      unit: 'GRAM',
      ingredientVersion: dto.version
    });
    expect(consumed.statusCode).toBe(200);
    const data = consumed.body.data;
    // 0.3kg 批全扣（300g）+ 200g 批扣 50g = 350g；100g 批不动
    expect(data.mode).toBe('QUANTITY');
    expect(data.consumedQuantity).toBe(350);
    expect(data.consumedUnit).toBe('GRAM');
    expect(data.incompatibleBatchIds).toEqual([]);
    expect(data.allocations).toHaveLength(2);
    expect(data.allocations[0]).toMatchObject({
      batchId: order[0].id,
      beforeQuantity: 0.3,
      afterQuantity: 0,
      unit: 'KILOGRAM',
      changeQuantity: -0.3
    });
    expect(data.allocations[1]).toMatchObject({
      batchId: order[1].id,
      beforeQuantity: 200,
      afterQuantity: 150,
      unit: 'GRAM',
      changeQuantity: -50
    });
    // 批次版本真实前进
    const afterBatches = await batchRows(dto.id);
    expect(afterBatches.map((b) => [b.id, b.quantity, b.version])).toEqual([
      [order[0].id, 0, 2],
      [order[1].id, 150, 2],
      [order[2].id, 100, 1]
    ]);
    // 食材汇总 = 剩余活批次按基础单位重算，版本前进
    const ingredient = await fetchIngredient(dto.id);
    expect(ingredient.quantity).toBe(250);
    expect(ingredient.version).toBe(dto.version + 1);
    expect(data.ingredient.quantity).toBe(250);
    expect(data.ingredient.version).toBe(dto.version + 1);
    // InventoryLog：逐批次真实 before/change/after，批次单位，MANUAL_DEDUCT，关联批次
    const logs = await logsOf(dto.id);
    expect(logs).toHaveLength(2);
    expect(
      logs.map((l) => [l.inventoryBatchId, l.beforeQuantity, l.changeQuantity, l.afterQuantity, l.unit, l.changeType])
    ).toEqual([
      [order[0].id, 0.3, -0.3, 0, 'KILOGRAM', 'MANUAL_DEDUCT'],
      [order[1].id, 200, -50, 150, 'GRAM', 'MANUAL_DEDUCT']
    ]);
    expect(data.inventoryLogIds).toHaveLength(2);
    expect(logs.map((l) => l.id).sort()).toEqual([...data.inventoryLogIds].sort());
  });

  it('重复提交同一 ingredientVersion → 409 VERSION_CONFLICT，绝不二次扣减', async () => {
    const dto = await createIngredient('聚合消耗契约·幂等', [{ quantity: 500, unit: 'GRAM' }]);
    const payload = { mode: 'QUANTITY', quantity: 100, unit: 'GRAM', ingredientVersion: dto.version };

    const first = await inject('POST', `/api/v1/ingredients/${dto.id}/consume`, payload);
    expect(first.statusCode).toBe(200);
    expect(first.body.data.consumedQuantity).toBe(100);

    const second = await inject('POST', `/api/v1/ingredients/${dto.id}/consume`, payload);
    expect(second.statusCode).toBe(409);
    expect(second.body.error.code).toBe('VERSION_CONFLICT');
    expect(second.body.error.details).toMatchObject({
      entity: 'Ingredient',
      expectedVersion: dto.version,
      actualVersion: dto.version + 1
    });

    const ingredient = await fetchIngredient(dto.id);
    expect(ingredient.quantity).toBe(400);
    expect(await logsOf(dto.id)).toHaveLength(1);
  });

  it('库存不足 → 409 且完全无部分扣减（批次/版本/日志全部不变）', async () => {
    const dto = await createIngredient('聚合消耗契约·不足', [
      { quantity: 100, unit: 'GRAM', expiryDate: '2026-12-01' },
      { quantity: 200, unit: 'GRAM', expiryDate: '2026-12-02' }
    ]);
    const before = await batchRows(dto.id);

    const tooMuch = await inject('POST', `/api/v1/ingredients/${dto.id}/consume`, {
      mode: 'QUANTITY',
      quantity: 301,
      unit: 'GRAM',
      ingredientVersion: dto.version
    });
    expect(tooMuch.statusCode).toBe(409);
    expect(tooMuch.body.error.code).toBe('CONFLICT');
    expect(tooMuch.body.error.message).toContain('不足');

    const after = await batchRows(dto.id);
    expect(after.map((b) => [b.id, b.quantity, b.version])).toEqual(before.map((b) => [b.id, b.quantity, b.version]));
    const ingredient = await fetchIngredient(dto.id);
    expect(ingredient.quantity).toBe(300);
    expect(ingredient.version).toBe(dto.version);
    expect(await logsOf(dto.id)).toHaveLength(0);
  });

  it('不可换算批次：明确列入 incompatibleBatchIds 不静默跳过，兼容批次照常扣', async () => {
    const id = await seedIngredientWithBatches('聚合消耗契约·不可换算', [
      { quantity: 150, unit: 'GRAM', expiryDate: '2026-12-01' },
      { quantity: 5, unit: 'PIECE', expiryDate: '2026-12-02' }
    ]);
    const version = (await fetchIngredient(id)).version;

    const consumed = await inject('POST', `/api/v1/ingredients/${id}/consume`, {
      mode: 'QUANTITY',
      quantity: 150,
      unit: 'GRAM',
      ingredientVersion: version
    });
    expect(consumed.statusCode).toBe(200);
    const rows = await batchRows(id);
    const pieceBatch = rows.find((b) => b.unit === 'PIECE')!;
    expect(consumed.body.data.incompatibleBatchIds).toEqual([pieceBatch.id]);
    expect(pieceBatch.quantity).toBe(5);
    expect(pieceBatch.version).toBe(1);
    expect(consumed.body.data.allocations).toHaveLength(1);
    expect(consumed.body.data.consumedQuantity).toBe(150);

    // 仅剩不可换算批次（兼容批次已耗尽）时按该单位继续消耗 → 409 明确拒绝
    const blocked = await inject('POST', `/api/v1/ingredients/${id}/consume`, {
      mode: 'QUANTITY',
      quantity: 1,
      unit: 'GRAM',
      ingredientVersion: consumed.body.data.ingredient.version
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body.error.message).toContain('不可换算');
    const pieceAfter = await database.inventoryBatch.findUniqueOrThrow({ where: { id: pieceBatch.id } });
    expect(pieceAfter.quantity).toBe(5);
    expect(pieceAfter.version).toBe(1);
  });

  it('负数 / 0 / 缺单位 / ALL 携带数量 → 400 快速失败，无任何副作用', async () => {
    const dto = await createIngredient('聚合消耗契约·非法输入', [{ quantity: 100, unit: 'GRAM' }]);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['负数', { mode: 'QUANTITY', quantity: -5, unit: 'GRAM', ingredientVersion: dto.version }],
      ['0', { mode: 'QUANTITY', quantity: 0, unit: 'GRAM', ingredientVersion: dto.version }],
      ['缺单位', { mode: 'QUANTITY', quantity: 50, ingredientVersion: dto.version }],
      ['缺数量', { mode: 'QUANTITY', unit: 'GRAM', ingredientVersion: dto.version }],
      ['ALL 携带数量', { mode: 'ALL', quantity: 50, ingredientVersion: dto.version }],
      ['ALL 携带单位', { mode: 'ALL', unit: 'GRAM', ingredientVersion: dto.version }],
      ['未知模式', { mode: 'HALF', quantity: 50, unit: 'GRAM', ingredientVersion: dto.version }],
      ['版本非正整数', { mode: 'QUANTITY', quantity: 50, unit: 'GRAM', ingredientVersion: 0 }]
    ];
    for (const [label, payload] of cases) {
      const response = await inject('POST', `/api/v1/ingredients/${dto.id}/consume`, payload);
      expect(response.statusCode, label).toBe(400);
      expect(response.body.error.code, label).toBe('VALIDATION_ERROR');
    }
    const ingredient = await fetchIngredient(dto.id);
    expect(ingredient.quantity).toBe(100);
    expect(ingredient.version).toBe(dto.version);
    expect(await logsOf(dto.id)).toHaveLength(0);
  });

  it('ALL：按真实全部活批次清零（含不可换算单位），consumedQuantity 如实为 null 明细完整', async () => {
    const id = await seedIngredientWithBatches('聚合消耗契约·全部用完', [
      { quantity: 120, unit: 'GRAM', expiryDate: '2026-12-01' },
      { quantity: 0.05, unit: 'KILOGRAM', expiryDate: '2026-12-02' },
      { quantity: 3, unit: 'PIECE', expiryDate: '2026-12-03' }
    ]);
    const version = (await fetchIngredient(id)).version;

    const consumed = await inject('POST', `/api/v1/ingredients/${id}/consume`, {
      mode: 'ALL',
      ingredientVersion: version
    });
    expect(consumed.statusCode).toBe(200);
    const data = consumed.body.data;
    expect(data.mode).toBe('ALL');
    expect(data.allocations).toHaveLength(3);
    // 混合不可换算单位时汇总无法如实给出 → null，不臆造数字；明细逐批次齐全
    expect(data.consumedQuantity).toBeNull();
    const rows = await batchRows(id);
    expect(rows.every((b) => b.quantity === 0 && b.version === 2)).toBe(true);
    const ingredient = await fetchIngredient(id);
    expect(ingredient.quantity).toBe(0);
    expect(ingredient.version).toBe(version + 1);
    expect(ingredient.status).toBe('DEPLETED');
    const logs = await logsOf(id);
    expect(logs).toHaveLength(3);
    expect(logs.every((l) => l.changeType === 'MANUAL_DEDUCT' && l.afterQuantity === 0)).toBe(true);
  });

  it('无任何活批次（全 0）时拒绝消耗；已删除食材返回 404', async () => {
    const empty = await createIngredient('聚合消耗契约·空库存', [{ quantity: 0, unit: 'GRAM' }]);
    const zero = await inject('POST', `/api/v1/ingredients/${empty.id}/consume`, {
      mode: 'QUANTITY',
      quantity: 10,
      unit: 'GRAM',
      ingredientVersion: empty.version
    });
    expect(zero.statusCode).toBe(409);
    expect(zero.body.error.code).toBe('CONFLICT');

    const dto = await createIngredient('聚合消耗契约·已删除', [{ quantity: 100, unit: 'GRAM' }]);
    const removed = await inject('POST', `/api/v1/ingredients/${dto.id}/consume`, {
      mode: 'QUANTITY',
      quantity: 10,
      unit: 'GRAM',
      ingredientVersion: dto.version
    });
    expect(removed.statusCode).toBe(200);

    const del = await database.ingredient.update({
      where: { id: dto.id },
      data: { deletedAt: new Date() }
    });
    expect(del.deletedAt).not.toBeNull();
    const missing = await inject('POST', `/api/v1/ingredients/${dto.id}/consume`, {
      mode: 'QUANTITY',
      quantity: 10,
      unit: 'GRAM',
      ingredientVersion: 2
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.body.error.message).toContain('食材不存在');
  });

  it('单批次 KILOGRAM 食材按 GRAM 请求部位扣减，换算比例真实（0.15kg → 150g）', async () => {
    const dto = await createIngredient('聚合消耗契约·换算比例', [{ quantity: 0.5, unit: 'KILOGRAM' }]);
    const consumed = await inject('POST', `/api/v1/ingredients/${dto.id}/consume`, {
      mode: 'QUANTITY',
      quantity: 150,
      unit: 'GRAM',
      ingredientVersion: dto.version
    });
    expect(consumed.statusCode).toBe(200);
    expect(consumed.body.data.consumedQuantity).toBe(150);
    expect(consumed.body.data.allocations[0]).toMatchObject({
      beforeQuantity: 0.5,
      afterQuantity: 0.35,
      unit: 'KILOGRAM',
      changeQuantity: -0.15
    });
  });
});
