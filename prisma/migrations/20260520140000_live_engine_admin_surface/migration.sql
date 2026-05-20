-- Improvement #40: Stuck-execution / live-engine admin surface.
--
-- Adds two primitives the live-engine page needs to read:
--   1. `stuckExecutionThresholdMins` on the settings singleton — minutes
--      a running step may run before the row is highlighted as stuck.
--   2. `ai_workflow_execution_lease_event` — append-only history of
--      lease transitions so the lease inspector can answer "is the
--      engine restarting? has this row been claimed by multiple hosts?"
--
-- See `lib/orchestration/engine/lease.ts` (event writes) and
-- `lib/orchestration/admin/live-engine-snapshot.ts` (consumer).

-- AlterTable
ALTER TABLE "ai_orchestration_settings"
  ADD COLUMN "stuckExecutionThresholdMins" INTEGER NOT NULL DEFAULT 5;

-- CreateTable
CREATE TABLE "ai_workflow_execution_lease_event" (
  "id" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "leaseToken" TEXT,
  "reason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_workflow_execution_lease_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_workflow_execution_lease_event_executionId_createdAt_idx"
  ON "ai_workflow_execution_lease_event"("executionId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_lease_event_createdAt_idx"
  ON "ai_workflow_execution_lease_event"("createdAt");

-- AddForeignKey
ALTER TABLE "ai_workflow_execution_lease_event"
  ADD CONSTRAINT "ai_workflow_execution_lease_event_executionId_fkey"
  FOREIGN KEY ("executionId") REFERENCES "ai_workflow_execution"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
