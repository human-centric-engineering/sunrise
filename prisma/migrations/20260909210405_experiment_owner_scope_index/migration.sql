-- The experiments list filters on createdBy and sorts createdAt desc (#741).
--
-- Compound, but be clear about what that buys. It serves filter AND sort only
-- on the narrow clause `createdBy = $1`. Under the default policy a platform
-- admin takes the widened branch — `(createdBy = $1 OR createdBy IS NULL)`,
-- t-678 — which Postgres resolves as a BitmapOr; that loses index ordering, so
-- the sort is not served and the caller's matching set is sorted before LIMIT.
-- Still the right index: it keeps the scan off the whole table on both
-- branches, which is the part that grows.
CREATE INDEX "ai_experiment_createdBy_createdAt_idx" ON "ai_experiment"("createdBy", "createdAt");
