-- CreateTable
CREATE TABLE "RecipeMealRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "mealRole" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecipeMealRole_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Existing recipes remain eligible for meal-set recommendation as a main dish.
INSERT INTO "RecipeMealRole" ("id", "recipeId", "mealRole", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), "id", 'MAIN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "Recipe" WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "RecipeMealRole_mealRole_idx" ON "RecipeMealRole"("mealRole");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeMealRole_recipeId_mealRole_key" ON "RecipeMealRole"("recipeId", "mealRole");
