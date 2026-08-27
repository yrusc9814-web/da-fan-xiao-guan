import type { MealRole, MealType, Prisma, PrismaClient, QuantityUnit } from '@prisma/client';

import { VersionConflictError } from '../../database/optimistic-lock.js';
import { recordDeletedItem } from '../../database/deleted-items.js';

export interface RecipeIngredientInput {
  ingredientId?: string | null;
  name?: string;
  ingredientName?: string;
  quantity?: number | null;
  unit?: QuantityUnit | null;
  optional?: boolean;
  isPrimary?: boolean;
}

export interface RecipeStepInput {
  content: string;
  imagePath?: string | null;
}
export interface RecipeToolInput {
  toolId?: string | null;
  name: string;
  required?: boolean;
}

export interface RecipeWriteInput {
  name: string;
  imagePath?: string | null;
  ingredientsText?: string | null;
  cookingTimeMinutes?: number | null;
  difficulty?: string | null;
  spicyLevel?: number | null;
  servings?: number | null;
  sourceNote?: string | null;
  notes?: string | null;
  favorite?: boolean;
  enabledForRecommendation?: boolean;
  ingredients?: RecipeIngredientInput[];
  steps?: RecipeStepInput[];
  toolIds?: RecipeToolInput[];
  tags?: string[];
  mealTypes?: MealType[];
  mealRoles?: MealRole[];
}

export interface RecipeListQuery {
  search?: string;
  mealType?: MealType;
  difficulty?: string;
  spicyLevel?: number;
  favorite?: boolean;
  tag?: string;
  page?: number;
  pageSize?: number;
  sortBy?: 'name' | 'cookingTimeMinutes' | 'favorite' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

const recipeInclude = {
  ingredients: { orderBy: { sortOrder: 'asc' as const } },
  steps: { orderBy: { stepNo: 'asc' as const } },
  tags: { include: { tag: true } },
  mealTypes: true,
  mealRoles: true,
  tools: { include: { tool: true } }
};

function cleanNames(values: string[] = []): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function assertRecipeInput(input: RecipeWriteInput): void {
  if (!input.name?.trim()) throw Object.assign(new Error('菜谱名称不能为空'), { statusCode: 400 });
  if (
    input.cookingTimeMinutes != null &&
    (!Number.isInteger(input.cookingTimeMinutes) || input.cookingTimeMinutes < 0)
  ) {
    throw Object.assign(new Error('制作时间必须是非负整数'), { statusCode: 400 });
  }
  if (
    input.spicyLevel != null &&
    (!Number.isInteger(input.spicyLevel) || input.spicyLevel < 0 || input.spicyLevel > 5)
  ) {
    throw Object.assign(new Error('辣度必须是 0 到 5 的整数'), { statusCode: 400 });
  }
  for (const item of input.ingredients ?? []) {
    if (!(item.name ?? item.ingredientName)?.trim())
      throw Object.assign(new Error('食材名称不能为空'), { statusCode: 400 });
    if (item.quantity != null && (!Number.isFinite(item.quantity) || item.quantity < 0)) {
      throw Object.assign(new Error('食材数量不能为负数'), { statusCode: 400 });
    }
  }
  for (const step of input.steps ?? []) {
    if (!step.content?.trim()) throw Object.assign(new Error('制作步骤不能为空'), { statusCode: 400 });
  }
}

function assertVersionNumber(version: number): void {
  if (!Number.isInteger(version) || version < 1)
    throw Object.assign(new Error('version 必须是正整数'), { statusCode: 400 });
}

async function assertIngredientsExist(transaction: Prisma.TransactionClient, input: RecipeWriteInput): Promise<void> {
  const rows = input.ingredients ?? [];
  const ids = [...new Set(rows.map((item) => item.ingredientId).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return;
  const found = await transaction.ingredient.findMany({
    where: { id: { in: ids } },
    select: { id: true, deletedAt: true }
  });
  const valid = new Set(found.filter((ingredient) => ingredient.deletedAt === null).map((ingredient) => ingredient.id));
  for (const item of rows) {
    if (item.ingredientId && !valid.has(item.ingredientId)) {
      const name = (item.name ?? item.ingredientName ?? '未知食材').trim();
      throw Object.assign(new Error(`食材「${name}」不存在或已删除，无法关联到菜谱`), { statusCode: 400 });
    }
  }
}

async function relationCreates(
  transaction: Prisma.TransactionClient,
  recipeId: string,
  input: RecipeWriteInput
): Promise<void> {
  if (input.ingredients?.length) {
    await transaction.recipeIngredient.createMany({
      data: input.ingredients.map((item, index) => ({
        recipeId,
        ingredientId: item.ingredientId ?? null,
        ingredientNameSnapshot: (item.name ?? item.ingredientName)!.trim(),
        quantity: item.quantity ?? null,
        unit: item.unit ?? null,
        optional: item.optional ?? false,
        isPrimary: item.isPrimary ?? false,
        sortOrder: index
      }))
    });
  }
  if (input.steps?.length) {
    await transaction.recipeStep.createMany({
      data: input.steps.map((step, index) => ({
        recipeId,
        stepNo: index + 1,
        content: step.content.trim(),
        imagePath: step.imagePath ?? null
      }))
    });
  }
  if (input.mealTypes?.length) {
    await transaction.recipeMealType.createMany({
      data: [...new Set(input.mealTypes)].map((mealType) => ({ recipeId, mealType }))
    });
  }
  if (input.mealRoles?.length) {
    await transaction.recipeMealRole.createMany({
      data: [...new Set(input.mealRoles)].map((mealRole) => ({ recipeId, mealRole }))
    });
  }
  for (const name of cleanNames(input.tags)) {
    const tag = await transaction.tag.upsert({
      where: { name_type: { name, type: 'GENERAL' } },
      update: { deletedAt: null },
      create: { name, type: 'GENERAL' }
    });
    await transaction.recipeTag.create({ data: { recipeId, tagId: tag.id } });
  }
  if (input.toolIds?.length) {
    await transaction.recipeTool.createMany({
      data: input.toolIds.map((tool) => ({
        recipeId,
        toolId: tool.toolId ?? null,
        toolNameSnapshot: tool.name.trim(),
        required: tool.required ?? true
      }))
    });
  }
}

function scalarData(input: RecipeWriteInput): Prisma.RecipeUncheckedCreateInput {
  return {
    name: input.name.trim(),
    imagePath: input.imagePath ?? null,
    ingredientsText: input.ingredientsText ?? null,
    cookingTimeMinutes: input.cookingTimeMinutes ?? null,
    difficulty: input.difficulty ?? null,
    spicyLevel: input.spicyLevel ?? null,
    servings: input.servings ?? null,
    sourceNote: input.sourceNote ?? null,
    notes: input.notes ?? null,
    favorite: input.favorite ?? false,
    enabledForRecommendation: input.enabledForRecommendation ?? true
  };
}

export async function listRecipes(database: PrismaClient, query: RecipeListQuery = {}) {
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 20)));
  const search = query.search?.trim();
  const where: Prisma.RecipeWhereInput = {
    deletedAt: null,
    ...(query.mealType ? { mealTypes: { some: { mealType: query.mealType } } } : {}),
    ...(query.difficulty ? { difficulty: query.difficulty } : {}),
    ...(query.spicyLevel != null ? { spicyLevel: query.spicyLevel } : {}),
    ...(query.favorite != null ? { favorite: query.favorite } : {}),
    ...(query.tag ? { tags: { some: { tag: { name: query.tag, deletedAt: null } } } } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search } },
            { notes: { contains: search } },
            { ingredientsText: { contains: search } },
            { ingredients: { some: { ingredientNameSnapshot: { contains: search } } } },
            { tags: { some: { tag: { name: { contains: search } } } } }
          ]
        }
      : {})
  };
  const sortable = ['name', 'cookingTimeMinutes', 'favorite', 'createdAt', 'updatedAt'] as const;
  const sortBy = sortable.includes(query.sortBy as (typeof sortable)[number]) ? query.sortBy! : 'updatedAt';
  const [items, total] = await database.$transaction([
    database.recipe.findMany({
      where,
      include: recipeInclude,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { [sortBy]: query.sortOrder ?? 'desc' }
    }),
    database.recipe.count({ where })
  ]);
  return { items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

export async function getRecipe(database: PrismaClient, id: string) {
  const recipe = await database.recipe.findFirst({ where: { id, deletedAt: null }, include: recipeInclude });
  if (!recipe) throw Object.assign(new Error('菜谱不存在'), { statusCode: 404 });
  return recipe;
}

export async function createRecipe(database: PrismaClient, input: RecipeWriteInput) {
  assertRecipeInput(input);
  return database.$transaction(async (transaction) => {
    await assertIngredientsExist(transaction, input);
    const recipe = await transaction.recipe.create({ data: scalarData(input) });
    await relationCreates(transaction, recipe.id, input);
    return transaction.recipe.findUniqueOrThrow({ where: { id: recipe.id }, include: recipeInclude });
  });
}

export async function updateRecipe(database: PrismaClient, id: string, version: number, input: RecipeWriteInput) {
  assertVersionNumber(version);
  assertRecipeInput(input);
  return database.$transaction(async (transaction) => {
    // 校验先于任何写操作（落库之前完成食材存在性校验）
    await assertIngredientsExist(transaction, input);
    const result = await transaction.recipe.updateMany({
      where: { id, version, deletedAt: null },
      data: { ...scalarData(input), version: { increment: 1 } }
    });
    if (result.count === 0) {
      const current = await transaction.recipe.findUnique({
        where: { id },
        select: { version: true, deletedAt: true }
      });
      if (!current || current.deletedAt) throw Object.assign(new Error('菜谱不存在'), { statusCode: 404 });
      throw new VersionConflictError({
        entity: 'Recipe',
        id,
        expectedVersion: version,
        actualVersion: current.version
      });
    }
    await transaction.recipeIngredient.deleteMany({ where: { recipeId: id } });
    await transaction.recipeStep.deleteMany({ where: { recipeId: id } });
    await transaction.recipeTag.deleteMany({ where: { recipeId: id } });
    await transaction.recipeMealType.deleteMany({ where: { recipeId: id } });
    await transaction.recipeMealRole.deleteMany({ where: { recipeId: id } });
    await transaction.recipeTool.deleteMany({ where: { recipeId: id } });
    await relationCreates(transaction, id, input);
    return transaction.recipe.findUniqueOrThrow({ where: { id }, include: recipeInclude });
  });
}

export async function deleteRecipe(database: PrismaClient, id: string, version: number) {
  assertVersionNumber(version);
  return database.$transaction(async (transaction) => {
    const deletedAt = new Date();
    const result = await transaction.recipe.updateMany({
      where: { id, version, deletedAt: null },
      data: { deletedAt, version: { increment: 1 } }
    });
    if (result.count === 0) {
      const current = await transaction.recipe.findUnique({
        where: { id },
        select: { version: true, deletedAt: true }
      });
      if (!current || current.deletedAt) throw Object.assign(new Error('菜谱不存在'), { statusCode: 404 });
      throw new VersionConflictError({
        entity: 'Recipe',
        id,
        expectedVersion: version,
        actualVersion: current.version
      });
    }
    await recordDeletedItem(transaction, 'Recipe', id, deletedAt);
    return { id, deleted: true };
  });
}

export async function toggleRecipeFavorite(database: PrismaClient, id: string, version: number, favorite: boolean) {
  assertVersionNumber(version);
  const current = await database.recipe.findFirst({ where: { id, deletedAt: null }, select: { version: true } });
  if (!current) throw Object.assign(new Error('菜谱不存在'), { statusCode: 404 });
  if (current.version !== version)
    throw new VersionConflictError({ entity: 'Recipe', id, expectedVersion: version, actualVersion: current.version });
  return database.recipe.update({ where: { id }, data: { favorite, version: { increment: 1 } } });
}
