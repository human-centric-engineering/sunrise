-- AlterTable
ALTER TABLE "ai_agent" ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'internal';

-- CreateIndex
CREATE INDEX "ai_agent_visibility_idx" ON "ai_agent"("visibility");
