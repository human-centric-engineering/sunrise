-- Add a dedicated retention window for `exhausted` (DLQ) webhook
-- deliveries. Null falls back to webhookRetentionDays so existing
-- deployments keep the unified behaviour.

ALTER TABLE "ai_orchestration_settings"
  ADD COLUMN "webhookDlqRetentionDays" INTEGER;
