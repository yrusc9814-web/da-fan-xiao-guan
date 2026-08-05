export function assertNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} 不能为负数`);
  }
}

export function assertRating(value: number | null | undefined, field = '评分'): void {
  if (value === null || value === undefined) {
    return;
  }

  if (!Number.isFinite(value) || value < 0 || value > 5) {
    throw new Error(`${field}必须在 0 到 5 之间`);
  }
}

export function assertSpicyLevel(value: number | null | undefined): void {
  if (value === null || value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value < 0 || value > 5) {
    throw new Error('辣度必须是 0 到 5 的整数');
  }
}

export function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field}不能为空`);
  }
}

export function assertRecipeName(value: string): void {
  assertNonEmpty(value, '菜谱名称');
}

export function assertIngredientQuantity(value: number): void {
  assertNonNegative(value, '食材数量');
}

export function assertRecipeIngredientQuantity(value: number | null | undefined): void {
  if (value !== null && value !== undefined) {
    assertNonNegative(value, '菜谱食材数量');
  }
}

export function assertMealPlanDinerCount(value: number): void {
  if (!Number.isInteger(value)) {
    throw new Error('餐次数量必须是整数');
  }
  assertNonNegative(value, '餐次数量');
}

export function assertShoppingListQuantity(value: number): void {
  assertNonNegative(value, '购物清单数量');
}

export function assertBusinessDate(value: string, field = '业务日期'): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field}必须使用 YYYY-MM-DD 格式`);
  }
}
