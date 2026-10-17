-- t-822: a send generation on each webhook delivery, bumped by a manual retry
-- or DLQ replay and never by an automatic retry. An email delivery's Resend
-- idempotency key names it, so a timed-out send Resend accepted is not sent
-- again by the automatic retry, while an admin's resend is a new send.

-- AlterTable
ALTER TABLE "ai_webhook_delivery" ADD COLUMN     "sendGeneration" INTEGER NOT NULL DEFAULT 0;
