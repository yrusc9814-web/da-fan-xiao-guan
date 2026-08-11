import type { PrismaClient } from '@prisma/client';

function businessDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

const recipeSeeds = [
  { id: 'dev-recipe-tomato-eggs', name: '番茄炒蛋', imagePath: 'tomato-eggs.png', cookingTimeMinutes: 15, tags: ['家常菜', '快手菜'] },
  { id: 'dev-recipe-steamed-fish', name: '清蒸鲈鱼', imagePath: 'steamed-fish.png', cookingTimeMinutes: 25, tags: ['低脂', '高蛋白'] },
  { id: 'dev-recipe-broccoli', name: '蒜蓉西兰花', imagePath: 'broccoli.png', cookingTimeMinutes: 10, tags: ['素食', '减脂'] },
  { id: 'dev-recipe-braised-ribs', name: '红烧排骨', imagePath: 'braised-ribs.png', cookingTimeMinutes: 40, tags: ['下饭菜', '家常菜'] },
  { id: 'dev-recipe-tofu', name: '麻婆豆腐', imagePath: 'tofu.png', cookingTimeMinutes: 20, tags: ['川菜', '下饭菜'] },
  { id: 'dev-recipe-shrimp', name: '虾仁炒时蔬', imagePath: 'shrimp.png', cookingTimeMinutes: 15, tags: ['低脂', '高蛋白'] }
] as const;

export async function seedDevelopmentData(database: PrismaClient): Promise<void> {
  await database.settings.upsert({
    where: { id: 1 },
    update: { appName: '搭饭小馆', subtitle: '让每一餐都更美好' },
    create: { id: 1, appName: '搭饭小馆', subtitle: '让每一餐都更美好', userNickname: '厨房伙伴' }
  });

  for (const recipe of recipeSeeds) {
    await database.recipe.upsert({
      where: { id: recipe.id },
      update: {
        name: recipe.name,
        imagePath: recipe.imagePath,
        cookingTimeMinutes: recipe.cookingTimeMinutes,
        enabledForRecommendation: true,
        deletedAt: null
      },
      create: {
        id: recipe.id,
        name: recipe.name,
        imagePath: recipe.imagePath,
        cookingTimeMinutes: recipe.cookingTimeMinutes
      }
    });

    for (const tagName of recipe.tags) {
      const tagId = `dev-tag-${tagName}`;
      const tag = await database.tag.upsert({
        where: { name_type: { name: tagName, type: 'GENERAL' } },
        update: { deletedAt: null },
        create: { id: tagId, name: tagName, type: 'GENERAL' }
      });

      await database.recipeTag.upsert({
        where: { recipeId_tagId: { recipeId: recipe.id, tagId: tag.id } },
        update: {},
        create: { id: `dev-recipe-tag-${recipe.id}-${tag.id}`, recipeId: recipe.id, tagId: tag.id }
      });
    }
  }

  const today = new Date();
  const expiryDates = [addDays(today, 2), addDays(today, 3), addDays(today, 3), addDays(today, 3), addDays(today, 3)];
  const ingredientSeeds = [
    { id: 'dev-ingredient-broccoli', name: '生菜', quantity: 1, minStock: 2, expiryDate: businessDate(expiryDates[0]) },
    { id: 'dev-ingredient-eggs', name: '鸡蛋', quantity: 2, minStock: 6, expiryDate: businessDate(expiryDates[1]) },
    { id: 'dev-ingredient-milk', name: '牛奶', quantity: 1, minStock: 2, expiryDate: businessDate(expiryDates[2]) },
    { id: 'dev-ingredient-tomato', name: '番茄', quantity: 1, minStock: 3, expiryDate: businessDate(expiryDates[3]) },
    { id: 'dev-ingredient-tofu', name: '豆腐', quantity: 1, minStock: 2, expiryDate: businessDate(expiryDates[4]) },
    { id: 'dev-ingredient-rice', name: '大米', quantity: 1, minStock: 2, expiryDate: businessDate(addDays(today, 5)) },
    { id: 'dev-ingredient-carrot', name: '胡萝卜', quantity: 1, minStock: 2, expiryDate: businessDate(addDays(today, 6)) },
    { id: 'dev-ingredient-mushroom', name: '香菇', quantity: 1, minStock: 2, expiryDate: businessDate(addDays(today, 7)) },
    { id: 'dev-ingredient-cucumber', name: '黄瓜', quantity: 2, minStock: 2, expiryDate: businessDate(addDays(today, 8)) },
    { id: 'dev-ingredient-corn', name: '玉米', quantity: 2, minStock: 2, expiryDate: businessDate(addDays(today, 9)) },
    { id: 'dev-ingredient-pork', name: '排骨', quantity: 2, minStock: 2, expiryDate: businessDate(addDays(today, 10)) },
    { id: 'dev-ingredient-shrimp', name: '虾仁', quantity: 3, minStock: 3, expiryDate: businessDate(addDays(today, 11)) }
  ] as const;

  for (const ingredient of ingredientSeeds) {
    await database.ingredient.upsert({
      where: { id: ingredient.id },
      update: {
        name: ingredient.name,
        quantity: ingredient.quantity,
        minStock: ingredient.minStock,
        expiryDate: ingredient.expiryDate,
        unit: 'PIECE',
        deletedAt: null
      },
      create: {
        id: ingredient.id,
        name: ingredient.name,
        quantity: ingredient.quantity,
        minStock: ingredient.minStock,
        expiryDate: ingredient.expiryDate,
        unit: 'PIECE'
      }
    });
  }

  const recordSeeds = [
    { id: 'dev-record-breakfast', dayOffset: 0, mealType: 'BREAKFAST' as const, recordTime: '08:00', recipeId: 'dev-recipe-tomato-eggs', title: '燕麦粥、水煮蛋、苹果', rating: 4.6 },
    { id: 'dev-record-lunch', dayOffset: 0, mealType: 'LUNCH' as const, recordTime: '12:30', recipeId: 'dev-recipe-braised-ribs', title: '红烧排骨、米饭、清炒时蔬', rating: 4.8 },
    { id: 'dev-record-yesterday-breakfast', dayOffset: 1, mealType: 'BREAKFAST' as const, recordTime: '08:10', recipeId: 'dev-recipe-tomato-eggs', title: '番茄炒蛋', rating: 4.6 },
    { id: 'dev-record-yesterday-lunch', dayOffset: 1, mealType: 'LUNCH' as const, recordTime: '12:20', recipeId: 'dev-recipe-broccoli', title: '蒜蓉西兰花', rating: 4.5 },
    { id: 'dev-record-yesterday-dinner', dayOffset: 1, mealType: 'DINNER' as const, recordTime: '18:40', recipeId: 'dev-recipe-tofu', title: '麻婆豆腐', rating: 4.6 },
    { id: 'dev-record-two-days-breakfast', dayOffset: 2, mealType: 'BREAKFAST' as const, recordTime: '08:00', recipeId: 'dev-recipe-steamed-fish', title: '清蒸鲈鱼', rating: 4.6 },
    { id: 'dev-record-two-days-dinner', dayOffset: 2, mealType: 'DINNER' as const, recordTime: '18:30', recipeId: 'dev-recipe-shrimp', title: '虾仁炒时蔬', rating: 4.6 },
    { id: 'dev-record-three-days-lunch', dayOffset: 3, mealType: 'LUNCH' as const, recordTime: '12:00', recipeId: 'dev-recipe-braised-ribs', title: '红烧排骨', rating: 4.8 },
    { id: 'dev-record-three-days-dinner', dayOffset: 3, mealType: 'DINNER' as const, recordTime: '19:00', recipeId: 'dev-recipe-tofu', title: '麻婆豆腐', rating: 4.6 },
    { id: 'dev-record-four-days-breakfast', dayOffset: 4, mealType: 'BREAKFAST' as const, recordTime: '08:20', recipeId: 'dev-recipe-tomato-eggs', title: '番茄炒蛋', rating: 4.6 },
    { id: 'dev-record-four-days-lunch', dayOffset: 4, mealType: 'LUNCH' as const, recordTime: '12:40', recipeId: 'dev-recipe-broccoli', title: '蒜蓉西兰花', rating: 4.5 },
    { id: 'dev-record-four-days-dinner', dayOffset: 4, mealType: 'DINNER' as const, recordTime: '18:50', recipeId: 'dev-recipe-steamed-fish', title: '清蒸鲈鱼', rating: 4.6 }
  ];

  for (const record of recordSeeds) {
    await database.mealRecord.upsert({
      where: { id: record.id },
      update: {
        recordDate: businessDate(addDays(today, record.dayOffset)),
        recordTime: record.recordTime,
        mealType: record.mealType,
        sourceType: 'HOMEMADE',
        rating: record.rating,
        deletedAt: null
      },
      create: {
        id: record.id,
        recordDate: businessDate(addDays(today, record.dayOffset)),
        recordTime: record.recordTime,
        mealType: record.mealType,
        sourceType: 'HOMEMADE',
        rating: record.rating,
        items: {
          create: {
            id: `${record.id}-item`,
            itemType: 'RECIPE',
            recipeId: record.recipeId,
            customName: record.title,
            sortOrder: 0
          }
        }
      }
    });

    await database.mealRecordItem.updateMany({
      where: { mealRecordId: record.id },
      data: { customName: record.title }
    });
  }
}
