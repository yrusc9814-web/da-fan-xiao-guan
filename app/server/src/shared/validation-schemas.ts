import {
  InventoryChangeType,
  MealRole,
  MealType,
  PlanItemType,
  PlanStatus,
  QuantityUnit,
  RecordItemType,
  RecordSourceType,
  RecordStatus,
  ShoppingListStatus,
  ShoppingSourceType
} from '@prisma/client';

/**
 * 外部写接口共用的 JSON Schema 片段。
 *
 * 职责边界：这里只做“形状级”校验（类型 / 必填 / enum / 数组 / 可空 / 明显 min/max），
 * 数据库存在性、乐观锁冲突、状态迁移、语义日期等仍由各 service 负责。
 * 枚举值直接取自 Prisma 生成的枚举，避免与 schema.prisma 漂移。
 */

const enumSchema = (values: readonly string[]) => ({ type: 'string', enum: [...values] });
const nullableEnumSchema = (values: readonly string[]) => ({
  type: ['string', 'null'],
  enum: [...values, null]
});

export const mealTypeSchema = enumSchema(Object.values(MealType));
export const mealRoleSchema = enumSchema(Object.values(MealRole));
export const nullableMealRoleSchema = nullableEnumSchema(Object.values(MealRole));
export const quantityUnitSchema = enumSchema(Object.values(QuantityUnit));
export const nullableQuantityUnitSchema = nullableEnumSchema(Object.values(QuantityUnit));
export const planItemTypeSchema = enumSchema(Object.values(PlanItemType));
export const planStatusSchema = enumSchema(Object.values(PlanStatus));
export const recordItemTypeSchema = enumSchema(Object.values(RecordItemType));
export const recordSourceTypeSchema = enumSchema(Object.values(RecordSourceType));
export const recordStatusSchema = enumSchema(Object.values(RecordStatus));
export const inventoryChangeTypeSchema = enumSchema(Object.values(InventoryChangeType));
export const shoppingListStatusSchema = enumSchema(Object.values(ShoppingListStatus));
export const shoppingSourceTypeSchema = enumSchema(Object.values(ShoppingSourceType));

export const nullableStringSchema = { type: ['string', 'null'] };
export const booleanSchema = { type: 'boolean' };
export const integerSchema = { type: 'integer' };
export const numberSchema = { type: 'number' };
export const stringSchema = { type: 'string' };
export const stringListSchema = { type: 'array', items: stringSchema };

/** 乐观锁版本号（请求体/响应体中出现）：正整数，拒绝字符串、负数、小数。 */
export const versionBodySchema = { type: 'integer', minimum: 1 };

/**
 * 查询串中的版本号：query 值永远是字符串，且 AJV 已关闭强转，
 * 因此用字符串 + 数字模式校验，service 侧再做 Number() 转换。
 */
export const versionQuerySchema = { type: 'string', pattern: '^[1-9][0-9]*$' };

/** 库存扣减预览的批次选择：Record<recipeIngredientId, batchId[]>。 */
export const consumptionSelectionsSchema = {
  type: 'object',
  additionalProperties: { type: 'array', items: stringSchema }
};
