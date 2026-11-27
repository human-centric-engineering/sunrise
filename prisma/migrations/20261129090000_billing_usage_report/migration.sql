-- §139 t-1097: usage reported to the payment provider once per billing
-- period, and the notices of the `warn` overage rule.
--
-- `billing_usage_report` holds one row per (org, meter, period start): counted
-- once after the period closes, recorded before it is sent.
-- `billing_usage_notice` holds one row per (org, meter, period start,
-- threshold), inserted before the notice is sent. `org_billing_subscription`
-- gains `endedAt`, so a subscription ended before its period's end closes the
-- period there. Nothing writes a row until an app registers a plan with a
-- metered item, so applying this changes nothing for any org.
--
-- Both tables are tenant-owned and take the `org_isolation` policy
-- (lib/tenancy/isolation.ts orgIsolationPolicySql(), verbatim). As with
-- 20261128090000_billing_webhook_event, an install that has already run
-- `db:tenancy:enable` would otherwise get them with RLS off until the switch
-- was re-run, so the block at the end enables and forces it when the
-- install's tenant-owned tables already are (read off `ai_agent`). At
-- `single` nothing is set.

-- CreateEnum
CREATE TYPE "BillingUsageReportStatus" AS ENUM ('OPEN', 'PENDING', 'COUNTED', 'SENT', 'NONE', 'LATE');

-- AlterTable
ALTER TABLE "org_billing_subscription" ADD COLUMN     "endedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "billing_usage_report" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "customerRef" TEXT NOT NULL,
    "subscriptionRef" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "meterKey" TEXT NOT NULL,
    "providerMeter" TEXT NOT NULL,
    "allowance" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "lastPeriod" BOOLEAN NOT NULL DEFAULT false,
    "status" "BillingUsageReportStatus" NOT NULL DEFAULT 'PENDING',
    "used" INTEGER,
    "quantity" INTEGER,
    "countedAt" TIMESTAMP(3),
    "runningSends" INTEGER NOT NULL DEFAULT 0,
    "runningQuantity" INTEGER,
    "sendingAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "orgId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_usage_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_usage_notice" (
    "id" TEXT NOT NULL,
    "meterKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "threshold" TEXT NOT NULL,
    "used" INTEGER NOT NULL,
    "allowance" INTEGER NOT NULL,
    "orgId" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_usage_notice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_usage_report_status_idx" ON "billing_usage_report"("status");

-- CreateIndex
CREATE UNIQUE INDEX "billing_usage_report_orgId_meterKey_periodStart_key" ON "billing_usage_report"("orgId", "meterKey", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "billing_usage_notice_orgId_meterKey_periodStart_threshold_key" ON "billing_usage_notice"("orgId", "meterKey", "periodStart", "threshold");

-- AddForeignKey
ALTER TABLE "billing_usage_report" ADD CONSTRAINT "billing_usage_report_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_usage_notice" ADD CONSTRAINT "billing_usage_notice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- billing_usage_report
CREATE POLICY "org_isolation" ON "billing_usage_report"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "orgId" = NULLIF(current_setting('app.current_org', true), '')
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "orgId" = NULLIF(current_setting('app.current_org', true), '')
  );

-- billing_usage_notice
CREATE POLICY "org_isolation" ON "billing_usage_notice"
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
    ALTER TABLE "billing_usage_report" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "billing_usage_report" FORCE ROW LEVEL SECURITY;
    ALTER TABLE "billing_usage_notice" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "billing_usage_notice" FORCE ROW LEVEL SECURITY;
  END IF;
END
$$;
