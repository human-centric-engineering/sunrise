-- Add deploymentProfiles to AiProviderModel
--
-- This migration splits "deployment locus" out of `tierRole` to fix a
-- structural taxonomy mistake: the tierRole enum was packing capability
-- depth (thinking/worker), role-in-deployment (infrastructure /
-- control_plane), deployment locus (local_sovereign), and modality
-- (embedding) into one column. A model like Qwen2.5-72B is legitimately
-- worker-tier AND sovereign-deployable AND chat-capable — the old enum
-- forced a single false choice.
--
-- This migration is non-destructive at the row level: it adds a new
-- column with a backfill, then re-classifies rows that used the now-
-- removed `local_sovereign` tierRole. No rows are dropped.
--
-- Forward compat: this migration runs idempotently. Re-running on a
-- DB that has already been migrated is a no-op.
--
-- Reference: .context/orchestration/meta/architectural-decisions.md §3.11

-- 1. Add the new column with the default ["hosted"] backfill.
ALTER TABLE "ai_provider_model"
  ADD COLUMN IF NOT EXISTS "deploymentProfiles" TEXT[] NOT NULL DEFAULT ARRAY['hosted'];

-- 2. Re-classify rows that previously used `tierRole='local_sovereign'`.
--    `local_sovereign` was always a deployment-locus signal masquerading as
--    a tier classification. The right primary tier for these rows is
--    `worker` (general-purpose chat for everyday tasks); admins can re-tier
--    to `thinking` for specific high-capability open-weight models via
--    the audit workflow. The deploymentProfiles array carries the
--    sovereignty signal going forward.
UPDATE "ai_provider_model"
SET
  "tierRole" = 'worker',
  "deploymentProfiles" = ARRAY['sovereign']
WHERE "tierRole" = 'local_sovereign';

-- 3. Belt-and-braces: any row with `local = true` that still says
--    `deploymentProfiles = ['hosted']` (which should be impossible after
--    step 2, but covers operator-edited rows that set `local` without
--    going through the audit workflow) gets the sovereign profile too.
--    Idempotent — does nothing on a clean migration.
UPDATE "ai_provider_model"
SET "deploymentProfiles" = ARRAY['sovereign']
WHERE "local" = true
  AND "deploymentProfiles" = ARRAY['hosted'];
