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
    // 明确餐次推荐（RecommendationsPage eatThis 携带 mealType=BREAKFAST）
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/preview-from-recipe',
      payload: {
        recipeId,
        mealType: 'BREAKFAST',
        sourceType: 'HOMEMADE',
        recordDate: '2046-08-20'
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
        recordDate: '2046-08-20',
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
    expect(record!.recordDate).toBe('2046-08-20');
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

    // 加入计划（PLANNED，晚餐）
    const planRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      payload: {
        planDate: '2046-08-20',
        mealType: 'DINNER',
        dinerCount: 2,
        items: [{ itemType: 'RECIPE', recipeId, mealRole: 'MAIN', sortOrder: 0 }]
      }
    });
    expect(planRes.statusCode).toBe(201);
    const plan = planRes.json().data;

    // 从计划进入「完成这一餐」：preview 携带 relatedPlanId
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
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json().data;
    expect(preview.dinerCount).toBe(2); // 人数按计划（2 人）而非默认 1 人

    // 确认：计划收口 + 生成 CONFIRMED 记录
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consumption/confirm-from-recipe',
      payload: {
        recipeId,
        mealType: 'DINNER', // 故意与请求一致；服务端应取计划值
        sourceType: 'HOMEMADE',
        recordDate: '2099-01-01',
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
    expect(record.recordDate).toBe('2046-08-20');

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
        planDate: '2046-08-21',
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
        planDate: '2046-08-22',
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
});
