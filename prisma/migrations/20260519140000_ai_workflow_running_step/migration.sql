-- In-flight step tracker. Replaces the per-execution scalar columns
-- (`currentStepLabel`, `currentStepType`, `currentStepStartedAt`,
-- `currentStepTurns`) with one row per running step. During a `parallel`
-- step's fan-out, every branch gets its own row — the previous scalar
-- model lost N-1 of N branches to last-writer-wins. The `currentStep`
-- column on `ai_workflow_execution` stays (it's the resume cursor).
--
-- `turns` carries the multi-turn checkpoint state for `agent_call` /
-- `orchestrator` / `reflect`. It's per-step here (not per-execution as
-- it was before), so a future workflow that nests multi-turn executors
-- inside a `parallel` doesn't silently lose state across branches.
CREATE TABLE "ai_workflow_running_step" (
  "id"          TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "stepId"      TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "stepType"    TEXT NOT NULL,
  "startedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "turns"       JSONB,
  CONSTRAINT "ai_workflow_running_step_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_workflow_running_step_executionId_stepId_key"
  ON "ai_workflow_running_step" ("executionId", "stepId");

CREATE INDEX "ai_workflow_running_step_executionId_idx"
  ON "ai_workflow_running_step" ("executionId");

ALTER TABLE "ai_workflow_running_step"
  ADD CONSTRAINT "ai_workflow_running_step_executionId_fkey"
  FOREIGN KEY ("executionId") REFERENCES "ai_workflow_execution"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from existing in-flight executions so the timeline doesn't
-- go dark on deploy. The engine only ever writes the scalar trio
-- (label/type/startedAt) together, so a populated label is the marker
-- for a usable row.
--
-- The id column is plain TEXT (Prisma CUIDs are app-side, not enforced
-- by the schema), so `gen_random_uuid()::text` is type-compatible.
-- Subsequent inserts via the Prisma client land as proper CUIDs.
INSERT INTO "ai_workflow_running_step" ("id", "executionId", "stepId", "label", "stepType", "startedAt", "turns")
SELECT
  gen_random_uuid()::text,
  "id",
  "currentStep",
  "currentStepLabel",
  "currentStepType",
  COALESCE("currentStepStartedAt", CURRENT_TIMESTAMP),
  "currentStepTurns"
FROM "ai_workflow_execution"
WHERE "status" IN ('pending', 'running', 'paused_for_approval')
  AND "currentStep" IS NOT NULL
  AND "currentStepLabel" IS NOT NULL
  AND "currentStepType" IS NOT NULL;

ALTER TABLE "ai_workflow_execution"
  DROP COLUMN "currentStepLabel",
  DROP COLUMN "currentStepType",
  DROP COLUMN "currentStepStartedAt",
  DROP COLUMN "currentStepTurns";
