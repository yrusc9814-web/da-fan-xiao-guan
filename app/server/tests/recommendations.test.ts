import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPrismaClient } from '../src/database/test-database.js';
import { recommendFromInventory } from '../src/modules/inventory/service.js';
import {
  addRecommendationToPlan,
  mealSetRecommendation,
  randomRecommendation,
  selectWeightedCandidate,
  type Candidate
} from '../src/modules/recommendations/service.js';

const database = createTestPrismaClient();
describe('真实推荐', () => {
  beforeAll(async () => database.$connect());
  afterAll(async () => database.$disconnect());
  it('过敏与忌口是硬过滤且推荐历史可原子加入计划', async () => {
    const diner = await database.diner.create({ data: { name: '推荐过滤食用者', allergyText: '花生' } });
    const blocked = await database.recipe.create({
      data: {
        name: '高分花生菜',
        favorite: true,
        ingredients: { create: { ingredientNameSnapshot: '花生', quantity: 10, unit: 'GRAM' } }
      }
    });
    await database.recipe.create({
      data: {
        name: '安全清炒时蔬',
        favorite: true,
        ingredients: { create: { ingredientNameSnapshot: '青菜', quantity: 100, unit: 'GRAM', optional: true } }
      }
    });
    const result = await randomRecommendation(database, { dinerIds: [diner.id], sourceTypes: ['RECIPE'] }, () => 0);
    expect(result.results[0]).toBeTruthy();
    expect(result.results.some((x) => x.resultId === blocked.id)).toBe(false);
    const added = await addRecommendationToPlan(database, result.historyId, {
      planDate: '2046-05-19',
      mealType: 'DINNER',
      dinerCount: 1,
      dinerIds: [diner.id]
    });
    expect(added.plan.items[0]?.recipeId).toBe(result.results[0]!.resultId);
    expect(
      (await database.recommendationHistory.findUniqueOrThrow({ where: { id: result.historyId } })).addedToPlan
    ).toBe(true);
  });
  it('套餐只按显式菜品角色组装，不依赖候选列表位置', async () => {
    const roles = ['MAIN', 'SIDE', 'STAPLE', 'SOUP', 'DRINK'] as const;
    const created = await Promise.all(
      roles.map((mealRole, index) =>
        database.recipe.create({ data: { name: `角色菜谱-${mealRole}-${index}`, mealRoles: { create: { mealRole } } } })
      )
    );
    const result = await mealSetRecommendation(database, { sourceTypes: ['RECIPE'] });
    expect(result.results.map((item) => item.mealRole)).toEqual(expect.arrayContaining([...roles]));
    for (const item of result.results) expect(created.find((candidate) => candidate.id === item.resultId)).toBeTruthy();
    expect(new Set(result.results.map((item) => item.resultId)).size).toBe(result.results.length);
  });
  it('Top K 带权随机可注入随机源且不会永远返回第一名', () => {
    const candidates: Candidate[] = Array.from({ length: 5 }, (_, index) => ({
      resultType: 'RECIPE',
      resultId: `weighted-${index}`,
      title: `候选${index}`,
      reason: '测试',
      missingIngredients: [],
      score: 50 - index * 10
    }));
    expect(selectWeightedCandidate(candidates, () => 0)?.resultId).toBe('weighted-0');
    expect(selectWeightedCandidate(candidates, () => 0.999999)?.resultId).toBe('weighted-4');
    expect(selectWeightedCandidate([], () => 0)).toBeUndefined();
  });
  it('未传 repeatDays 时使用设置值，显式 0 可覆盖', async () => {
    await database.settings.upsert({
      where: { id: 1 },
      create: { id: 1, defaultRepeatDays: 23 },
      update: { defaultRepeatDays: 23 }
    });
    const fromSettings = await randomRecommendation(database, { sourceTypes: [] });
    const stored = await database.recommendationHistory.findUniqueOrThrow({ where: { id: fromSettings.historyId } });
    expect(JSON.parse(stored.filtersJson).repeatDays).toBe(23);
    const overridden = await randomRecommendation(database, { sourceTypes: [], repeatDays: 0 });
    const overrideStored = await database.recommendationHistory.findUniqueOrThrow({
      where: { id: overridden.historyId }
    });
    expect(JSON.parse(overrideStored.filtersJson).repeatDays).toBe(0);
  });
});

describe('验收过滤-食用者偏好硬过滤与库存推荐', () => {
  let zhangSanId = '';
  let liSiId = '';
  let peanutChickenId = '';
  let stirVegId = '';
  let corianderId = '';
  beforeAll(async () => {
    // 清理上次运行的残留，保证可重复执行。
    // 严格按外键从子到父的顺序删除（避免 Recipe 子表 Restrict 外键阻塞），
    // 且只清理本 describe 产生的「验收过滤-」前缀数据与本 describe 使用的固定计划日期，
    // 不影响其他用例的数据。
    await database.mealPlanDiner.deleteMany({ where: { mealPlan: { planDate: '2056-08-27' } } });
    await database.mealPlanItem.deleteMany({ where: { mealPlan: { planDate: '2056-08-27' } } });
    await database.mealPlan.deleteMany({ where: { planDate: '2056-08-27' } });
    const staleRecipeIds = (
      await database.recipe.findMany({
        where: { name: { startsWith: '验收过滤-' } },
        select: { id: true }
      })
    ).map((recipe) => recipe.id);
    if (staleRecipeIds.length) {
      await database.recipeIngredient.deleteMany({ where: { recipeId: { in: staleRecipeIds } } });
      await database.recipeStep.deleteMany({ where: { recipeId: { in: staleRecipeIds } } });
      await database.recipeTag.deleteMany({ where: { recipeId: { in: staleRecipeIds } } });
      await database.recipeMealType.deleteMany({ where: { recipeId: { in: staleRecipeIds } } });
      await database.recipeMealRole.deleteMany({ where: { recipeId: { in: staleRecipeIds } } });
      await database.recipeTool.deleteMany({ where: { recipeId: { in: staleRecipeIds } } });
    }
    await database.recipe.deleteMany({ where: { name: { startsWith: '验收过滤-' } } });
    await database.diner.deleteMany({ where: { name: { startsWith: '验收过滤-' } } });
    const zhangSan = await database.diner.create({ data: { name: '验收过滤-张三', allergyText: '花生' } });
    const liSi = await database.diner.create({ data: { name: '验收过滤-李四', tabooText: '香菜' } });
    zhangSanId = zhangSan.id;
    liSiId = liSi.id;
    const peanutChicken = await database.recipe.create({
      data: {
        name: '验收过滤-花生鸡丁',
        favorite: true,
        mealRoles: { create: { mealRole: 'MAIN' } },
        mealTypes: { create: { mealType: 'DINNER' } },
        ingredients: { create: { ingredientNameSnapshot: '花生', quantity: 10, unit: 'GRAM' } }
      }
    });
    const stirVeg = await database.recipe.create({
      data: {
        name: '验收过滤-清炒时蔬',
        favorite: true,
        mealRoles: { create: { mealRole: 'MAIN' } },
        mealTypes: { create: { mealType: 'DINNER' } },
        ingredients: {
          create: [
            { ingredientNameSnapshot: '青菜', quantity: 100, unit: 'GRAM', optional: true },
            { ingredientNameSnapshot: '胡萝卜', quantity: 50, unit: 'GRAM', optional: true },
            { ingredientNameSnapshot: '盐', quantity: 5, unit: 'GRAM', optional: true }
          ]
        }
      }
    });
    const coriander = await database.recipe.create({
      data: {
        name: '验收过滤-香菜拌菜',
        favorite: true,
        mealRoles: { create: { mealRole: 'MAIN' } },
        mealTypes: { create: { mealType: 'DINNER' } },
        ingredients: { create: { ingredientNameSnapshot: '香菜', quantity: 20, unit: 'GRAM' } }
      }
    });
    peanutChickenId = peanutChicken.id;
    stirVegId = stirVeg.id;
    corianderId = coriander.id;
  });
  it('Case A/C：过敏与忌口硬过滤命中菜谱，random 与 meal-set 均排除', async () => {
    // Case A：仅张三（过敏：花生）
    const randomA = await randomRecommendation(
      database,
      { dinerIds: [zhangSanId], sourceTypes: ['RECIPE'], mealType: 'DINNER' },
      () => 0
    );
    expect(randomA.results.some((x) => x.resultId === peanutChickenId)).toBe(false);
    expect(randomA.results.some((x) => x.resultId === stirVegId)).toBe(true);
    const mealSetA = await mealSetRecommendation(database, {
      dinerIds: [zhangSanId],
      sourceTypes: ['RECIPE'],
      mealType: 'DINNER'
    });
    expect(mealSetA.results.some((x) => x.resultId === peanutChickenId)).toBe(false);
    expect(mealSetA.results.some((x) => x.resultId === stirVegId)).toBe(true);
    // Case C：张三 + 李四（过敏花生 + 忌口香菜）
    const randomC = await randomRecommendation(
      database,
      { dinerIds: [zhangSanId, liSiId], sourceTypes: ['RECIPE'], mealType: 'DINNER' },
      () => 0
    );
    expect(randomC.results.some((x) => x.resultId === peanutChickenId)).toBe(false);
    expect(randomC.results.some((x) => x.resultId === corianderId)).toBe(false);
    expect(randomC.results.some((x) => x.resultId === stirVegId)).toBe(true);
    const mealSetC = await mealSetRecommendation(database, {
      dinerIds: [zhangSanId, liSiId],
      sourceTypes: ['RECIPE'],
      mealType: 'DINNER'
    });
    expect(mealSetC.results.some((x) => x.resultId === peanutChickenId)).toBe(false);
    expect(mealSetC.results.some((x) => x.resultId === corianderId)).toBe(false);
    expect(mealSetC.results.some((x) => x.resultId === stirVegId)).toBe(true);
  });
  it('Case D：加入计划时按食用者写 MealPlanDiner', async () => {
    const result = await randomRecommendation(
      database,
      { dinerIds: [zhangSanId, liSiId], sourceTypes: ['RECIPE'], mealType: 'DINNER' },
      () => 0
    );
    const added = await addRecommendationToPlan(database, result.historyId, {
      planDate: '2056-08-27',
      mealType: 'DINNER',
      dinerCount: 2,
      dinerIds: [zhangSanId, liSiId]
    });
    expect(added.plan.diners.map((x) => x.dinerId).sort()).toEqual([zhangSanId, liSiId].sort());
    const links = await database.mealPlanDiner.findMany({ where: { mealPlanId: added.plan.id } });
    expect(links.map((x) => x.dinerId).sort()).toEqual([zhangSanId, liSiId].sort());
  });
  it('Case B/库存：不传食用者不启用过滤，传入则硬过滤命中菜谱', async () => {
    const blocked = await recommendFromInventory(database, {
      mode: 'ALLOW_PURCHASE',
      dinerIds: [zhangSanId],
      limit: 50
    });
    expect(blocked.items.some((x) => x.recipe.id === peanutChickenId)).toBe(false);
    const unfiltered = await recommendFromInventory(database, { mode: 'ALLOW_PURCHASE', limit: 50 });
    expect(unfiltered.items.some((x) => x.recipe.id === peanutChickenId)).toBe(true);
  });
});
