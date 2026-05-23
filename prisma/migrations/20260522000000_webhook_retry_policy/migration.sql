-- Per-subscription retry policy: maxAttempts + retryBackoffMs.
-- Replaces the hardcoded MAX_ATTEMPTS / RETRY_DELAYS_MS module constants
-- in lib/orchestration/webhooks/dispatcher.ts.

ALTER TABLE "ai_webhook_subscription"
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "retryBackoffMs" INTEGER[] NOT NULL DEFAULT ARRAY[10000, 60000, 300000]::INTEGER[];
