import type { PrismaClient } from '@prisma/client';

function httpError(statusCode:number,message:string){return Object.assign(new Error(message),{statusCode})}

export async function listDeletedItems(database:PrismaClient){
  await database.deletedItem.deleteMany({where:{expiresAt:{lt:new Date()}}});
  const items=await database.deletedItem.findMany({orderBy:{deletedAt:'desc'}});
  return Promise.all(items.map(async item=>{
    let name=item.entityId;
    if(item.entityType==='Recipe')name=(await database.recipe.findUnique({where:{id:item.entityId},select:{name:true}}))?.name??name;
    if(item.entityType==='Ingredient')name=(await database.ingredient.findUnique({where:{id:item.entityId},select:{name:true}}))?.name??name;
    if(item.entityType==='KitchenTool')name=(await database.kitchenTool.findUnique({where:{id:item.entityId},select:{name:true}}))?.name??name;
    if(item.entityType==='Store')name=(await database.store.findUnique({where:{id:item.entityId},select:{name:true}}))?.name??name;
    if(item.entityType==='MealPlan'){const value=await database.mealPlan.findUnique({where:{id:item.entityId},select:{planDate:true,mealType:true}});if(value)name=`${value.planDate} ${value.mealType}`}
    if(item.entityType==='MealRecord'){const value=await database.mealRecord.findUnique({where:{id:item.entityId},select:{recordDate:true,mealType:true}});if(value)name=`${value.recordDate} ${value.mealType}`}
    if(item.entityType==='ShoppingList')name=(await database.shoppingList.findUnique({where:{id:item.entityId},select:{name:true}}))?.name??name;
    return{...item,name};
  }))
}

export async function restoreDeletedItem(database:PrismaClient,id:string){return database.$transaction(async tx=>{
  const item=await tx.deletedItem.findUnique({where:{id}});if(!item)throw httpError(404,'回收站项目不存在');
  if(item.expiresAt&&item.expiresAt<new Date()){await tx.deletedItem.delete({where:{id}});throw httpError(410,'该项目已超过 30 天恢复期')}
  const data={deletedAt:null,version:{increment:1} as const};
  if(item.entityType==='Recipe')await tx.recipe.update({where:{id:item.entityId},data});
  else if(item.entityType==='Ingredient'){await tx.ingredient.update({where:{id:item.entityId},data});await tx.inventoryBatch.updateMany({where:{ingredientId:item.entityId},data:{deletedAt:null,version:{increment:1}}})}
  else if(item.entityType==='KitchenTool')await tx.kitchenTool.update({where:{id:item.entityId},data});
  else if(item.entityType==='Store')await tx.store.update({where:{id:item.entityId},data});
  else if(item.entityType==='MealPlan')await tx.mealPlan.update({where:{id:item.entityId},data});
  else if(item.entityType==='MealRecord')await tx.mealRecord.update({where:{id:item.entityId},data});
  else if(item.entityType==='ShoppingList')await tx.shoppingList.update({where:{id:item.entityId},data});
  else throw httpError(422,'该项目类型暂不支持恢复');
  await tx.deletedItem.delete({where:{id}});return{id:item.entityId,entityType:item.entityType,restored:true};
})}
