-- t-842 review: the retrier's queries filter on `erasureRequestedAt IS NOT
-- NULL`, so that is the column to index. `erasureNextAttemptAt` is null for
-- every user not being deleted, and its index served neither query.

-- DropIndex
DROP INDEX "user_erasureNextAttemptAt_idx";

-- CreateIndex
CREATE INDEX "user_erasureRequestedAt_idx" ON "user"("erasureRequestedAt");
