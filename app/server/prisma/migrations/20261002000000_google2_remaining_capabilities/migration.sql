-- Google 2.0 第二轮剩余能力补齐（仅后端数据契约；前端已冻结，不改 DOM/CSS/SoT）。
--
-- 事实来源：谷歌2.0版本/index.html（冻结 UI）
--   * 计划卡与打卡链路消费 plan.time / plan.title / plan.subtext / plan.icon：
--       - plan.time 来自 #planPickerTimeVal（"HH:MM"，isValidBentoTime 校验 ^(?:[01]\d|2[0-3]):[0-5]\d$）；
--       - plan.title / plan.subtext / plan.icon 由 PlanPicker 依据目标菜谱/店铺生成后落入计划对象；
--       - 打卡生成日记时 notes 引用 plan.subtext、记录 icon 取自 plan.icon（index.html:4757-4758）。
--       MealPlan 现有列只能承载 notes/status，无法无损承载四者，且现有 plan completion 链路没有撤销能力，
--       本迁移只为字段落库提供列，不宣称任何功能已完成。
--   * #formToolIcon（select）提交设备 emoji 图标，KitchenTool 无承载列。
--   * 记录表单有 3 个相框（photoSlotView-0..2），计划打卡/存档走多图；MealRecord 只有单 imagePath。
--     多图以下列 photosJson 承接，旧单图 imagePath 语义保持不变：
--       - photosJson 为可空 TEXT，规范值为 JSON 字符串数组（有序存储路径，第 1 张为封面，最多 3 张）；
--       - NULL 表示"未记录过多图列表"，读取侧回退旧单图 => imagePath ? [imagePath] : []；
--       - 清空全部照片为 NULL + imagePath NULL，绝不写 '' 或 '[]' 假数据，条目不得为 base64/dataURL。
--
-- 本迁移为纯追加列：
--   * 六个列全部可空且不设 DEFAULT，历史行保持真正的 NULL（不写入推测性时间/标题/副文案/图标/照片）；
--   * NULL 表示"用户未填写"，与其他真实输入的 0/空列表语义区分；
--   * 不改动任何既有列、既有行、索引与关系，也不做任何数据搬运或文本回填。

-- AlterTable
ALTER TABLE "MealPlan" ADD COLUMN "time" TEXT;

-- AlterTable
ALTER TABLE "MealPlan" ADD COLUMN "title" TEXT;

-- AlterTable
ALTER TABLE "MealPlan" ADD COLUMN "subtext" TEXT;

-- AlterTable
ALTER TABLE "MealPlan" ADD COLUMN "icon" TEXT;

-- AlterTable
ALTER TABLE "KitchenTool" ADD COLUMN "icon" TEXT;

-- AlterTable
ALTER TABLE "MealRecord" ADD COLUMN "photosJson" TEXT;
