-- §139 t-1093: which plan each org is on.
--
-- `org_billing_subscription` holds one row per org: the app's plan key and,
-- once t-1094's provider is on, the subscription behind it. Nothing writes a
-- row until platform staff assign a plan, or a provider's webhook arrives, so
-- applying this changes nothing for any org.
--
-- The table is tenant-owned and takes the `org_isolation` policy
-- (lib/tenancy/isolation.ts orgIsolationPolicySql(), verbatim). As with
-- 20261118120000_org_provider_keys, an install that has already run
-- `db:tenancy:enable` would otherwise get this table with RLS off until the
-- switch was re-run, so the block at the end enables and forces it when the
-- install's tenant-owned tables already are (read off `ai_agent`). At
-- `single` nothing is set.

-- CreateEnum
CREATE TYPE "BillingSubscriptionStatus" AS ENUM ('INCOMPLETE', 'ACTIVE', 'PAST_DUE', 'ENDED');

-- CreateTable
CREATE TABLE "org_billing_subscription" (
    "id" TEXT NOT NULL,
    "planKey" TEXT,
    "provider" TEXT,
    "customerRef" TEXT,
    "subscriptionRef" TEXT,
    "status" "BillingSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "planAppliedAt" TIMESTAMP(3),
    "orgId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_billing_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_billing_subscription_orgId_key" ON "org_billing_subscription"("orgId");

-- AddForeignKey
ALTER TABLE "org_billing_subscription" ADD CONSTRAINT "org_billing_subscription_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- org_billing_subscription
CREATE POLICY "org_isolation" ON "org_billing_subscription"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "orgId" = NULLIF(current_setting('app.current_org', true), '')
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "orgId" = NULLIF(current_setting('app.current_org', true), '')
  );

-- Follow the install's tenancy switch (see the header).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = to_regclass(format('%I.ai_agent', current_schema())) AND relrowsecurity
  ) THEN
    ALTER TABLE "org_billing_subscription" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "org_billing_subscription" FORCE ROW LEVEL SECURITY;
  END IF;
END
$$;
