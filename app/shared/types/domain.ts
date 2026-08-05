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

export interface RecipeDto {
  id: ID;
  name: string;
  imagePath: string | null;
  cookingTimeMinutes: number | null;
  difficulty: string | null;
  spicyLevel: number | null;
  servings: number | null;
  favorite: boolean;
  version: number;
  ingredients: RecipeIngredientDto[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface IngredientDto {
  id: ID;
  name: string;
  category: string | null;
  quantity: number;
  unit: QuantityUnit;
  purchaseDate: BusinessDate | null;
  expiryDate: BusinessDate | null;
  minStock: number | null;
  opened: boolean;
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface StoreDto {
  id: ID;
  name: string;
  address: string | null;
  storeType: string | null;
  cuisine: string | null;
  averageCost: number | null;
  rating: number | null;
  favorite: boolean;
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type MealPlanStatus = 'UNPLANNED' | 'PLANNED' | 'COMPLETED' | 'CANCELLED';
export type MealPlanItemType = 'RECIPE' | 'STORE' | 'CUSTOM';

export interface MealPlanItemDto {
  id: ID;
  itemType: MealPlanItemType;
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
  items: MealPlanItemDto[];
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type MealRecordSourceType = 'HOMEMADE' | 'DINE_IN' | 'TAKEOUT' | 'CUSTOM';
export type MealRecordItemType = 'RECIPE' | 'STORE' | 'CUSTOM';

export interface MealRecordItemDto {
  id: ID;
  itemType: MealRecordItemType;
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
  rating: number | null;
  isNewTry: boolean;
  favorite: boolean;
  items: MealRecordItemDto[];
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
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type ShoppingListStatus = 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
export type ShoppingSourceType = 'MANUAL' | 'RECIPE' | 'RECOMMENDATION' | 'LOW_STOCK' | 'PLAN';

export interface ShoppingListItemDto {
  id: ID;
  ingredientId: ID | null;
  ingredientName: string;
  quantity: number;
  unit: QuantityUnit;
  sourceType: ShoppingSourceType;
  completed: boolean;
  sortOrder: number;
}

export interface ShoppingListDto {
  id: ID;
  name: string;
  status: ShoppingListStatus;
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
