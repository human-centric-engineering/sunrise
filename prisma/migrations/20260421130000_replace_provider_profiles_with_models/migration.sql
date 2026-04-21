-- Replace AiProviderProfile (provider-level) with AiProviderModel (model-level)

-- 1. Create the new model-level table
CREATE TABLE "ai_provider_model" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "providerSlug" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    "capabilities" TEXT[] DEFAULT ARRAY['chat']::TEXT[],
    "tierRole" TEXT NOT NULL,

    "reasoningDepth" TEXT NOT NULL,
    "latency" TEXT NOT NULL,
    "costEfficiency" TEXT NOT NULL,
    "contextLength" TEXT NOT NULL,
    "toolUse" TEXT NOT NULL,
    "bestRole" TEXT NOT NULL,

    "dimensions" INTEGER,
    "schemaCompatible" BOOLEAN,
    "costPerMillionTokens" DOUBLE PRECISION,
    "hasFreeTier" BOOLEAN,
    "local" BOOLEAN NOT NULL DEFAULT false,
    "quality" TEXT,
    "strengths" TEXT,
    "setup" TEXT,

    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_model_pkey" PRIMARY KEY ("id")
);

-- 2. Migrate any admin-customised rows (isDefault = false) from the old table
INSERT INTO "ai_provider_model" (
    "id", "slug", "providerSlug", "modelId", "name", "description",
    "capabilities", "tierRole", "reasoningDepth", "latency", "costEfficiency",
    "contextLength", "toolUse", "bestRole",
    "isDefault", "isActive", "metadata", "createdBy", "createdAt", "updatedAt"
)
SELECT
    "id",
    "slug",
    "slug" AS "providerSlug",
    "slug" AS "modelId",
    "name",
    "description",
    ARRAY['chat']::TEXT[] AS "capabilities",
    "tierRole",
    "reasoningDepth",
    "latency",
    "costEfficiency",
    "contextLength",
    "toolUse",
    "bestRole",
    false AS "isDefault",
    "isActive",
    "metadata",
    "createdBy",
    "createdAt",
    "updatedAt"
FROM "ai_provider_profile"
WHERE "isDefault" = false;

-- 3. Drop the old table
DROP TABLE "ai_provider_profile";

-- 4. Create indexes
CREATE UNIQUE INDEX "ai_provider_model_slug_key" ON "ai_provider_model"("slug");
CREATE UNIQUE INDEX "ai_provider_model_providerSlug_modelId_key" ON "ai_provider_model"("providerSlug", "modelId");
CREATE INDEX "ai_provider_model_createdBy_idx" ON "ai_provider_model"("createdBy");
CREATE INDEX "ai_provider_model_isActive_idx" ON "ai_provider_model"("isActive");
CREATE INDEX "ai_provider_model_tierRole_idx" ON "ai_provider_model"("tierRole");
CREATE INDEX "ai_provider_model_providerSlug_idx" ON "ai_provider_model"("providerSlug");

-- 5. Add foreign key
ALTER TABLE "ai_provider_model" ADD CONSTRAINT "ai_provider_model_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
