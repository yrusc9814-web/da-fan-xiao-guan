-- Google2 购物清单自由规格（amountText）与可空结构化数量单位。
-- SQLite 不能就地放宽 NOT NULL，按标准表重建流程迁移；存量行 100% 原样复制，
-- 新增 amountText 一律为 NULL（不猜测历史自由规格文本）。

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_ShoppingListItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shoppingListId" TEXT NOT NULL,
    "ingredientId" TEXT,
    "ingredientNameSnapshot" TEXT NOT NULL,
    "quantity" REAL,
    "unit" TEXT,
    "amountText" TEXT,
    "category" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShoppingListItem_shoppingListId_fkey" FOREIGN KEY ("shoppingListId") REFERENCES "ShoppingList" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ShoppingListItem_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_ShoppingListItem" (
    "id",
    "shoppingListId",
    "ingredientId",
    "ingredientNameSnapshot",
    "quantity",
    "unit",
    "amountText",
    "category",
    "sourceType",
    "sourceId",
    "completed",
    "sortOrder",
    "notes",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    "shoppingListId",
    "ingredientId",
    "ingredientNameSnapshot",
    "quantity",
    "unit",
    NULL,
    NULL,
    "sourceType",
    "sourceId",
    "completed",
    "sortOrder",
    "notes",
    "createdAt",
    "updatedAt"
FROM "ShoppingListItem";

DROP TABLE "ShoppingListItem";

ALTER TABLE "new_ShoppingListItem" RENAME TO "ShoppingListItem";

CREATE INDEX "ShoppingListItem_shoppingListId_completed_sortOrder_idx" ON "ShoppingListItem"("shoppingListId", "completed", "sortOrder");

CREATE INDEX "ShoppingListItem_ingredientId_idx" ON "ShoppingListItem"("ingredientId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
