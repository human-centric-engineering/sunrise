-- §137 t-1044: organisations' own AI keys.
--
-- `ai_org_provider_key` holds one sealed key per org per provider row, and
-- `ai_orchestration_settings.orgProviderKeysEnabled` is the install's switch
-- for using them, off by default. Nothing reads either until the switch is
-- turned on and a key saved, so applying this changes no call.
--
-- The table is tenant-owned and takes the `org_isolation` policy
-- (lib/tenancy/isolation.ts orgIsolationPolicySql(), verbatim). As with the
-- waitlist tables (20261103120000_waitlist), an install that has already run
-- `db:tenancy:enable` would otherwise get this table with RLS off — every
-- org's key row readable from any other org — until the switch was re-run, so
-- the block at the end enables and forces it when the install's tenant-owned
-- tables already are (read off `ai_agent`). At `single` nothing is set.

-- AlterTable
ALTER TABLE "ai_orchestration_settings" ADD COLUMN     "orgProviderKeysEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ai_org_provider_key" (
    "id" TEXT NOT NULL,
    "providerConfigId" TEXT NOT NULL,
    "sealedKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "hint" TEXT NOT NULL,
    "savedById" TEXT,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orgId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_org_provider_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_org_provider_key_providerConfigId_idx" ON "ai_org_provider_key"("providerConfigId");

-- CreateIndex
CREATE INDEX "ai_org_provider_key_savedById_idx" ON "ai_org_provider_key"("savedById");

-- CreateIndex
CREATE UNIQUE INDEX "ai_org_provider_key_orgId_providerConfigId_key" ON "ai_org_provider_key"("orgId", "providerConfigId");

-- AddForeignKey
ALTER TABLE "ai_org_provider_key" ADD CONSTRAINT "ai_org_provider_key_providerConfigId_fkey" FOREIGN KEY ("providerConfigId") REFERENCES "ai_provider_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_org_provider_key" ADD CONSTRAINT "ai_org_provider_key_savedById_fkey" FOREIGN KEY ("savedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_org_provider_key" ADD CONSTRAINT "ai_org_provider_key_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ai_org_provider_key
CREATE POLICY "org_isolation" ON "ai_org_provider_key"
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
    ALTER TABLE "ai_org_provider_key" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "ai_org_provider_key" FORCE ROW LEVEL SECURITY;
  END IF;
END
$$;
