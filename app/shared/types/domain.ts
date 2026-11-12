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
  /** 自由用量原文（"300g" / "半个" / "适量" / "2汤匙"）：逐行保留用户输入；null 表示未填写。 */
  amountText: string | null;
  optional: boolean;
  isPrimary: boolean;
  sortOrder: number;
}

export interface RecipeStepDto {
  id: ID;
  stepNo: number;
  content: string;
  /** 步骤标题：与 content（步骤说明）独立；null 表示未填写。 */
  title: string | null;
  /** 步骤计时（分钟）：0..180 整数；null 表示未填写，0 是真实值。 */
  timerMinutes: number | null;
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
  /** 菜谱分类（前端 #formRecipeCategory）：与 tags 相互独立；null 表示未填写。 */
  category: string | null;
  imagePath: string | null;
  cookingTimeMinutes: number | null;
  difficulty: string | null;
  spicyLevel: number | null;
  servings: number | null;
  /** 热量 kcal：50..2000 整数；null 表示未填写（与 Google 2.0 前端 min/max 一致）。 */
  calories: number | null;
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
  /** 设备图标（前端 #formToolIcon 的 emoji 原文）：null 表示未填写，读取侧不得以 🍲 等默认值兜底。 */
  icon: string | null;
  category: string | null;
  quantity: number;
  status: string | null;
  notes: string | null;
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface StoreMenuItemDto {
  id: ID;
  storeId: ID;
  /** 菜品名称：必填非空。 */
  name: string;
  /** 真实单价（元）：1..999 整数；null 表示未填写单价，不做任何兜底造假。 */
  price: number | null;
  icon: string | null;
  isSignature: boolean;
  desc: string | null;
  /** 菜单展示顺序：随请求数组下标落库，读取时按此升序返回。 */
  sortOrder: number;
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
  /** 招牌菜单：按 sortOrder 升序；无菜单时为空数组，不再用 recommendedDishes 摘要替代。 */
  menuItems: StoreMenuItemDto[];
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
  /**
   * 计划就餐时间（"HH:MM" 24 小时制，前端 #planPickerTimeVal / isValidBentoTime）：
   * null 表示未填写；不做 12:30/08:30 等默认值兜底。
   */
  time: string | null;
  /** 计划标题（PlanPicker 目标名原文）：null 表示未填写，不由后端拼接。 */
  title: string | null;
  /** 计划副文案（预估热量/人均渠道等原文）：null 表示未填写，不由后端生成。 */
  subtext: string | null;
  /** 计划图标（emoji 原文）：null 表示未填写，读取侧不得以 🍱/🥘 等默认值替代。 */
  icon: string | null;
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
  title: string | null;
  status: MealRecordStatus;
  imagePath: string | null;
  /**
   * 多图照片列表（规范化自 DB MealRecord.photosJson 的 JSON 字符串；第 1 张为封面，最多 3 张）。
   *
   * 读取契约：photosJson 非 NULL → 解析后的有序数组；photosJson 为 NULL 且 imagePath 有值 →
   * `[imagePath]`（旧单图保真回退）；两者都为空 → null。绝不返回 `[]` 占位。
   *
   * 写入契约：非空数组 → 规范 JSON（JSON.stringify 无空白）写入 photosJson，并同步
   * imagePath = photos[0] ?? null 供旧单图消费方（上传引用检查、日历等）继续工作；
   * 空数组/清除 → photosJson = NULL 且 imagePath = NULL。条目必须是相对存储路径，
   * 禁止 data URL / base64 落 SQLite。
   */
  photos: string[] | null;
  rating: number | null;
  /** 饱腹度：3 / 5 / 7 / 8 / 10；null 表示未填写。 */
  satiety: number | null;
  /** 摄入热量 kcal：非负整数；null 表示未填写。 */
  calories: number | null;
  /** 就餐消费（元）：0..9999 整数；null 表示未填写。 */
  cost: number | null;
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
