-- Lease-pair coherence: enforce at the storage boundary that `leaseToken` and
-- `leaseExpiresAt` are co-set or co-cleared. The four engine write paths
-- (`claimLease`, `markCurrentStep`/`checkpoint` lease refresh, `pauseForApproval`,
-- `finalize`, `drainEngine` crash-repair) all maintain this invariant by convention,
-- but the schema previously expressed nothing — a partial-state write from a future
-- contributor's bug, an admin SQL fix, or a backfill script could leave a row
-- "leased without expiry" or vice versa. The orphan sweep filters on `leaseExpiresAt
-- < now`, so a row with `leaseToken` set but `leaseExpiresAt = NULL` would be silently
-- stuck — never picked up.
--
-- This is a metadata-only DDL change. Existing rows already comply (every write path
-- sets both fields together or clears both together). No backfill required.

ALTER TABLE "ai_workflow_execution"
  ADD CONSTRAINT "ai_workflow_execution_lease_pair_coherent"
  CHECK (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL));
