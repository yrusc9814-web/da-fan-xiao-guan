import type { PrismaClient } from '@prisma/client';

import { normalizeIngredientCategory } from '../modules/ingredients/categories.js';

function businessDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

const recipeSeeds = [
  {
    id: 'dev-recipe-tomato-eggs',
    name: '番茄炒蛋',
    category: '快手家常',
    imagePath: 'tomato-eggs.png',
    cookingTimeMinutes: 15,
    tags: ['家常菜', '快手菜']
  },
  {
    id: 'dev-recipe-steamed-fish',
    name: '清蒸鲈鱼',
    category: '鲜美水产',
    imagePath: 'steamed-fish.png',
    cookingTimeMinutes: 25,
    tags: ['低脂', '高蛋白']
  },
  {
    id: 'dev-recipe-broccoli',
    name: '蒜蓉西兰花',
    category: '清爽时蔬',
    imagePath: 'broccoli.png',
    cookingTimeMinutes: 10,
    tags: ['素食', '减脂']
  },
  {
    id: 'dev-recipe-braised-ribs',
    name: '红烧排骨',
    category: '肉禽鲜香',
    imagePath: 'braised-ribs.png',
    cookingTimeMinutes: 40,
    tags: ['下饭菜', '家常菜']
  },
  {
    id: 'dev-recipe-tofu',
    name: '麻婆豆腐',
    category: '快手家常',
    imagePath: 'tofu.png',
    cookingTimeMinutes: 20,
    tags: ['川菜', '下饭菜']
  },
  {
    id: 'dev-recipe-shrimp',
    name: '虾仁炒时蔬',
    category: '清爽时蔬',
    imagePath: 'shrimp.png',
    cookingTimeMinutes: 15,
    tags: ['低脂', '高蛋白']
  }
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
        category: recipe.category,
        imagePath: recipe.imagePath,
        cookingTimeMinutes: recipe.cookingTimeMinutes,
        enabledForRecommendation: true,
        deletedAt: null
      },
      create: {
        id: recipe.id,
        name: recipe.name,
        category: recipe.category,
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
  /**
   * 12 种种子食材：统一 7 大分类、合理单位、存放位置与真实采购日，并各建一条活批次，
   * 使「全部 (N) = 各分类计数之和」、图标按名称差异化、库存扣减与推荐都能直接跑通。
   */
  const ingredientSeeds = [
    {
      id: 'dev-ingredient-broccoli',
      name: '生菜',
      category: '蔬菜',
      unit: 'PIECE',
      quantity: 1,
      minStock: 2,
      location: '冷藏室',
      shelfLifeDays: 2
    },
    {
      id: 'dev-ingredient-eggs',
      name: '鸡蛋',
      category: '蛋奶豆制',
      unit: 'PIECE',
      quantity: 2,
      minStock: 6,
      location: '冷藏室',
      shelfLifeDays: 3
    },
    {
      id: 'dev-ingredient-milk',
      name: '牛奶',
      category: '蛋奶豆制',
      unit: 'MILLILITER',
      quantity: 1000,
      minStock: 500,
      location: '冷藏室',
      shelfLifeDays: 3
    },
    {
      id: 'dev-ingredient-tomato',
      name: '番茄',
      category: '蔬菜',
      unit: 'GRAM',
      quantity: 500,
      minStock: 300,
      location: '冷藏室',
      shelfLifeDays: 3
    },
    {
      id: 'dev-ingredient-tofu',
      name: '豆腐',
      category: '蛋奶豆制',
      unit: 'GRAM',
      quantity: 400,
      minStock: 200,
      location: '冷藏室',
      shelfLifeDays: 3
    },
    {
      id: 'dev-ingredient-rice',
      name: '大米',
      category: '主食粮油',
      unit: 'GRAM',
      quantity: 2000,
      minStock: 500,
      location: '储物柜',
      shelfLifeDays: 180
    },
    {
      id: 'dev-ingredient-carrot',
      name: '胡萝卜',
      category: '蔬菜',
      unit: 'GRAM',
      quantity: 500,
      minStock: 200,
      location: '冷藏室',
      shelfLifeDays: 14
    },
    {
      id: 'dev-ingredient-mushroom',
      name: '香菇',
      category: '蔬菜',
      unit: 'GRAM',
      quantity: 300,
      minStock: 100,
      location: '冷藏室',
      shelfLifeDays: 7
    },
    {
      id: 'dev-ingredient-cucumber',
      name: '黄瓜',
      category: '蔬菜',
      unit: 'PIECE',
      quantity: 2,
      minStock: 2,
      location: '冷藏室',
      shelfLifeDays: 5
    },
    {
      id: 'dev-ingredient-corn',
      name: '玉米',
      category: '主食粮油',
      unit: 'PIECE',
      quantity: 2,
      minStock: 2,
      location: '冷藏室',
      shelfLifeDays: 6
    },
    {
      id: 'dev-ingredient-pork',
      name: '排骨',
      category: '肉禽',
      unit: 'GRAM',
      quantity: 500,
      minStock: 300,
      location: '冷冻室',
      shelfLifeDays: 30
    },
    {
      id: 'dev-ingredient-shrimp',
      name: '虾仁',
      category: '水产',
      unit: 'GRAM',
      quantity: 300,
      minStock: 200,
      location: '冷冻室',
      shelfLifeDays: 20
    }
  ] as const;

  for (const ingredient of ingredientSeeds) {
    const purchaseDate = businessDate(today);
    const expiryDate = businessDate(addDays(today, ingredient.shelfLifeDays));
    let current = await database.ingredient.upsert({
      where: { id: ingredient.id },
      // 已有演示食材可能被用户编辑、消耗或删除，重复 seed 保留其全部事实。
      update: {},
      create: {
        id: ingredient.id,
        name: ingredient.name,
        category: ingredient.category,
        quantity: ingredient.quantity,
        minStock: ingredient.minStock,
        purchaseDate,
        expiryDate,
        location: ingredient.location,
        unit: ingredient.unit
      }
    });
    // 老版本种子只补空元数据，不能改变数量、单位、日期或用户已有位置。
    if (current.deletedAt === null && (!current.category?.trim() || !current.location?.trim())) {
      current = await database.ingredient.update({
        where: { id: current.id },
        data: {
          ...(!current.category?.trim() ? { category: normalizeIngredientCategory(null, current.name) } : {}),
          ...(!current.location?.trim() ? { location: ingredient.location } : {})
        }
      });
    }
    // 仅为仍有存量且无活批次的食材补建；不覆盖或复活任何已有批次。
    if (current.deletedAt === null && current.quantity > 0) {
      const active = await database.inventoryBatch.findFirst({
        where: { ingredientId: current.id, deletedAt: null, quantity: { gt: 0 } },
        select: { id: true }
      });
      if (!active) {
        await database.inventoryBatch.create({
          data: {
            ingredientId: current.id,
            quantity: current.quantity,
            unit: current.unit,
            purchaseDate: current.purchaseDate,
            expiryDate: current.expiryDate,
            location: current.location,
            opened: current.opened
          }
        });
      }
    }
  }

  const recordSeeds = [
    {
      id: 'dev-record-breakfast',
      dayOffset: 0,
      mealType: 'BREAKFAST' as const,
      recordTime: '08:00',
      recipeId: 'dev-recipe-tomato-eggs',
      title: '燕麦粥、水煮蛋、苹果',
      rating: 4.6
    },
    {
      id: 'dev-record-lunch',
      dayOffset: 0,
      mealType: 'LUNCH' as const,
      recordTime: '12:30',
      recipeId: 'dev-recipe-braised-ribs',
      title: '红烧排骨、米饭、清炒时蔬',
      rating: 4.8
    },
    {
      id: 'dev-record-yesterday-breakfast',
      dayOffset: 1,
      mealType: 'BREAKFAST' as const,
      recordTime: '08:10',
      recipeId: 'dev-recipe-tomato-eggs',
      title: '番茄炒蛋',
      rating: 4.6
    },
    {
      id: 'dev-record-yesterday-lunch',
      dayOffset: 1,
      mealType: 'LUNCH' as const,
      recordTime: '12:20',
      recipeId: 'dev-recipe-broccoli',
      title: '蒜蓉西兰花',
      rating: 4.5
    },
    {
      id: 'dev-record-yesterday-dinner',
      dayOffset: 1,
      mealType: 'DINNER' as const,
      recordTime: '18:40',
      recipeId: 'dev-recipe-tofu',
      title: '麻婆豆腐',
      rating: 4.6
    },
    {
      id: 'dev-record-two-days-breakfast',
      dayOffset: 2,
      mealType: 'BREAKFAST' as const,
      recordTime: '08:00',
      recipeId: 'dev-recipe-steamed-fish',
      title: '清蒸鲈鱼',
      rating: 4.6
    },
    {
      id: 'dev-record-two-days-dinner',
      dayOffset: 2,
      mealType: 'DINNER' as const,
      recordTime: '18:30',
      recipeId: 'dev-recipe-shrimp',
      title: '虾仁炒时蔬',
      rating: 4.6
    },
    {
      id: 'dev-record-three-days-lunch',
      dayOffset: 3,
      mealType: 'LUNCH' as const,
      recordTime: '12:00',
      recipeId: 'dev-recipe-braised-ribs',
      title: '红烧排骨',
      rating: 4.8
    },
    {
      id: 'dev-record-three-days-dinner',
      dayOffset: 3,
      mealType: 'DINNER' as const,
      recordTime: '19:00',
      recipeId: 'dev-recipe-tofu',
      title: '麻婆豆腐',
      rating: 4.6
    },
    {
      id: 'dev-record-four-days-breakfast',
      dayOffset: 4,
      mealType: 'BREAKFAST' as const,
      recordTime: '08:20',
      recipeId: 'dev-recipe-tomato-eggs',
      title: '番茄炒蛋',
      rating: 4.6
    },
    {
      id: 'dev-record-four-days-lunch',
      dayOffset: 4,
      mealType: 'LUNCH' as const,
      recordTime: '12:40',
      recipeId: 'dev-recipe-broccoli',
      title: '蒜蓉西兰花',
      rating: 4.5
    },
    {
      id: 'dev-record-four-days-dinner',
      dayOffset: 4,
      mealType: 'DINNER' as const,
      recordTime: '18:50',
      recipeId: 'dev-recipe-steamed-fish',
      title: '清蒸鲈鱼',
      rating: 4.6
    }
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
