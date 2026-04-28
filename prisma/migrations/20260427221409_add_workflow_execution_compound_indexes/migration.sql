-- CreateIndex
CREATE INDEX "ai_workflow_slug_isActive_idx" ON "ai_workflow"("slug", "isActive");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_status_startedAt_idx" ON "ai_workflow_execution"("status", "startedAt");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_status_createdAt_idx" ON "ai_workflow_execution"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_status_updatedAt_idx" ON "ai_workflow_execution"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_userId_status_createdAt_idx" ON "ai_workflow_execution"("userId", "status", "createdAt");
