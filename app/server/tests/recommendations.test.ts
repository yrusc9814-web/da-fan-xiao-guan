import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPrismaClient } from '../src/database/test-database.js';
import { addRecommendationToPlan, mealSetRecommendation, randomRecommendation } from '../src/modules/recommendations/service.js';

const database=createTestPrismaClient();
describe('真实推荐',()=>{
  beforeAll(async()=>database.$connect());afterAll(async()=>database.$disconnect());
  it('过敏与忌口是硬过滤且推荐历史可原子加入计划',async()=>{
    const diner=await database.diner.create({data:{name:'推荐过滤食用者',allergyText:'花生'}});
    const blocked=await database.recipe.create({data:{name:'高分花生菜',favorite:true,ingredients:{create:{ingredientNameSnapshot:'花生',quantity:10,unit:'GRAM'}}}});
    const safe=await database.recipe.create({data:{name:'安全清炒时蔬',ingredients:{create:{ingredientNameSnapshot:'青菜',quantity:100,unit:'GRAM',optional:true}}}});
    const result=await randomRecommendation(database,{dinerIds:[diner.id],sourceTypes:['RECIPE']});
    expect(result.results[0]?.resultId).toBe(safe.id);expect(result.results.some(x=>x.resultId===blocked.id)).toBe(false);
    const added=await addRecommendationToPlan(database,result.historyId,{planDate:'2046-05-19',mealType:'DINNER',dinerCount:1,dinerIds:[diner.id]});
    expect(added.plan.items[0]?.recipeId).toBe(safe.id);expect((await database.recommendationHistory.findUniqueOrThrow({where:{id:result.historyId}})).addedToPlan).toBe(true);
  });
  it('套餐只按显式菜品角色组装，不依赖候选列表位置',async()=>{
    const roles=['MAIN','SIDE','STAPLE','SOUP','DRINK'] as const;
    const created=await Promise.all(roles.map((mealRole,index)=>database.recipe.create({data:{name:`角色菜谱-${mealRole}-${index}`,mealRoles:{create:{mealRole}}}})));
    const result=await mealSetRecommendation(database,{sourceTypes:['RECIPE']});expect(result.results.map(item=>item.mealRole)).toEqual(expect.arrayContaining([...roles]));
    for(const item of result.results)expect(created.find(candidate=>candidate.id===item.resultId)).toBeTruthy();expect(new Set(result.results.map(item=>item.resultId)).size).toBe(result.results.length);
  });
});
