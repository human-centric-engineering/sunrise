-- CreateTable
CREATE TABLE "ai_agent_version" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changeSummary" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_agent_version_agentId_idx" ON "ai_agent_version"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_version_agentId_version_key" ON "ai_agent_version"("agentId", "version");

-- AddForeignKey
ALTER TABLE "ai_agent_version" ADD CONSTRAINT "ai_agent_version_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_version" ADD CONSTRAINT "ai_agent_version_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
