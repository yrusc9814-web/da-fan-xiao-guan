-- Google 2.0 正式菜谱录入字段补齐：菜谱分类 / 自由用量原文 / 步骤标题与计时。
--
-- 事实来源：谷歌2.0版本/index.html
--   * #formRecipeCategory（select）→ 提交 category，详情与卡片消费该值；
--     它不是 tags：tag 由 tagsText/标签接口独立维护，两者可同时存在，互不反写。
--   * .recipe-ing-amount 是自由文本（"300g" / "半个" / "适量" / "2汤匙"），
--     RecipeIngredient.quantity + unit 只能承载可换算的数值+枚举，无法无损承载该原文；
--   * .recipe-step-title / .recipe-step-desc / .recipe-step-timer(min=0 max=180)
--     是三段独立输入，content（=desc）不能吞并 title，timerMinutes 也没有承载列。
--
-- 本迁移为纯追加列：
--   * 四个列全部可空且不设 DEFAULT，历史数据保持真正的 NULL（不写入推测性分类/用量/标题/计时）；
--   * NULL 表示"用户未填写"，与真实输入的 0（如计时 0 分钟）语义区分；
--   * 不改动任何既有列、既有行、索引与关系，也不做任何数据搬运或文本回填。

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN "category" TEXT;

-- AlterTable
ALTER TABLE "RecipeIngredient" ADD COLUMN "amountText" TEXT;

-- AlterTable
ALTER TABLE "RecipeStep" ADD COLUMN "title" TEXT;

-- AlterTable
ALTER TABLE "RecipeStep" ADD COLUMN "timerMinutes" INTEGER;
