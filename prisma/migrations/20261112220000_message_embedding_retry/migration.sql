-- t-1016 (§127): when the embedding backfill may next try a reply whose
-- embedding failed or was refused, and how many attempts in a row have.
--
-- Both empty for every existing message: never failed. The backfill reads
-- replies that never failed first, then failed ones whose retry time has
-- come, and each failure doubles the wait (15 minutes, then 30, an hour...,
-- up to a week), so no failure can fill its batch and hold older replies
-- back, and a reply that can never be embedded settles to one try a week.

-- AlterTable
ALTER TABLE "ai_message" ADD COLUMN     "embeddingFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "embeddingRetryAt" TIMESTAMP(3);
