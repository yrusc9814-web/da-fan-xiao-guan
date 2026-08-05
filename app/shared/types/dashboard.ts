import type { IngredientDto, MealRecordDto, RecipeDto } from './domain';

export interface DashboardDto {
  generatedAt: string;
  recommendedRecipes: RecipeDto[];
  todayRecords: MealRecordDto[];
  inventory: {
    totalIngredients: number;
    expiringSoon: number;
    insufficient: number;
    expiringIngredients: IngredientDto[];
  };
  weeklyStats: {
    recordedDays: number;
    totalMeals: number;
    averageRating: number | null;
    consumedIngredientCount: number;
  };
}
