-- DropIndex
DROP INDEX "idx_knowledge_embedding";

-- CreateTable
CREATE TABLE "ai_orchestration_settings" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL DEFAULT 'global',
    "defaultModels" JSONB NOT NULL,
    "globalMonthlyBudgetUsd" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_orchestration_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_orchestration_settings_slug_key" ON "ai_orchestration_settings"("slug");
