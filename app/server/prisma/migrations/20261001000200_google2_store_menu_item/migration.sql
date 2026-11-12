-- Google 2.0 正式店铺菜单（招牌菜单录入）：
-- 前端 #modalStoreForm / #formStoreMenuList 的 .store-dish-row 是动态行化菜单，
-- 每行含 菜名 + 真实单价 + 招牌标记，并可回填 name/price/icon/isSignature/desc 与行顺序。
-- Store.recommendedDishes (String?) 只能存拼接后的菜名摘要，无法无损承载该结构，
-- 因此新增独立子表 StoreMenuItem 承载菜单事实。
--
-- 本迁移是纯建表 / 建索引：
--   * 不改动 Store 及任何既有表结构与既有行；
--   * 不为历史店铺回填任何菜单数据（旧店铺菜单保持真正为空，由前端显示空态）；
--   * 已有行只在新表建立后由 API 层按需写入，数据库本身不做数据搬运。

-- CreateTable
CREATE TABLE "StoreMenuItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER,
    "icon" TEXT,
    "isSignature" BOOLEAN NOT NULL DEFAULT false,
    "desc" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoreMenuItem_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "StoreMenuItem_storeId_sortOrder_idx" ON "StoreMenuItem"("storeId", "sortOrder");
