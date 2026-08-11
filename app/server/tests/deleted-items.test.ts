import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPrismaClient } from '../src/database/test-database.js';
import { deleteIngredient } from '../src/modules/ingredients/service.js';
import { deleteRecipe } from '../src/modules/recipes/service.js';
import { listDeletedItems, restoreDeletedItem } from '../src/modules/deleted-items/service.js';

const database=createTestPrismaClient();
describe('30 天最近删除恢复',()=>{beforeAll(async()=>database.$connect());afterAll(async()=>database.$disconnect());it('菜谱与食材删除后进入回收站，食材恢复时批次一并恢复',async()=>{
  const recipe=await database.recipe.create({data:{name:'回收站菜谱'}});const ingredient=await database.ingredient.create({data:{name:'回收站食材',unit:'GRAM',inventoryBatches:{create:{quantity:100,unit:'GRAM'}}},include:{inventoryBatches:true}});
  await deleteRecipe(database,recipe.id,recipe.version);await deleteIngredient(database,ingredient.id,ingredient.version);
  const deleted=await listDeletedItems(database);const recipeTrash=deleted.find(item=>item.entityType==='Recipe'&&item.entityId===recipe.id);const ingredientTrash=deleted.find(item=>item.entityType==='Ingredient'&&item.entityId===ingredient.id);expect(recipeTrash?.name).toBe('回收站菜谱');expect(ingredientTrash).toBeTruthy();
  await restoreDeletedItem(database,recipeTrash!.id);await restoreDeletedItem(database,ingredientTrash!.id);
  expect((await database.recipe.findUniqueOrThrow({where:{id:recipe.id}})).deletedAt).toBeNull();expect((await database.inventoryBatch.findUniqueOrThrow({where:{id:ingredient.inventoryBatches[0]!.id}})).deletedAt).toBeNull();expect(await database.deletedItem.count({where:{entityId:{in:[recipe.id,ingredient.id]}}})).toBe(0);
})});
