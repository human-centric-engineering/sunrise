-- CreateTable
CREATE TABLE "ai_experiment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "agentId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_experiment_variant" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "agentVersionId" TEXT,
    "evaluationSessionId" TEXT,
    "label" TEXT NOT NULL,
    "score" DOUBLE PRECISION,

    CONSTRAINT "ai_experiment_variant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_experiment_agentId_idx" ON "ai_experiment"("agentId");

-- CreateIndex
CREATE INDEX "ai_experiment_status_idx" ON "ai_experiment"("status");

-- CreateIndex
CREATE INDEX "ai_experiment_variant_experimentId_idx" ON "ai_experiment_variant"("experimentId");

-- AddForeignKey
ALTER TABLE "ai_experiment" ADD CONSTRAINT "ai_experiment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_experiment" ADD CONSTRAINT "ai_experiment_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_experiment_variant" ADD CONSTRAINT "ai_experiment_variant_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "ai_experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
