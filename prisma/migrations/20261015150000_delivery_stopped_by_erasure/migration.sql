-- t-809: an erasure's stop on a delivery gets its own column, instead of
-- living only as a "(not retried: …)" suffix on the free-text "lastError".
ALTER TABLE "ai_webhook_delivery" ADD COLUMN "stoppedByErasure" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ai_event_hook_delivery" ADD COLUMN "stoppedByErasure" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: rows an erasure already stopped carry notRetried()'s wording for
-- one of the two erasure reasons (lib/orchestration/webhooks/not-retried.ts),
-- either as the whole "lastError" or as its suffix. The same test
-- isStoppedByErasure() applied before this column existed.
UPDATE "ai_webhook_delivery"
   SET "stoppedByErasure" = true
 WHERE "lastError" IN ('Not retried: subject erased', 'Not retried: recipient erased')
    OR "lastError" LIKE '% (not retried: subject erased)'
    OR "lastError" LIKE '% (not retried: recipient erased)';

UPDATE "ai_event_hook_delivery"
   SET "stoppedByErasure" = true
 WHERE "lastError" IN ('Not retried: subject erased', 'Not retried: recipient erased')
    OR "lastError" LIKE '% (not retried: subject erased)'
    OR "lastError" LIKE '% (not retried: recipient erased)';
