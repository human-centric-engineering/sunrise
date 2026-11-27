-- §139 t-1094: the billing webhook's event ledger; three fields the webhook
-- keeps on each org's subscription record; and one org per provider customer.
--
-- `billing_webhook_event` records each provider event id once, in the same
-- transaction as the change it made, so a replayed delivery changes nothing.
-- Nothing writes a row until `BILLING_PROVIDER` is set and the provider sends
-- an event, so applying this changes nothing for any org.
--
-- The table is tenant-owned and takes the `org_isolation` policy
-- (lib/tenancy/isolation.ts orgIsolationPolicySql(), verbatim). As with
-- 20261127090000_org_billing_subscription, an install that has already run
-- `db:tenancy:enable` would otherwise get this table with RLS off until the
-- switch was re-run, so the block at the end enables and forces it when the
-- install's tenant-owned tables already are (read off `ai_agent`). At
-- `single` nothing is set.

-- AlterTable
ALTER TABLE "org_billing_subscription" ADD COLUMN "providerStatus" TEXT,
ADD COLUMN "providerLive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;

-- A provider's customer belongs to one org: the webhook finds the org by it.
-- CreateIndex
CREATE UNIQUE INDEX "org_billing_subscription_provider_customerRef_key" ON "org_billing_subscription"("provider", "customerRef");

-- CreateTable
CREATE TABLE "billing_webhook_event" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_webhook_event_orgId_idx" ON "billing_webhook_event"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_webhook_event_provider_eventId_key" ON "billing_webhook_event"("provider", "eventId");

-- AddForeignKey
ALTER TABLE "billing_webhook_event" ADD CONSTRAINT "billing_webhook_event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- billing_webhook_event
CREATE POLICY "org_isolation" ON "billing_webhook_event"
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
    ALTER TABLE "billing_webhook_event" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "billing_webhook_event" FORCE ROW LEVEL SECURITY;
  END IF;
END
$$;
