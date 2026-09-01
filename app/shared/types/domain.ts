export type ID = string;
export type ISODateTime = string;
export type BusinessDate = string;

export type MealType = 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'AFTERNOON_TEA' | 'SOUP';
export type QuantityUnit =
  | 'GRAM'
  | 'KILOGRAM'
  | 'MILLILITER'
  | 'LITER'
  | 'PIECE'
  | 'BOX'
  | 'BAG'
  | 'BOTTLE'
  | 'CAN'
  | 'PACK'
  | 'PORTION'
  | 'OTHER';

export interface RecipeIngredientDto {
  id: ID;
  ingredientId: ID | null;
  ingredientName: string;
  quantity: number | null;
  unit: QuantityUnit | null;
  optional: boolean;
  isPrimary: boolean;
  sortOrder: number;
}

export interface RecipeStepDto {
  id: ID;
  stepNo: number;
  content: string;
  imagePath: string | null;
}

export interface RecipeToolDto {
  id: ID;
  toolId: ID | null;
  toolName: string;
  required: boolean;
}

export interface RecipeDto {
  id: ID;
  name: string;
  imagePath: string | null;
  cookingTimeMinutes: number | null;
  difficulty: string | null;
  spicyLevel: number | null;
  servings: number | null;
  ingredientsText: string | null;
  sourceNote: string | null;
  notes: string | null;
  favorite: boolean;
  enabledForRecommendation: boolean;
  version: number;
  ingredients: RecipeIngredientDto[];
  steps: RecipeStepDto[];
  tools: RecipeToolDto[];
  tags: string[];
  mealTypes: MealType[];
  mealRoles: MealRole[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type InventoryStatus = 'NORMAL' | 'EXPIRING_SOON' | 'EXPIRED' | 'LOW_STOCK' | 'DEPLETED';

export interface InventoryBatchDto {
  id: ID;
  ingredientId: ID;
  quantity: number;
  unit: QuantityUnit;
  purchaseDate: BusinessDate | null;
  expiryDate: BusinessDate | null;
  location: string | null;
  opened: boolean;
  consumePriority: boolean;
  notes: string | null;
  status: InventoryStatus;
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface IngredientDto {
  id: ID;
  name: string;
  category: string | null;
  imagePath: string | null;
  quantity: number;
  unit: QuantityUnit;
  purchaseDate: BusinessDate | null;
  expiryDate: BusinessDate | null;
  minStock: number | null;
  maxStock: number | null;
  opened: boolean;
  location: string | null;
  notes: string | null;
  status: InventoryStatus;
  batches: InventoryBatchDto[];
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type InventoryChangeType =
  'PURCHASE' | 'MANUAL_ADD' | 'COOK_DEDUCT' | 'MANUAL_DEDUCT' | 'WASTE' | 'RESTORE' | 'ADJUST';

export interface InventoryLogDto {
  id: ID;
  ingredientId: ID | null;
  inventoryBatchId: ID | null;
  ingredientName: string;
  beforeQuantity: number;
  changeQuantity: number;
  afterQuantity: number;
  unit: QuantityUnit;
  changeType: InventoryChangeType;
  notes: string | null;
  createdAt: ISODateTime;
}

export interface KitchenToolDto {
  id: ID;
  name: string;
  imagePath: string | null;
  category: string | null;
  quantity: number;
  status: string | null;
  notes: string | null;
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface StoreDto {
  id: ID;
  name: string;
  imagePath: string | null;
  address: string | null;
  storeType: string | null;
  cuisine: string | null;
  averageCost: number | null;
  supportsDineIn: boolean;
  supportsTakeout: boolean;
  contact: string | null;
  businessHours: string | null;
  rating: number | null;
  recommendedDishes: string | null;
  avoidDishes: string | null;
  tagsText: string | null;
  notes: string | null;
  mealTypes: MealType[];
  favorite: boolean;
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type MealPlanStatus = 'UNPLANNED' | 'PLANNED' | 'COMPLETED' | 'CANCELLED';
export type MealPlanItemType = 'RECIPE' | 'STORE' | 'CUSTOM';
export type MealRole = 'MAIN' | 'SIDE' | 'STAPLE' | 'SOUP' | 'DRINK';

export interface MealPlanItemDto {
  id: ID;
  itemType: MealPlanItemType;
  mealRole: MealRole | null;
  recipeId: ID | null;
  storeId: ID | null;
  customName: string | null;
  sortOrder: number;
}

export interface MealPlanDto {
  id: ID;
  planDate: BusinessDate;
  mealType: MealType;
  dinerCount: number;
  status: MealPlanStatus;
  notes: string | null;
  items: MealPlanItemDto[];
  diners: DinerDto[];
  completedAt: ISODateTime | null;
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type MealRecordSourceType = 'HOMEMADE' | 'DINE_IN' | 'TAKEOUT' | 'CUSTOM';
export type MealRecordItemType = 'RECIPE' | 'STORE' | 'CUSTOM';
export type MealRecordStatus = 'DRAFT' | 'CONFIRMED';

export interface MealRecordItemDto {
  id: ID;
  itemType: MealRecordItemType;
  mealRole: MealRole | null;
  recipeId: ID | null;
  storeId: ID | null;
  customName: string | null;
  sortOrder: number;
}

export interface MealRecordDto {
  id: ID;
  recordDate: BusinessDate;
  recordTime: string | null;
  mealType: MealType;
  sourceType: MealRecordSourceType;
  status: MealRecordStatus;
  imagePath: string | null;
  rating: number | null;
  isNewTry: boolean;
  favorite: boolean;
  notes: string | null;
  relatedPlanId: ID | null;
  sourceMealPlanId: ID | null;
  confirmedAt: ISODateTime | null;
  items: MealRecordItemDto[];
  diners: DinerDto[];
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface DinerDto {
  id: ID;
  name: string;
  avatarPath: string | null;
  active: boolean;
  likesText: string | null;
  dislikesText: string | null;
  tabooText: string | null;
  allergyText: string | null;
  portionNote: string | null;
  notes: string | null;
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type ShoppingListStatus = 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
export type ShoppingSourceType = 'MANUAL' | 'RECIPE' | 'RECOMMENDATION' | 'LOW_STOCK' | 'PLAN' | 'INSUFFICIENT_STOCK';

export interface ShoppingListItemDto {
  id: ID;
  ingredientId: ID | null;
  ingredientName: string;
  quantity: number;
  unit: QuantityUnit;
  sourceType: ShoppingSourceType;
  sourceId: ID | null;
  completed: boolean;
  sortOrder: number;
  notes: string | null;
}

export interface ShoppingListDto {
  id: ID;
  name: string;
  status: ShoppingListStatus;
  notes: string | null;
  items: ShoppingListItemDto[];
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type RecommendationType = 'SINGLE' | 'MEAL_SET' | 'INVENTORY';

export interface RecommendationRequestDto {
  type: RecommendationType;
  mealType?: MealType;
  dinerIds?: ID[];
  allowPurchase?: boolean;
  onlyInventory?: boolean;
  tags?: string[];
}

export interface RecommendationResultDto {
  resultType: 'RECIPE' | 'STORE' | 'MEAL_SET';
  resultId: ID | null;
  title: string;
  reason: string;
  missingIngredients: string[];
}

export interface CalendarDayDto {
  date: BusinessDate;
  hasPlans: boolean;
  hasRecords: boolean;
  hasDrafts: boolean;
  plans: Array<Pick<MealPlanDto, 'id' | 'planDate' | 'mealType' | 'status' | 'dinerCount' | 'version'>>;
  records: Array<Pick<MealRecordDto, 'id' | 'recordDate' | 'mealType' | 'status' | 'rating' | 'version'>>;
}

export interface CalendarDto {
  start: BusinessDate;
  end: BusinessDate;
  days: CalendarDayDto[];
}

export interface StatisticsDto {
  period: { start: BusinessDate; end: BusinessDate };
  totalRecords: number;
  totalMeals: number;
  recordedDays: number;
  averageRating: number | null;
  sourceBreakdown: Record<string, number>;
  mealTypeDistribution: Record<string, number>;
  newTryCount: number;
  favoriteCount: number;
  shoppingCompletionRate: number | null;
  trend: Array<{ date: BusinessDate; count: number }>;
  ingredientConsumption: Array<{ ingredientId: ID | null; name: string; quantity: number; unit: string }>;
  topRecipes: Array<{ id: ID; name: string; count: number }>;
  topStores: Array<{ id: ID; name: string; count: number }>;
}

export interface ConsumptionPreviewItemDto {
  recipeIngredientId: ID;
  ingredientId: ID | null;
  ingredientName: string;
  requiredQuantity: number;
  unit: QuantityUnit;
  allocations: Array<{
    batchId: ID;
    batchVersion: number;
    quantity: number;
    unit: QuantityUnit;
  }>;
  availableBatches: Array<{
    batchId: ID;
    batchVersion: number;
    quantity: number;
    availableQuantity: number;
    unit: QuantityUnit;
    expiryDate: BusinessDate | null;
    location: string | null;
  }>;
  shortageQuantity: number;
  requiresManualSelection: boolean;
}

export interface ConsumptionPreviewDto {
  recordId: ID;
  recordVersion: number;
  previewToken: string;
  items: ConsumptionPreviewItemDto[];
}

export interface ConsumptionConfirmationDto {
  operationId: ID;
  recordId: ID;
  recordVersion: number;
  inventoryLogIds: ID[];
  shoppingListId: ID | null;
  repeated: boolean;
}

/** 即时用餐：由菜谱直接计算出的库存预览（无需先建 DRAFT 记录）。 */
export interface ImmediateMealPreviewDto {
  recipeId: ID;
  dinerCount: number;
  previewToken: string;
  items: ConsumptionPreviewItemDto[];
}

export interface UploadAssetDto {
  id: ID;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  createdAt: ISODateTime;
}
