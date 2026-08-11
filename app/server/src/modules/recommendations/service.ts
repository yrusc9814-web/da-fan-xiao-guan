import type { MealRole, MealType, PrismaClient, QuantityUnit } from '@prisma/client';
import { convertQuantity } from '../../database/units.js';

export interface RecommendationInput {
  mealType?: MealType;
  dinerIds?: string[];
  sourceTypes?: Array<'RECIPE'|'STORE'>;
  inventoryOnly?: boolean;
  allowPurchase?: boolean;
  favoriteOnly?: boolean;
  repeatDays?: number;
  acquisitionModes?: Array<'DINE_IN'|'TAKEOUT'>;
}
interface Candidate { resultType:'RECIPE'|'STORE'; resultId:string; title:string; reason:string; missingIngredients:string[]; score:number; mealRole?:string; mealRoles?:string[] }
const tokens=(value:string|null|undefined)=>value?.split(/[、,，;；\s]+/).map(x=>x.trim().toLocaleLowerCase()).filter(Boolean)??[];
const dateDaysAgo=(days:number)=>{const d=new Date();d.setDate(d.getDate()-days);return d.toLocaleDateString('sv-SE')};
function forbidden(haystack:string, words:string[]){const lower=haystack.toLocaleLowerCase();return words.some(word=>lower.includes(word))}

async function recipeCandidates(database:PrismaClient,input:RecommendationInput,forbiddenWords:string[],recentIds:Set<string>):Promise<Candidate[]>{
  const recipes=await database.recipe.findMany({where:{deletedAt:null,enabledForRecommendation:true,...(input.favoriteOnly?{favorite:true}:{}),...(input.mealType?{mealTypes:{some:{mealType:input.mealType}}}:{})},include:{ingredients:true,mealTypes:true,mealRoles:true,tools:{include:{tool:true}}}});
  const batches=await database.inventoryBatch.findMany({where:{deletedAt:null,quantity:{gt:0},OR:[{expiryDate:null},{expiryDate:{gte:new Date().toLocaleDateString('sv-SE')}}]}});
  const byIngredient=new Map<string,typeof batches>();for(const batch of batches){const list=byIngredient.get(batch.ingredientId)??[];list.push(batch);byIngredient.set(batch.ingredientId,list)}
  return recipes.flatMap(recipe=>{
    const haystack=[recipe.name,recipe.ingredientsText,recipe.notes,...recipe.ingredients.map(x=>x.ingredientNameSnapshot)].filter(Boolean).join(' ');
    if(forbidden(haystack,forbiddenWords)||recipe.tools.some(link=>link.required&&(!link.tool||link.tool.deletedAt||link.tool.quantity<=0)))return [];
    const missing:string[]=[];
    for(const item of recipe.ingredients.filter(x=>!x.optional&&x.quantity!=null&&x.unit!=null)){
      if(!item.ingredientId){missing.push(item.ingredientNameSnapshot);continue}
      const available=(byIngredient.get(item.ingredientId)??[]).reduce((sum,b)=>sum+(convertQuantity(b.quantity,b.unit,item.unit as QuantityUnit)??0),0);
      if(available<(item.quantity??0))missing.push(item.ingredientNameSnapshot)
    }
    if(input.inventoryOnly&&missing.length)return [];
    const score=(recipe.favorite?30:0)+(missing.length?0:25)+(recentIds.has(recipe.id)?-40:0)+(recipe.ingredients.length?5:0);
    return [{resultType:'RECIPE' as const,resultId:recipe.id,title:recipe.name,reason:missing.length?`还缺 ${missing.length} 种食材`:'现有库存可以完成',missingIngredients:missing,score,mealRoles:recipe.mealRoles.map(role=>role.mealRole)}];
  });
}
async function storeCandidates(database:PrismaClient,input:RecommendationInput,forbiddenWords:string[],recentIds:Set<string>):Promise<Candidate[]>{
  const stores=await database.store.findMany({where:{deletedAt:null,...(input.favoriteOnly?{favorite:true}:{}),...(input.mealType?{mealTypes:{some:{mealType:input.mealType}}}:{}),...(input.acquisitionModes?.length?{OR:[...(input.acquisitionModes.includes('DINE_IN')?[{supportsDineIn:true}]:[]),...(input.acquisitionModes.includes('TAKEOUT')?[{supportsTakeout:true}]:[])]}:{})}});
  return stores.flatMap(store=>{const haystack=[store.name,store.cuisine,store.recommendedDishes,store.avoidDishes,store.tagsText,store.notes].filter(Boolean).join(' ');if(forbidden(haystack,forbiddenWords))return[];return[{resultType:'STORE' as const,resultId:store.id,title:store.name,reason:store.rating?`评分 ${store.rating}`:'符合本次用餐条件',missingIngredients:[],score:(store.favorite?30:0)+(store.rating??0)*4+(recentIds.has(store.id)?-40:0)}]});
}
async function candidates(database:PrismaClient,input:RecommendationInput){
  const diners=input.dinerIds?.length?await database.diner.findMany({where:{id:{in:input.dinerIds},active:true}}):[];
  const forbiddenWords=diners.flatMap(d=>[...tokens(d.allergyText),...tokens(d.tabooText),...tokens(d.dislikesText)]);
  const since=dateDaysAgo(input.repeatDays??0);const recent=await database.mealRecordItem.findMany({where:{mealRecord:{deletedAt:null,status:'CONFIRMED',recordDate:{gte:since}}},select:{recipeId:true,storeId:true}});
  const recentRecipeIds=new Set(recent.flatMap(x=>x.recipeId?[x.recipeId]:[])),recentStoreIds=new Set(recent.flatMap(x=>x.storeId?[x.storeId]:[]));
  const sources=input.sourceTypes??['RECIPE','STORE'];
  const [recipes,stores]=await Promise.all([sources.includes('RECIPE')?recipeCandidates(database,input,forbiddenWords,recentRecipeIds):[],sources.includes('STORE')?storeCandidates(database,input,forbiddenWords,recentStoreIds):[]]);
  return [...recipes,...stores].sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title));
}
async function save(database:PrismaClient,type:string,input:RecommendationInput,results:Candidate[],candidateCount:number){const history=await database.recommendationHistory.create({data:{recommendationType:type,resultType:results.length>1?'MEAL_SET':results[0]?.resultType??'EMPTY',resultJson:JSON.stringify(results),filtersJson:JSON.stringify(input),candidateCount}});return{historyId:history.id,type,results}}
export async function randomRecommendation(database:PrismaClient,input:RecommendationInput){const all=await candidates(database,input);return save(database,'SINGLE',input,all.slice(0,1),all.length)}
export async function mealSetRecommendation(database:PrismaClient,input:RecommendationInput){const all=await candidates(database,{...input,sourceTypes:['RECIPE']});const selected:Candidate[]=[];for(const mealRole of ['MAIN','SIDE','STAPLE','SOUP','DRINK']){const candidate=all.find(item=>item.mealRoles?.includes(mealRole)&&!selected.some(chosen=>chosen.resultId===item.resultId));if(candidate)selected.push({...candidate,mealRole})}return save(database,'MEAL_SET',input,selected,all.length)}
export async function listRecommendationHistory(database:PrismaClient){return database.recommendationHistory.findMany({orderBy:{createdAt:'desc'},take:50})}
export async function markRecommendation(database:PrismaClient,id:string,field:'accepted'|'addedToPlan'){const found=await database.recommendationHistory.findUnique({where:{id}});if(!found)throw Object.assign(new Error('推荐记录不存在'),{statusCode:404});return database.recommendationHistory.update({where:{id},data:{[field]:true}})}
export async function addRecommendationToPlan(database:PrismaClient,id:string,input:{planDate:string;mealType:MealType;dinerCount:number;dinerIds?:string[]}){if(!/^\d{4}-\d{2}-\d{2}$/.test(input.planDate)||!Number.isInteger(input.dinerCount)||input.dinerCount<1)throw Object.assign(new Error('计划日期或人数无效'),{statusCode:400});return database.$transaction(async tx=>{const history=await tx.recommendationHistory.findUnique({where:{id}});if(!history)throw Object.assign(new Error('推荐记录不存在'),{statusCode:404});const results=JSON.parse(history.resultJson) as Candidate[];if(!results.length)throw Object.assign(new Error('推荐结果为空，不能加入计划'),{statusCode:409});const existing=await tx.mealPlan.findUnique({where:{planDate_mealType:{planDate:input.planDate,mealType:input.mealType}}});if(existing&&!existing.deletedAt)throw Object.assign(new Error('该日期和餐次已存在计划'),{statusCode:409});const itemData=results.map((result,index)=>({itemType:result.resultType==='STORE'?'STORE' as const:'RECIPE' as const,recipeId:result.resultType==='STORE'?null:result.resultId,storeId:result.resultType==='STORE'?result.resultId:null,mealRole:(result.mealRole??(index===0?'MAIN':'SIDE')) as MealRole,sortOrder:index}));let plan;if(existing){await tx.deletedItem.deleteMany({where:{entityType:'MealPlan',entityId:existing.id}});await tx.mealPlanItem.deleteMany({where:{mealPlanId:existing.id}});await tx.mealPlanDiner.deleteMany({where:{mealPlanId:existing.id}});plan=await tx.mealPlan.update({where:{id:existing.id},data:{dinerCount:input.dinerCount,status:'PLANNED',deletedAt:null,completedAt:null,version:{increment:1},items:{create:itemData},diners:{create:[...new Set(input.dinerIds??[])].map(dinerId=>({dinerId}))}},include:{items:true,diners:true}})}else{plan=await tx.mealPlan.create({data:{planDate:input.planDate,mealType:input.mealType,dinerCount:input.dinerCount,items:{create:itemData},diners:{create:[...new Set(input.dinerIds??[])].map(dinerId=>({dinerId}))}},include:{items:true,diners:true}})}await tx.recommendationHistory.update({where:{id},data:{addedToPlan:true}});return{plan,historyId:id}})}
