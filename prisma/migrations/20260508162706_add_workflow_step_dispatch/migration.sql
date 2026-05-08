-- Workflow step dispatch cache for crash-safe re-runs.
-- See `.context/orchestration/workflows.md` (Idempotency section) and
-- `lib/orchestration/engine/dispatch-cache.ts` for the lookup/record contract.
--
-- Risky executors (external_call, send_notification, tool_call) compute a
-- deterministic idempotency key per dispatch — `${executionId}:${stepId}`
-- (single-shot) or `${executionId}:${stepId}:turn=${N}` (multi-turn) — and
-- call recordDispatch after the side effect completes. On re-drive after a
-- crash, lookupDispatch hits the cached result and the executor returns it
-- without re-firing. The UNIQUE constraint on idempotencyKey is the dedup
-- gate — two hosts racing on the same key see exactly one winner.
--
-- The `isIdempotent` flag on AiCapability lets capability authors opt out of
-- the cache for capabilities that are naturally safe to re-run (destination
-- handles duplicates), avoiding a DB write per call. Default false: assume
-- side effects until opted in.
--
-- Strict additive change. Existing AiCapability rows pick up isIdempotent=false,
-- which preserves prior behaviour (every call recorded). The new table is
-- empty until the executor wiring lands in a follow-up commit.

ALTER TABLE "ai_capability"
  ADD COLUMN "isIdempotent" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ai_workflow_step_dispatch" (
  "id"             TEXT NOT NULL,
  "executionId"    TEXT NOT NULL,
  "stepId"         TEXT NOT NULL,
  "turnIndex"      INTEGER,
  "idempotencyKey" TEXT NOT NULL,
  "result"         JSONB NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_workflow_step_dispatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_workflow_step_dispatch_idempotencyKey_key"
  ON "ai_workflow_step_dispatch" ("idempotencyKey");

CREATE INDEX "ai_workflow_step_dispatch_executionId_stepId_idx"
  ON "ai_workflow_step_dispatch" ("executionId", "stepId");

CREATE INDEX "ai_workflow_step_dispatch_createdAt_idx"
  ON "ai_workflow_step_dispatch" ("createdAt");

ALTER TABLE "ai_workflow_step_dispatch"
  ADD CONSTRAINT "ai_workflow_step_dispatch_executionId_fkey"
  FOREIGN KEY ("executionId") REFERENCES "ai_workflow_execution"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
