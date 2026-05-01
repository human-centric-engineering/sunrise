-- AlterTable
ALTER TABLE "ai_workflow" ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ai_workflow_isSystem_idx" ON "ai_workflow"("isSystem");
