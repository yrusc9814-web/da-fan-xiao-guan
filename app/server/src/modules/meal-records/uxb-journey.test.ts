/**
 * UX-B Journey 验收（API 层，不启动服务）
 * UXB-003 Recommendation → Completion Core Flow
 *
 * 覆盖：
 * - 从明确餐次 recommendation 进入完成用餐必须继承 mealType（CompleteMealPage 传 mealType；
 *   confirm-from-recipe 仍以请求 mealType 落记录，不按当前时间推断）；
 * - 加入计划后的「就吃这个/完成这一餐」必须保留 plan identity：confirm-from-recipe 携带
 *   relatedPlanId 时，记录以计划为准收口（餐次/日期取计划，记录真实 relatedPlanId，
 *   计划原子置为已完成，不产生 DRAFT 幽灵记录）；
 * - Cancel 不产生 ghost record：计划取消后通过即时用餐确认应被拒绝，数据库无残留记录。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { createTestPrismaClient } from '../../database/test-database.js';
import { registerErrorHandlers } from '../../plugins/error-handler.js';
import { registerRecipeRoutes } from '../recipes/routes.js';
import { registerMealRecordRoutes } from '../meal-records/routes.js';
import { registerConsumptionRoutes } from '../consumption/routes.js';
import { registerMealPlanRoutes } from '../meal-plans/routes.js';

const database = createTestPrismaClient();
const app = Fastify({ logger: false });

describe('UX-B-003 计划收口与 mealType 继承验收', () => {
  beforeAll(async () => {
    await database.$connect();
    registerErrorHandlers(app);
    await registerRecipeRoutes(app, database);
    await registerMealRecordRoutes(app, database);
    await registerConsumptionRoutes(app, database);
    await registerMealPlanRoutes(app, database);
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  // MealPlan 有 (planDate, mealType) 唯一键：用递增日期避免用例间互相冲突
  let planDateCursor = 10;
  function nextPlanDate(): string {
    const date = new Date(Date.UTC(2046, 7, planDateCursor));
    planDateCursor += 1;
    return date.toISOString().slice(0, 10);
  }

  /** 建结构化食材菜谱（带库存批次），返回 { ingredient, recipeId } */
  async function seedStructuredRecipe(stamp: string) {
    const ingredient = await database.ingredient.create({
      data: {
        name: `UXB蒜苔-${stamp}`,
        unit: 'GRAM',
        quantity: 400,
        inventoryBatches: { create: { quantity: 400, unit: 'GRAM' } }
      }
    });
    const recipeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/recipes',
      payload: {
        name: `UXB蒜苔炒肉-${stamp}`,
        servings: 1,
        enabledForRecommendation: true,
        mealTypes: ['DINNER'],
        ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: 150, unit: 'GRAM' }]
      }
    });
    expect(recipeRes.statusCode).toBe(201);
    return { ingredient, recipeId: recipeRes.json().data.id as string };
  }

  it('套餐次继承：from recommendation mealType=BREAKFAST 完成时记录保持 BREAKFAST，不随时间/推断漂移', async () => {
    const stamp = `mt-${Date.now()}`;
    const { ingredient, recipeId } = await seedStructuredRecipe(stamp);
    const recordDate = nextPlanDate();
    // 明确餐次推荐（RecommendationsPage eatThis 携带 mealType=BREAKFAST）
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/preview-from-recipe',
      payload: {
        recipeId,
        mealType: 'BREAKFAST',
        sourceType: 'HOMEMADE',
        recordDate
      }
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json().data;

    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/confirm-from-recipe',
      payload: {
        recipeId,
        mealType: 'BREAKFAST',
        sourceType: 'HOMEMADE',
        recordDate,
        previewToken: preview.previewToken,
        operationId: `uxb-mt-${stamp}`
      }
    });
    expect(confirmRes.statusCode).toBe(200);
    const record = await database.mealRecord.findUnique({
      where: { id: confirmRes.json().data.recordId },
      include: { items: true }
    });
    expect(record).not.toBeNull();
    expect(record!.mealType).toBe('BREAKFAST');
    expect(record!.recordDate).toBe(recordDate);
    expect(record!.relatedPlanId).toBeNull();
    expect(record!.sourceMealPlanId).toBeNull();
    expect(record!.status).toBe('CONFIRMED');
    // 记录项真实关联菜谱
    expect(record!.items).toHaveLength(1);
    // 不影响 DB ingredient 关联
    expect(ingredient.id).toBeTruthy();
  });

  it('单菜谱计划完成收口：relatedPlanId 关联、餐次/日期取计划、计划置 COMPLETED、无 DRAFT', async () => {
    const stamp = `plan-${Date.now()}`;
    const { ingredient, recipeId } = await seedStructuredRecipe(stamp);
    const planDate = nextPlanDate();

    // 加入计划（PLANNED，晚餐）
    const planRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      payload: {
        planDate,
        mealType: 'DINNER',
        dinerCount: 2,
        items: [{ itemType: 'RECIPE', recipeId, mealRole: 'MAIN', sortOrder: 0 }]
      }
    });
    expect(planRes.statusCode).toBe(201);
    const plan = planRes.json().data;

    // 从计划进入「完成这一餐」：preview 携带 relatedPlanId（餐次/日期与计划一致）
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/preview-from-recipe',
      payload: {
        recipeId,
        mealType: 'DINNER',
        sourceType: 'HOMEMADE',
        recordDate: planDate,
        relatedPlanId: plan.id
      }
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json().data;
    expect(preview.dinerCount).toBe(2); // 人数按计划（2 人）而非默认 1 人

    // 确认：计划收口 + 生成 CONFIRMED 记录
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/confirm-from-recipe',
      payload: {
        recipeId,
        mealType: 'DINNER',
        sourceType: 'HOMEMADE',
        recordDate: planDate, // 与 preview 一致；落库取计划 planDate
        relatedPlanId: plan.id,
        previewToken: preview.previewToken,
        operationId: `uxb-plan-${stamp}`
      }
    });
    expect(confirmRes.statusCode).toBe(200);
    const record = await database.mealRecord.findUniqueOrThrow({
      where: { id: confirmRes.json().data.recordId }
    });
    // 记录真实关联计划
    expect(record.relatedPlanId).toBe(plan.id);
    expect(record.sourceMealPlanId).toBe(plan.id);
    expect(record.status).toBe('CONFIRMED');
    // 餐次/日期以计划为准（不吃页面传入值）
    expect(record.mealType).toBe('DINNER');
    expect(record.recordDate).toBe(planDate);

    // 计划已收口为 COMPLETED
    const closed = await database.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(closed.status).toBe('COMPLETED');
    expect(closed.completedAt).not.toBeNull();

    // 本计划相关无 DRAFT 幽灵记录（confirm-from-recipe 不预建 DRAFT）
    const planDrafts = await database.mealRecord.count({
      where: { status: 'DRAFT', OR: [{ relatedPlanId: plan.id }, { sourceMealPlanId: plan.id }] }
    });
    expect(planDrafts).toBe(0);
    expect(ingredient.id).toBeTruthy();
  });

  it('Cancel 不产生 ghost record：已取消计划不能通过即时用餐确认，数据库无残留', async () => {
    const stamp = `cancel-${Date.now()}`;
    const { ingredient, recipeId } = await seedStructuredRecipe(stamp);
    const planRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      payload: {
        planDate: nextPlanDate(),
        mealType: 'DINNER',
        dinerCount: 1,
        items: [{ itemType: 'RECIPE', recipeId, mealRole: 'MAIN', sortOrder: 0 }]
      }
    });
    const plan = planRes.json().data;

    // 取消计划
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/cancel`,
      payload: { version: plan.version }
    });
    expect(cancelRes.statusCode).toBe(200);

    // 已取消计划在 preview 阶段即被拒绝
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/preview-from-recipe',
      payload: {
        recipeId,
        mealType: 'DINNER',
        sourceType: 'HOMEMADE',
        relatedPlanId: plan.id
      }
    });
    expect(previewRes.statusCode).toBe(409);

    // 数据库无任何该计划/菜谱产生的记录（无 ghost）
    const planRecordCount = await database.mealRecord.count({
      where: { OR: [{ relatedPlanId: plan.id }, { sourceMealPlanId: plan.id }] }
    });
    expect(planRecordCount).toBe(0);
    const recipeRecords = await database.mealRecord.count({ where: { items: { some: { recipeId } } } });
    expect(recipeRecords).toBe(0);
    expect(ingredient.id).toBeTruthy();
  });

  it('多项目计划不能通过即时用餐链路绕过，改由计划页 completePlan（保留既有 Plan 状态机）', async () => {
    const stamp = `multi-${Date.now()}`;
    const { ingredient: ingA, recipeId: recipeA } = await seedStructuredRecipe(`${stamp}-a`);
    const ingB = await database.ingredient.create({
      data: {
        name: `UXB土豆-${stamp}`,
        unit: 'GRAM',
        quantity: 200,
        inventoryBatches: { create: { quantity: 200, unit: 'GRAM' } }
      }
    });
    const recipeBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/recipes',
      payload: {
        name: `UXB土豆丝-${stamp}`,
        servings: 1,
        ingredients: [{ ingredientId: ingB.id, name: ingB.name, quantity: 100, unit: 'GRAM' }]
      }
    });
    const recipeB = recipeBRes.json().data.id as string;

    const planRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      payload: {
        planDate: nextPlanDate(),
        mealType: 'LUNCH',
        dinerCount: 2,
        items: [
          { itemType: 'RECIPE', recipeId: recipeA, mealRole: 'MAIN', sortOrder: 0 },
          { itemType: 'RECIPE', recipeId: recipeB, mealRole: 'SIDE', sortOrder: 1 }
        ]
      }
    });
    expect(planRes.statusCode).toBe(201);
    const plan = planRes.json().data;

    // 从单菜谱即时用餐入口尝试收口多项目计划 → 409
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/preview-from-recipe',
      payload: {
        recipeId: recipeA,
        mealType: 'LUNCH',
        sourceType: 'HOMEMADE',
        relatedPlanId: plan.id
      }
    });
    expect(previewRes.statusCode).toBe(409);

    // 计划页既有 completePlan 状态机仍可用
    const completeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/complete`,
      payload: { version: plan.version }
    });
    expect(completeRes.statusCode).toBe(200);
    const result = completeRes.json().data;
    expect(result.pendingDraftRecordId).toBeTruthy();
    const draft = await database.mealRecord.findUniqueOrThrow({
      where: { id: result.pendingDraftRecordId }
    });
    expect(draft.status).toBe('DRAFT');
    expect(draft.relatedPlanId).toBe(plan.id);
    const closed = await database.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(closed.status).toBe('COMPLETED');
    expect(ingA.id && ingB.id).toBeTruthy();
  });

  interface Seeded {
    recipeId: string;
    planAId: string;
    planBId: string;
  }

  /** 建一个结构化菜谱 + 两个同菜谱单菜计划（A=晚餐，B=午餐，日期互不冲突） */
  async function seedPlanPair(stamp: string): Promise<Seeded> {
    const ingredient = await database.ingredient.create({
      data: {
        name: `Closure食材-${stamp}`,
        unit: 'GRAM',
        quantity: 900,
        inventoryBatches: { create: { quantity: 900, unit: 'GRAM' } }
      }
    });
    const recipeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/recipes',
      payload: {
        name: `Closure测试菜-${stamp}`,
        servings: 1,
        ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: 150, unit: 'GRAM' }]
      }
    });
    expect(recipeRes.statusCode).toBe(201);
    const recipeId = recipeRes.json().data.id as string;
    const planADate = nextPlanDate();
    const planBDate = nextPlanDate();
    const createPlan = async (planDate: string, mealType: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/plans',
        payload: {
          planDate,
          mealType,
          dinerCount: 1,
          items: [{ itemType: 'RECIPE', recipeId, mealRole: 'MAIN', sortOrder: 0 }]
        }
      });
      expect(res.statusCode).toBe(201);
      return res.json().data as { id: string; version: number };
    };
    const planA = await createPlan(planADate, 'DINNER');
    const planB = await createPlan(planBDate, 'LUNCH');
    return { recipeId, planAId: planA.id, planBId: planB.id };
  }

  it('A：Preview 计划 A，Confirm 换成计划 B → 409 拒绝，计划 A/B 均未收口、无记录', async () => {
    const { recipeId, planAId, planBId } = await seedPlanPair(`A-${Date.now()}`);
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/preview-from-recipe',
      payload: { recipeId, mealType: 'DINNER', sourceType: 'HOMEMADE', relatedPlanId: planAId }
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json().data;

    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/confirm-from-recipe',
      payload: {
        recipeId,
        mealType: 'DINNER', // 餐次与 preview 相同，仅计划身份从 A 换成 B → 必须拒绝
        sourceType: 'HOMEMADE',
        relatedPlanId: planBId,
        previewToken: preview.previewToken,
        operationId: `closure-A-${planBId}`
      }
    });
    expect(confirmRes.statusCode).toBe(409);

    // 两个计划都保持原状（未完成、未取消），无任何记录落库
    for (const planId of [planAId, planBId]) {
      const plan = await database.mealPlan.findUniqueOrThrow({ where: { id: planId } });
      expect(plan.status).toBe('PLANNED');
      expect(plan.completedAt).toBeNull();
      const linked = await database.mealRecord.count({
        where: { OR: [{ relatedPlanId: planId }, { sourceMealPlanId: planId }] }
      });
      expect(linked).toBe(0);
    }
  });

  it('B：Preview DINNER，Confirm 上下文换成其它餐次 → 409，不静默成功为另一餐次', async () => {
    const { recipeId, planAId } = await seedPlanPair(`B-${Date.now()}`);
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/preview-from-recipe',
      payload: { recipeId, mealType: 'DINNER', sourceType: 'HOMEMADE', relatedPlanId: planAId }
    });
    const preview = previewRes.json().data;

    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/confirm-from-recipe',
      payload: {
        recipeId,
        mealType: 'BREAKFAST', // 与 preview 的 DINNER 漂移 → 必须拒绝
        sourceType: 'HOMEMADE',
        relatedPlanId: planAId,
        previewToken: preview.previewToken,
        operationId: `closure-B-${planAId}`
      }
    });
    expect(confirmRes.statusCode).toBe(409);
    const plan = await database.mealPlan.findUniqueOrThrow({ where: { id: planAId } });
    expect(plan.status).toBe('PLANNED');
    expect(await database.mealRecord.count({ where: { relatedPlanId: planAId } })).toBe(0);
  });

  it('C：合法 Preview → Confirm 正常完成，计划与 MealRecord 正确关联', async () => {
    const { recipeId, planAId } = await seedPlanPair(`C-${Date.now()}`);
    const planA = await database.mealPlan.findUniqueOrThrow({ where: { id: planAId } });
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/preview-from-recipe',
      payload: { recipeId, mealType: 'DINNER', sourceType: 'HOMEMADE', relatedPlanId: planAId }
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json().data;

    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/confirm-from-recipe',
      payload: {
        recipeId,
        mealType: 'DINNER',
        sourceType: 'HOMEMADE',
        relatedPlanId: planAId,
        previewToken: preview.previewToken,
        operationId: `closure-C-${planAId}`
      }
    });
    expect(confirmRes.statusCode).toBe(200);
    const record = await database.mealRecord.findUniqueOrThrow({
      where: { id: confirmRes.json().data.recordId }
    });
    expect(record.relatedPlanId).toBe(planAId);
    expect(record.sourceMealPlanId).toBe(planAId);
    expect(record.mealType).toBe('DINNER');
    expect(record.recordDate).toBe(planA.planDate);
    expect(record.status).toBe('CONFIRMED');
    const plan = await database.mealPlan.findUniqueOrThrow({ where: { id: planAId } });
    expect(plan.status).toBe('COMPLETED');
    // planVersion 已随收口递增：旧 token 的 planVersion 绑定随之失效
    expect(plan.version).toBeGreaterThan(1);
  });

  it('D：无 planId 的 direct completion 保持正常（旧 token 形状更新后 direct 路径不受影响）', async () => {
    const stamp = `D-${Date.now()}`;
    const ingredient = await database.ingredient.create({
      data: {
        name: `Direct食材-${stamp}`,
        unit: 'GRAM',
        quantity: 400,
        inventoryBatches: { create: { quantity: 400, unit: 'GRAM' } }
      }
    });
    const recipeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/recipes',
      payload: {
        name: `Direct测试菜-${stamp}`,
        servings: 1,
        ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: 150, unit: 'GRAM' }]
      }
    });
    const recipeId = recipeRes.json().data.id as string;
    const directDate = nextPlanDate();
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/preview-from-recipe',
      payload: { recipeId, mealType: 'LUNCH', sourceType: 'HOMEMADE', recordDate: directDate }
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json().data;

    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/confirm-from-recipe',
      payload: {
        recipeId,
        mealType: 'LUNCH',
        sourceType: 'HOMEMADE',
        recordDate: directDate,
        previewToken: preview.previewToken,
        operationId: `closure-D-${stamp}`
      }
    });
    expect(confirmRes.statusCode).toBe(200);
    const record = await database.mealRecord.findUniqueOrThrow({
      where: { id: confirmRes.json().data.recordId }
    });
    expect(record.mealType).toBe('LUNCH');
    expect(record.recordDate).toBe(directDate);
    expect(record.relatedPlanId).toBeNull();
    expect(record.sourceMealPlanId).toBeNull();
    expect(record.status).toBe('CONFIRMED');
    expect(confirmRes.json().data.inventoryLogIds.length).toBeGreaterThan(0);
  });

  it('E：同 operationId 重放不重复扣减；Preview 后计划被修改（version 变化）→ Confirm 409', async () => {
    const { recipeId, planAId } = await seedPlanPair(`E-${Date.now()}`);
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/preview-from-recipe',
      payload: { recipeId, mealType: 'DINNER', sourceType: 'HOMEMADE', relatedPlanId: planAId }
    });
    const preview = previewRes.json().data;
    const operationId = `closure-E-${planAId}`;

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/confirm-from-recipe',
      payload: {
        recipeId,
        mealType: 'DINNER',
        sourceType: 'HOMEMADE',
        relatedPlanId: planAId,
        previewToken: preview.previewToken,
        operationId
      }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.repeated).toBe(false);

    // 幂等重放：同 operationId + 同 token → repeated=true，不重复扣减
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/confirm-from-recipe',
      payload: {
        recipeId,
        mealType: 'DINNER',
        sourceType: 'HOMEMADE',
        relatedPlanId: planAId,
        previewToken: preview.previewToken,
        operationId
      }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.repeated).toBe(true);
    const recordId = first.json().data.recordId as string;
    expect(
      await database.inventoryLog.count({ where: { relatedRecordId: recordId, changeType: 'COOK_DEDUCT' } })
    ).toBeGreaterThan(0);
    const logsBefore = await database.inventoryLog.count({ where: { relatedRecordId: recordId } });
    expect(logsBefore).toBe(first.json().data.inventoryLogIds.length);
    expect(await database.mealRecord.count({ where: { sourceMealPlanId: planAId } })).toBe(1);

    // Preview 之后计划版本发生变化（updatePlan 递增 version）→ 旧 token 失效
    const stamp2 = `E2-${Date.now()}`;
    const ingredient2 = await database.ingredient.create({
      data: {
        name: `E2食材-${stamp2}`,
        unit: 'GRAM',
        quantity: 300,
        inventoryBatches: { create: { quantity: 300, unit: 'GRAM' } }
      }
    });
    const recipe2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/recipes',
      payload: {
        name: `E2测试菜-${stamp2}`,
        servings: 1,
        ingredients: [{ ingredientId: ingredient2.id, name: ingredient2.name, quantity: 100, unit: 'GRAM' }]
      }
    });
    const recipe2 = recipe2Res.json().data.id as string;
    const plan2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      payload: {
        planDate: nextPlanDate(),
        mealType: 'DINNER',
        dinerCount: 1,
        items: [{ itemType: 'RECIPE', recipeId: recipe2, mealRole: 'MAIN', sortOrder: 0 }]
      }
    });
    const plan2 = plan2Res.json().data;
    const preview2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/preview-from-recipe',
      payload: { recipeId: recipe2, mealType: 'DINNER', sourceType: 'HOMEMADE', relatedPlanId: plan2.id }
    });
    const preview2 = preview2Res.json().data;

    // preview 之后修改计划（备注变化即递增 version）
    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/plans/${plan2.id}`,
      payload: { version: plan2.version, notes: 'preview 之后被修改' }
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().data.version).toBe(plan2.version + 1);

    const staleConfirm = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/confirm-from-recipe',
      payload: {
        recipeId: recipe2,
        mealType: 'DINNER',
        sourceType: 'HOMEMADE',
        relatedPlanId: plan2.id,
        previewToken: preview2.previewToken,
        operationId: `closure-E2-${plan2.id}`
      }
    });
    expect(staleConfirm.statusCode).toBe(409);
    const stillPlan = await database.mealPlan.findUniqueOrThrow({ where: { id: plan2.id } });
    expect(stillPlan.status).toBe('PLANNED');
    expect(await database.mealRecord.count({ where: { relatedPlanId: plan2.id } })).toBe(0);
  });
});
