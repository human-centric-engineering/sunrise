-- CreateTable
CREATE TABLE "ai_workflow_schedule" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cronExpression" VARCHAR(100) NOT NULL,
    "inputTemplate" JSONB NOT NULL DEFAULT '{}',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_workflow_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_workflow_schedule_workflowId_idx" ON "ai_workflow_schedule"("workflowId");

-- CreateIndex
CREATE INDEX "ai_workflow_schedule_isEnabled_nextRunAt_idx" ON "ai_workflow_schedule"("isEnabled", "nextRunAt");

-- AddForeignKey
ALTER TABLE "ai_workflow_schedule" ADD CONSTRAINT "ai_workflow_schedule_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ai_workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_schedule" ADD CONSTRAINT "ai_workflow_schedule_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
