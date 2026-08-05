-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "appName" TEXT NOT NULL DEFAULT '搭饭小馆',
    "subtitle" TEXT NOT NULL DEFAULT '让每一餐都更美好',
    "userNickname" TEXT,
    "userAvatarPath" TEXT,
    "pinHash" TEXT,
    "pinEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultPort" INTEGER NOT NULL DEFAULT 8787,
    "autoBackupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "autoDeductInventory" BOOLEAN NOT NULL DEFAULT false,
    "defaultRepeatDays" INTEGER NOT NULL DEFAULT 0,
    "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "imagePath" TEXT,
    "ingredientsText" TEXT,
    "cookingTimeMinutes" INTEGER,
    "difficulty" TEXT,
    "spicyLevel" INTEGER,
    "servings" INTEGER,
    "sourceNote" TEXT,
    "notes" TEXT,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "enabledForRecommendation" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RecipeIngredient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "ingredientId" TEXT,
    "ingredientNameSnapshot" TEXT NOT NULL,
    "quantity" REAL,
    "unit" TEXT,
    "optional" BOOLEAN NOT NULL DEFAULT false,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecipeIngredient_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RecipeIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecipeStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "imagePath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecipeStep_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'GENERAL',
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RecipeTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecipeTag_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RecipeTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecipeMealType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "mealType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecipeMealType_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "imagePath" TEXT,
    "category" TEXT,
    "quantity" REAL NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'OTHER',
    "purchaseDate" TEXT,
    "expiryDate" TEXT,
    "location" TEXT,
    "minStock" REAL,
    "opened" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "InventoryLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ingredientId" TEXT,
    "ingredientNameSnapshot" TEXT NOT NULL,
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
    CONSTRAINT "InventoryLog_relatedPlanId_fkey" FOREIGN KEY ("relatedPlanId") REFERENCES "MealPlan" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InventoryLog_relatedRecordId_fkey" FOREIGN KEY ("relatedRecordId") REFERENCES "MealRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KitchenTool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "imagePath" TEXT,
    "category" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RecipeTool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "toolId" TEXT,
    "toolNameSnapshot" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecipeTool_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RecipeTool_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "KitchenTool" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "imagePath" TEXT,
    "address" TEXT,
    "storeType" TEXT,
    "cuisine" TEXT,
    "averageCost" REAL,
    "supportsDineIn" BOOLEAN NOT NULL DEFAULT false,
    "supportsTakeout" BOOLEAN NOT NULL DEFAULT false,
    "contact" TEXT,
    "businessHours" TEXT,
    "rating" REAL,
    "recommendedDishes" TEXT,
    "avoidDishes" TEXT,
    "tagsText" TEXT,
    "notes" TEXT,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Diner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "avatarPath" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "likesText" TEXT,
    "dislikesText" TEXT,
    "tabooText" TEXT,
    "allergyText" TEXT,
    "portionNote" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MealPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planDate" TEXT NOT NULL,
    "mealType" TEXT NOT NULL,
    "dinerCount" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'UNPLANNED',
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MealPlanItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mealPlanId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "recipeId" TEXT,
    "storeId" TEXT,
    "customName" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MealPlanItem_mealPlanId_fkey" FOREIGN KEY ("mealPlanId") REFERENCES "MealPlan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MealPlanItem_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MealPlanItem_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MealPlanDiner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mealPlanId" TEXT NOT NULL,
    "dinerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MealPlanDiner_mealPlanId_fkey" FOREIGN KEY ("mealPlanId") REFERENCES "MealPlan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MealPlanDiner_dinerId_fkey" FOREIGN KEY ("dinerId") REFERENCES "Diner" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MealRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordDate" TEXT NOT NULL,
    "recordTime" TEXT,
    "mealType" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "imagePath" TEXT,
    "rating" REAL,
    "isNewTry" BOOLEAN NOT NULL DEFAULT false,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "relatedPlanId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MealRecord_relatedPlanId_fkey" FOREIGN KEY ("relatedPlanId") REFERENCES "MealPlan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MealRecordItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mealRecordId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "recipeId" TEXT,
    "storeId" TEXT,
    "customName" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MealRecordItem_mealRecordId_fkey" FOREIGN KEY ("mealRecordId") REFERENCES "MealRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MealRecordItem_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MealRecordItem_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MealRecordDiner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mealRecordId" TEXT NOT NULL,
    "dinerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MealRecordDiner_mealRecordId_fkey" FOREIGN KEY ("mealRecordId") REFERENCES "MealRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MealRecordDiner_dinerId_fkey" FOREIGN KEY ("dinerId") REFERENCES "Diner" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecommendationHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recommendationType" TEXT NOT NULL,
    "resultType" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "filtersJson" TEXT NOT NULL,
    "candidateCount" INTEGER NOT NULL,
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "addedToPlan" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShoppingList" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShoppingListItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shoppingListId" TEXT NOT NULL,
    "ingredientId" TEXT,
    "ingredientNameSnapshot" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "unit" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "DeletedItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Recipe_name_idx" ON "Recipe"("name");

-- CreateIndex
CREATE INDEX "Recipe_deletedAt_idx" ON "Recipe"("deletedAt");

-- CreateIndex
CREATE INDEX "Recipe_favorite_idx" ON "Recipe"("favorite");

-- CreateIndex
CREATE INDEX "RecipeIngredient_recipeId_sortOrder_idx" ON "RecipeIngredient"("recipeId", "sortOrder");

-- CreateIndex
CREATE INDEX "RecipeIngredient_ingredientId_idx" ON "RecipeIngredient"("ingredientId");

-- CreateIndex
CREATE INDEX "RecipeStep_recipeId_stepNo_idx" ON "RecipeStep"("recipeId", "stepNo");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeStep_recipeId_stepNo_key" ON "RecipeStep"("recipeId", "stepNo");

-- CreateIndex
CREATE INDEX "Tag_deletedAt_idx" ON "Tag"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_type_key" ON "Tag"("name", "type");

-- CreateIndex
CREATE INDEX "RecipeTag_tagId_idx" ON "RecipeTag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeTag_recipeId_tagId_key" ON "RecipeTag"("recipeId", "tagId");

-- CreateIndex
CREATE INDEX "RecipeMealType_mealType_idx" ON "RecipeMealType"("mealType");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeMealType_recipeId_mealType_key" ON "RecipeMealType"("recipeId", "mealType");

-- CreateIndex
CREATE INDEX "Ingredient_name_idx" ON "Ingredient"("name");

-- CreateIndex
CREATE INDEX "Ingredient_expiryDate_idx" ON "Ingredient"("expiryDate");

-- CreateIndex
CREATE INDEX "Ingredient_deletedAt_idx" ON "Ingredient"("deletedAt");

-- CreateIndex
CREATE INDEX "Ingredient_category_idx" ON "Ingredient"("category");

-- CreateIndex
CREATE INDEX "InventoryLog_ingredientId_createdAt_idx" ON "InventoryLog"("ingredientId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryLog_relatedPlanId_idx" ON "InventoryLog"("relatedPlanId");

-- CreateIndex
CREATE INDEX "InventoryLog_relatedRecordId_idx" ON "InventoryLog"("relatedRecordId");

-- CreateIndex
CREATE INDEX "KitchenTool_name_idx" ON "KitchenTool"("name");

-- CreateIndex
CREATE INDEX "KitchenTool_deletedAt_idx" ON "KitchenTool"("deletedAt");

-- CreateIndex
CREATE INDEX "RecipeTool_recipeId_idx" ON "RecipeTool"("recipeId");

-- CreateIndex
CREATE INDEX "RecipeTool_toolId_idx" ON "RecipeTool"("toolId");

-- CreateIndex
CREATE INDEX "Store_name_idx" ON "Store"("name");

-- CreateIndex
CREATE INDEX "Store_storeType_idx" ON "Store"("storeType");

-- CreateIndex
CREATE INDEX "Store_deletedAt_idx" ON "Store"("deletedAt");

-- CreateIndex
CREATE INDEX "Store_favorite_idx" ON "Store"("favorite");

-- CreateIndex
CREATE INDEX "Diner_name_idx" ON "Diner"("name");

-- CreateIndex
CREATE INDEX "Diner_active_idx" ON "Diner"("active");

-- CreateIndex
CREATE INDEX "MealPlan_planDate_idx" ON "MealPlan"("planDate");

-- CreateIndex
CREATE INDEX "MealPlan_status_idx" ON "MealPlan"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MealPlan_planDate_mealType_key" ON "MealPlan"("planDate", "mealType");

-- CreateIndex
CREATE INDEX "MealPlanItem_mealPlanId_sortOrder_idx" ON "MealPlanItem"("mealPlanId", "sortOrder");

-- CreateIndex
CREATE INDEX "MealPlanItem_recipeId_idx" ON "MealPlanItem"("recipeId");

-- CreateIndex
CREATE INDEX "MealPlanItem_storeId_idx" ON "MealPlanItem"("storeId");

-- CreateIndex
CREATE INDEX "MealPlanDiner_dinerId_idx" ON "MealPlanDiner"("dinerId");

-- CreateIndex
CREATE UNIQUE INDEX "MealPlanDiner_mealPlanId_dinerId_key" ON "MealPlanDiner"("mealPlanId", "dinerId");

-- CreateIndex
CREATE INDEX "MealRecord_recordDate_idx" ON "MealRecord"("recordDate");

-- CreateIndex
CREATE INDEX "MealRecord_mealType_recordDate_idx" ON "MealRecord"("mealType", "recordDate");

-- CreateIndex
CREATE INDEX "MealRecord_deletedAt_idx" ON "MealRecord"("deletedAt");

-- CreateIndex
CREATE INDEX "MealRecordItem_mealRecordId_sortOrder_idx" ON "MealRecordItem"("mealRecordId", "sortOrder");

-- CreateIndex
CREATE INDEX "MealRecordItem_recipeId_idx" ON "MealRecordItem"("recipeId");

-- CreateIndex
CREATE INDEX "MealRecordItem_storeId_idx" ON "MealRecordItem"("storeId");

-- CreateIndex
CREATE INDEX "MealRecordDiner_dinerId_idx" ON "MealRecordDiner"("dinerId");

-- CreateIndex
CREATE UNIQUE INDEX "MealRecordDiner_mealRecordId_dinerId_key" ON "MealRecordDiner"("mealRecordId", "dinerId");

-- CreateIndex
CREATE INDEX "RecommendationHistory_recommendationType_createdAt_idx" ON "RecommendationHistory"("recommendationType", "createdAt");

-- CreateIndex
CREATE INDEX "ShoppingList_status_idx" ON "ShoppingList"("status");

-- CreateIndex
CREATE INDEX "ShoppingList_deletedAt_idx" ON "ShoppingList"("deletedAt");

-- CreateIndex
CREATE INDEX "ShoppingListItem_shoppingListId_completed_sortOrder_idx" ON "ShoppingListItem"("shoppingListId", "completed", "sortOrder");

-- CreateIndex
CREATE INDEX "ShoppingListItem_ingredientId_idx" ON "ShoppingListItem"("ingredientId");

-- CreateIndex
CREATE INDEX "DeletedItem_expiresAt_idx" ON "DeletedItem"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeletedItem_entityType_entityId_key" ON "DeletedItem"("entityType", "entityId");
