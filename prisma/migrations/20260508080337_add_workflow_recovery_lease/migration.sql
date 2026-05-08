-- Workflow execution recovery: lease + heartbeat for crash-survival.
-- See .context/orchestration/engine.md (Recovery model section) and
-- `lib/orchestration/engine/lease.ts` for the lease semantics.
--
-- Strict additive change. Existing rows pick up NULL lease columns and
-- recoveryAttempts=0; the orphan sweep only touches rows where status='running'
-- AND leaseExpiresAt < now(), so legacy rows (NULL leaseExpiresAt, status not
-- running, or completed/failed) are never picked up.

ALTER TABLE "ai_workflow_execution"
  ADD COLUMN "leaseToken"       TEXT,
  ADD COLUMN "leaseExpiresAt"   TIMESTAMP(3),
  ADD COLUMN "lastHeartbeatAt"  TIMESTAMP(3),
  ADD COLUMN "recoveryAttempts" INTEGER NOT NULL DEFAULT 0;

-- Orphan sweep query: WHERE status='running' AND leaseExpiresAt < now().
CREATE INDEX "ai_workflow_execution_status_leaseExpiresAt_idx"
  ON "ai_workflow_execution" ("status", "leaseExpiresAt");
