import type { PrismaClient, QuantityUnit } from '@prisma/client';

import { convertQuantity } from '../../database/units.js';
import { forbidden, loadForbiddenWords } from '../../shared/diner-rules.js';

export type InventoryRecommendationMode = 'ONLY_INVENTORY' | 'ALLOW_PURCHASE' | 'MUST_CONSUME';

export interface InventoryRecommendationInput {
  mode: InventoryRecommendationMode;
  dinerIds?: string[];
  ingredientIds?: string[];
  limit?: number;
}

function localDate(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function availableQuantity(
  batches: Array<{ quantity: number; unit: QuantityUnit }>,
  requiredUnit: QuantityUnit | null
): { quantity: number; convertible: boolean } {
  if (!requiredUnit) return { quantity: 0, convertible: false };
  let convertible = false;
  const quantity = batches.reduce((total, batch) => {
    const value = convertQuantity(batch.quantity, batch.unit, requiredUnit);
    if (value == null) return total;
    convertible = true;
    return total + value;
  }, 0);
  return { quantity, convertible };
}

export async function recommendFromInventory(database: PrismaClient, input: InventoryRecommendationInput) {
  if (!['ONLY_INVENTORY', 'ALLOW_PURCHASE', 'MUST_CONSUME'].includes(input.mode)) {
    throw Object.assign(new Error('库存推荐模式无效'), { statusCode: 400 });
  }
  const recipes = await database.recipe.findMany({
    where: { deletedAt: null, enabledForRecommendation: true },
    include: {
      ingredients: { orderBy: { sortOrder: 'asc' } },
      tools: { include: { tool: true } }
    }
  });
  const batches = await database.inventoryBatch.findMany({
    where: {
      deletedAt: null,
      quantity: { gt: 0 },
      ingredient: { deletedAt: null },
      OR: [{ expiryDate: null }, { expiryDate: { gte: localDate() } }]
    },
    include: { ingredient: true }
  });
  const forbiddenWords = await loadForbiddenWords(database, input.dinerIds);
  const blockedRecipeIds = new Set<string>();
  if (forbiddenWords.length) {
    for (const recipe of recipes) {
      const haystack = [
        recipe.name,
        recipe.ingredientsText,
        recipe.notes,
        ...recipe.ingredients.map((x) => x.ingredientNameSnapshot)
      ]
        .filter(Boolean)
        .join(' ');
      if (forbidden(haystack, forbiddenWords)) blockedRecipeIds.add(recipe.id);
    }
  }
  const batchesByIngredient = new Map<string, typeof batches>();
  for (const batch of batches) {
    const group = batchesByIngredient.get(batch.ingredientId) ?? [];
    group.push(batch);
    batchesByIngredient.set(batch.ingredientId, group);
  }
  const requested = new Set(input.ingredientIds ?? []);
  const today = localDate();
  const in24Hours = localDate(1);
  const in3Days = localDate(3);
  const wasteIds = new Set(
    batches
      .filter(
        (batch) =>
          batch.consumePriority ||
          batch.opened ||
          Boolean(batch.expiryDate && batch.expiryDate >= today && batch.expiryDate <= in3Days) ||
          Boolean(batch.ingredient.maxStock != null && batch.ingredient.quantity > batch.ingredient.maxStock)
      )
      .map((batch) => batch.ingredientId)
  );

  const candidates = recipes
    .map((recipe) => {
      const existing: Array<{
        ingredientId: string;
        name: string;
        required: number | null;
        available: number;
        unit: QuantityUnit | null;
      }> = [];
      const missing: Array<{
        ingredientId: string | null;
        name: string;
        quantity: number | null;
        unit: QuantityUnit | null;
        reason: string;
      }> = [];
      let requiredCount = 0;
      let satisfiedCount = 0;
      let wasteScore = 0;
      for (const item of recipe.ingredients) {
        if (item.optional) continue;
        requiredCount += 1;
        const stock = item.ingredientId ? (batchesByIngredient.get(item.ingredientId) ?? []) : [];
        if (!item.ingredientId || item.quantity == null || item.unit == null) {
          missing.push({
            ingredientId: item.ingredientId,
            name: item.ingredientNameSnapshot,
            quantity: item.quantity,
            unit: item.unit,
            reason: !item.ingredientId ? '未关联库存食材' : '缺少可计算的数量或单位'
          });
          continue;
        }
        const available = availableQuantity(stock, item.unit);
        if (!available.convertible || available.quantity < item.quantity) {
          missing.push({
            ingredientId: item.ingredientId,
            name: item.ingredientNameSnapshot,
            quantity: Math.max(0, item.quantity - available.quantity),
            unit: item.unit,
            reason: available.convertible ? '库存不足' : '库存单位不可换算'
          });
        } else {
          satisfiedCount += 1;
          existing.push({
            ingredientId: item.ingredientId,
            name: item.ingredientNameSnapshot,
            required: item.quantity,
            available: available.quantity,
            unit: item.unit
          });
        }
        if (wasteIds.has(item.ingredientId)) {
          wasteScore += 1;
          for (const batch of stock) {
            if (batch.consumePriority) wasteScore += 100;
            else if (batch.expiryDate && batch.expiryDate <= in24Hours && batch.expiryDate >= today) wasteScore += 50;
            else if (batch.expiryDate && batch.expiryDate <= in3Days && batch.expiryDate >= today) wasteScore += 25;
            if (batch.opened) wasteScore += 10;
          }
        }
      }
      const missingTools = recipe.tools
        .filter(
          (link) =>
            link.required &&
            (!link.tool ||
              link.tool.deletedAt ||
              link.tool.quantity <= 0 ||
              ['BROKEN', 'MISSING', 'UNAVAILABLE'].includes((link.tool.status ?? '').toUpperCase()))
        )
        .map((link) => link.toolNameSnapshot);
      const completion = requiredCount === 0 ? 100 : Math.round((satisfiedCount / requiredCount) * 100);
      const consumesRequested =
        requested.size === 0 ||
        recipe.ingredients.some((item) => item.ingredientId && requested.has(item.ingredientId));
      return {
        recipe: {
          id: recipe.id,
          name: recipe.name,
          imagePath: recipe.imagePath,
          cookingTimeMinutes: recipe.cookingTimeMinutes
        },
        existingIngredients: existing,
        missingIngredients: missing,
        missingTools,
        completion,
        completionLabel: completion === 100 ? '100% 可直接做' : missing.length <= 2 ? '缺少 1–2 项' : '缺少多项',
        wasteScore,
        consumesRequested,
        reason:
          completion === 100
            ? wasteScore > 0
              ? '现有库存可完成，并可优先消耗临期或已开封食材'
              : '现有库存可直接完成'
            : `还缺少 ${missing.length} 项食材`
      };
    })
    .filter((candidate) => !blockedRecipeIds.has(candidate.recipe.id))
    .filter((candidate) => candidate.missingTools.length === 0)
    .filter((candidate) => input.mode !== 'ONLY_INVENTORY' || candidate.missingIngredients.length === 0)
    .filter(
      (candidate) =>
        input.mode !== 'MUST_CONSUME' || (requested.size > 0 ? candidate.consumesRequested : candidate.wasteScore > 0)
    )
    .sort((a, b) =>
      input.mode === 'MUST_CONSUME'
        ? b.wasteScore - a.wasteScore || b.completion - a.completion
        : b.completion - a.completion || b.wasteScore - a.wasteScore
    );

  return {
    mode: input.mode,
    candidateCount: candidates.length,
    items: candidates.slice(0, Math.min(100, Math.max(1, input.limit ?? 20)))
  };
}

export async function listAllInventoryLogs(
  database: PrismaClient,
  query: { ingredientId?: string; batchId?: string; take?: number } = {}
) {
  return database.inventoryLog.findMany({
    where: { ingredientId: query.ingredientId, inventoryBatchId: query.batchId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, query.take ?? 50))
  });
}
