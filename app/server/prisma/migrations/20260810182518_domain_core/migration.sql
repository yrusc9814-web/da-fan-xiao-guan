-- AlterTable
ALTER TABLE "Ingredient" ADD COLUMN "maxStock" REAL;

-- AlterTable
ALTER TABLE "MealPlan" ADD COLUMN "completedAt" DATETIME;
ALTER TABLE "MealPlan" ADD COLUMN "deletedAt" DATETIME;

-- AlterTable
ALTER TABLE "MealPlanItem" ADD COLUMN "mealRole" TEXT;

-- AlterTable
ALTER TABLE "MealRecordItem" ADD COLUMN "mealRole" TEXT;

-- CreateTable
CREATE TABLE "InventoryBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ingredientId" TEXT NOT NULL,
    "quantity" REAL NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "purchaseDate" TEXT,
    "expiryDate" TEXT,
    "location" TEXT,
    "opened" BOOLEAN NOT NULL DEFAULT false,
    "consumePriority" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InventoryBatch_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Preserve every pre-batch inventory row as its first batch. The legacy
-- Ingredient quantity fields remain available as a compatibility aggregate.
INSERT INTO "InventoryBatch" (
    "id", "ingredientId", "quantity", "unit", "purchaseDate", "expiryDate",
    "location", "opened", "consumePriority", "notes", "version",
    "createdAt", "updatedAt"
)
SELECT
    "id" || '-initial', "id", "quantity", "unit", "purchaseDate", "expiryDate",
    "location", "opened", false, "notes", "version", "createdAt", "updatedAt"
FROM "Ingredient";

-- CreateTable
CREATE TABLE "StoreMealType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "mealType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoreMealType_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConsumptionOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mealRecordId" TEXT NOT NULL,
    "previewHash" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsumptionOperation_mealRecordId_fkey" FOREIGN KEY ("mealRecordId") REFERENCES "MealRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UploadAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "thumbnailPath" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "recipeId" TEXT,
    "storeId" TEXT,
    "mealRecordId" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadAsset_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "UploadAsset_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "UploadAsset_mealRecordId_fkey" FOREIGN KEY ("mealRecordId") REFERENCES "MealRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_InventoryLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ingredientId" TEXT,
    "ingredientNameSnapshot" TEXT NOT NULL,
    "inventoryBatchId" TEXT,
    "beforeQuantity" REAL NOT NULL,
    "changeQuantity" REAL NOT NULL,
    "afterQuantity" REAL NOT NULL,
    "unit" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "relatedPlanId" TEXT,
    "relatedRecordId" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InventoryLog_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InventoryLog_inventoryBatchId_fkey" FOREIGN KEY ("inventoryBatchId") REFERENCES "InventoryBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InventoryLog_relatedPlanId_fkey" FOREIGN KEY ("relatedPlanId") REFERENCES "MealPlan" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InventoryLog_relatedRecordId_fkey" FOREIGN KEY ("relatedRecordId") REFERENCES "MealRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_InventoryLog" ("afterQuantity", "beforeQuantity", "changeQuantity", "changeType", "createdAt", "id", "ingredientId", "ingredientNameSnapshot", "inventoryBatchId", "notes", "relatedPlanId", "relatedRecordId", "unit", "updatedAt") SELECT "afterQuantity", "beforeQuantity", "changeQuantity", "changeType", "createdAt", "id", "ingredientId", "ingredientNameSnapshot", CASE WHEN "ingredientId" IS NULL THEN NULL ELSE "ingredientId" || '-initial' END, "notes", "relatedPlanId", "relatedRecordId", "unit", "updatedAt" FROM "InventoryLog";
DROP TABLE "InventoryLog";
ALTER TABLE "new_InventoryLog" RENAME TO "InventoryLog";
CREATE INDEX "InventoryLog_ingredientId_createdAt_idx" ON "InventoryLog"("ingredientId", "createdAt");
CREATE INDEX "InventoryLog_inventoryBatchId_createdAt_idx" ON "InventoryLog"("inventoryBatchId", "createdAt");
CREATE INDEX "InventoryLog_relatedPlanId_idx" ON "InventoryLog"("relatedPlanId");
CREATE INDEX "InventoryLog_relatedRecordId_idx" ON "InventoryLog"("relatedRecordId");
CREATE TABLE "new_MealRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordDate" TEXT NOT NULL,
    "recordTime" TEXT,
    "mealType" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "imagePath" TEXT,
    "rating" REAL,
    "isNewTry" BOOLEAN NOT NULL DEFAULT false,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "relatedPlanId" TEXT,
    "sourceMealPlanId" TEXT,
    "confirmedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MealRecord_relatedPlanId_fkey" FOREIGN KEY ("relatedPlanId") REFERENCES "MealPlan" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MealRecord_sourceMealPlanId_fkey" FOREIGN KEY ("sourceMealPlanId") REFERENCES "MealPlan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MealRecord" ("confirmedAt", "createdAt", "deletedAt", "favorite", "id", "imagePath", "isNewTry", "mealType", "notes", "rating", "recordDate", "recordTime", "relatedPlanId", "sourceType", "status", "updatedAt", "version") SELECT "updatedAt", "createdAt", "deletedAt", "favorite", "id", "imagePath", "isNewTry", "mealType", "notes", "rating", "recordDate", "recordTime", "relatedPlanId", "sourceType", 'CONFIRMED', "updatedAt", "version" FROM "MealRecord";
DROP TABLE "MealRecord";
ALTER TABLE "new_MealRecord" RENAME TO "MealRecord";
CREATE UNIQUE INDEX "MealRecord_sourceMealPlanId_key" ON "MealRecord"("sourceMealPlanId");
CREATE INDEX "MealRecord_recordDate_idx" ON "MealRecord"("recordDate");
CREATE INDEX "MealRecord_mealType_recordDate_idx" ON "MealRecord"("mealType", "recordDate");
CREATE INDEX "MealRecord_deletedAt_idx" ON "MealRecord"("deletedAt");
CREATE INDEX "MealRecord_status_recordDate_idx" ON "MealRecord"("status", "recordDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "InventoryBatch_ingredientId_deletedAt_idx" ON "InventoryBatch"("ingredientId", "deletedAt");

-- CreateIndex
CREATE INDEX "InventoryBatch_expiryDate_idx" ON "InventoryBatch"("expiryDate");

-- CreateIndex
CREATE INDEX "InventoryBatch_consumePriority_idx" ON "InventoryBatch"("consumePriority");

-- CreateIndex
CREATE INDEX "StoreMealType_mealType_idx" ON "StoreMealType"("mealType");

-- CreateIndex
CREATE UNIQUE INDEX "StoreMealType_storeId_mealType_key" ON "StoreMealType"("storeId", "mealType");

-- CreateIndex
CREATE INDEX "ConsumptionOperation_mealRecordId_createdAt_idx" ON "ConsumptionOperation"("mealRecordId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UploadAsset_filename_key" ON "UploadAsset"("filename");

-- CreateIndex
CREATE UNIQUE INDEX "UploadAsset_storagePath_key" ON "UploadAsset"("storagePath");

-- CreateIndex
CREATE INDEX "UploadAsset_deletedAt_idx" ON "UploadAsset"("deletedAt");

-- CreateIndex
CREATE INDEX "UploadAsset_sha256_idx" ON "UploadAsset"("sha256");

-- CreateIndex
CREATE INDEX "UploadAsset_recipeId_idx" ON "UploadAsset"("recipeId");

-- CreateIndex
CREATE INDEX "UploadAsset_storeId_idx" ON "UploadAsset"("storeId");

-- CreateIndex
CREATE INDEX "UploadAsset_mealRecordId_idx" ON "UploadAsset"("mealRecordId");

-- CreateIndex
CREATE INDEX "MealPlan_deletedAt_idx" ON "MealPlan"("deletedAt");
