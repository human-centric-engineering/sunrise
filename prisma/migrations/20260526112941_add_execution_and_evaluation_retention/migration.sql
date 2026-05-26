-- Retention windows for workflow-execution history and evaluation history.
-- Both nullable: null = keep forever (matches the existing retention columns).
-- Enforced by lib/orchestration/retention.ts via the maintenance tick.
ALTER TABLE "ai_orchestration_settings" ADD COLUMN     "evaluationRetentionDays" INTEGER,
ADD COLUMN     "executionRetentionDays" INTEGER;
