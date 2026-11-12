-- Google 2.0 正式字段补齐：饮食记录（饱腹 / 摄入热量 / 就餐消费）与菜谱热量。
--
-- 四列全部为可空且不设 DEFAULT：
--   * 旧记录 / 旧菜谱在迁移后保持 NULL，不写入任何推测性数值（"8 分饱" "320 kcal" 属于前端演示值，不得落库）；
--   * NULL 在契约中表示"用户未填写"，与 0（真实输入的零消费 / 零热量）语义区分。
-- 新写入只由 API 层负责校验范围，数据库不做约束，避免影响既有数据与其它工作流。

-- AlterTable
ALTER TABLE "MealRecord" ADD COLUMN "calories" INTEGER;
ALTER TABLE "MealRecord" ADD COLUMN "cost" INTEGER;
ALTER TABLE "MealRecord" ADD COLUMN "satiety" INTEGER;

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN "calories" INTEGER;
