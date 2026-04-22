-- CreateTable
CREATE TABLE "ai_provider_profile" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tierRole" TEXT NOT NULL,
    "modelFamilies" TEXT[],
    "reasoningDepth" TEXT NOT NULL,
    "latency" TEXT NOT NULL,
    "costEfficiency" TEXT NOT NULL,
    "contextLength" TEXT NOT NULL,
    "toolUse" TEXT NOT NULL,
    "bestRole" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_profile_slug_key" ON "ai_provider_profile"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_profile_name_key" ON "ai_provider_profile"("name");

-- CreateIndex
CREATE INDEX "ai_provider_profile_createdBy_idx" ON "ai_provider_profile"("createdBy");

-- CreateIndex
CREATE INDEX "ai_provider_profile_isActive_idx" ON "ai_provider_profile"("isActive");

-- CreateIndex
CREATE INDEX "ai_provider_profile_tierRole_idx" ON "ai_provider_profile"("tierRole");

-- AddForeignKey
ALTER TABLE "ai_provider_profile" ADD CONSTRAINT "ai_provider_profile_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
