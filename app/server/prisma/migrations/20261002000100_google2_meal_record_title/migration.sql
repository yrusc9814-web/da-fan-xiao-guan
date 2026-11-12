-- Google2 MealRecord 用户标题：仅追加可空列，旧记录保持 NULL，关系与数据不改写。
ALTER TABLE "MealRecord" ADD COLUMN "title" TEXT;
