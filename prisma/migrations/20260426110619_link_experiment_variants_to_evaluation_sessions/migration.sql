-- DropIndex
DROP INDEX "ai_agent_isActive_idx";

-- DropIndex
DROP INDEX "ai_agent_visibility_idx";

-- DropIndex
DROP INDEX "ai_agent_embed_token_token_idx";

-- DropIndex
DROP INDEX "ai_agent_invite_token_token_idx";

-- DropIndex
DROP INDEX "ai_agent_version_agentId_idx";

-- CreateIndex
CREATE INDEX "ai_agent_isActive_visibility_idx" ON "ai_agent"("isActive", "visibility");

-- CreateIndex
CREATE INDEX "ai_experiment_variant_evaluationSessionId_idx" ON "ai_experiment_variant"("evaluationSessionId");

-- AddForeignKey
ALTER TABLE "ai_experiment_variant" ADD CONSTRAINT "ai_experiment_variant_evaluationSessionId_fkey" FOREIGN KEY ("evaluationSessionId") REFERENCES "ai_evaluation_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
