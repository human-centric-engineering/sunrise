-- A pending erasure (t-842): the intent recorded on the user row, with the
-- account disabled, before any erasure work starts. The row's delete takes
-- these with it; `data_erasure_receipt` records that the erasure finished.
-- `erasureNextAttemptAt` is the retrier's lease and backoff, so it is indexed
-- for the maintenance tick's claim.

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "erasureAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "erasureNextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "erasureReason" TEXT,
ADD COLUMN     "erasureRequestedAt" TIMESTAMP(3),
ADD COLUMN     "erasureRequestedBy" TEXT;

-- CreateIndex
CREATE INDEX "user_erasureNextAttemptAt_idx" ON "user"("erasureNextAttemptAt");
