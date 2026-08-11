import type { MealType, QuantityUnit } from './domain.js';

export interface DashboardRecipe {
  id: string;
  name: string;
  imagePath: string | null;
  cookingTimeMinutes: number | null;
  tags: string[];
  rating: number | null;
}

export interface DashboardMealSlot {
  mealType: MealType;
  label: string;
  time: string | null;
  recorded: boolean;
  title: string | null;
  summary: string | null;
  rating: number | null;
}

export interface DashboardExpiringIngredient {
  id: string;
  name: string;
  expiryDate: string | null;
  quantity: number;
  unit: QuantityUnit;
}

export interface DashboardCalendarDay {
  date: string;
  weekday: string;
  dayOfMonth: number;
  isToday: boolean;
  status: 'empty' | 'planned' | 'recorded';
}

export interface DashboardDto {
  generatedAt: string;
  branding: {
    appName: string;
    subtitle: string;
  };
  userNickname: string | null;
  currentDate: string;
  greetingPeriod: 'morning' | 'afternoon' | 'evening';
  greetingText: string;
  recommendedRecipes: DashboardRecipe[];
  todayRecords: DashboardMealSlot[];
  inventory: {
    totalIngredients: number;
    expiringSoon: number;
    insufficient: number;
    expiringIngredients: DashboardExpiringIngredient[];
  };
  weeklyStats: {
    recordedDays: number;
    totalMeals: number;
    averageRating: number | null;
    consumedIngredientCount: number;
  };
  calendarDays: DashboardCalendarDay[];
  tip: string;
}
