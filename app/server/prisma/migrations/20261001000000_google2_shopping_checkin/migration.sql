-- CreateTable
CREATE TABLE "ShoppingCheckinOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shoppingListId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ShoppingCheckinOperation_shoppingListId_createdAt_idx" ON "ShoppingCheckinOperation"("shoppingListId", "createdAt");
