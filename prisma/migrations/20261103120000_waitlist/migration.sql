-- §125 t-974: the waitlist. Two tenant-owned tables — an entry is one org's,
-- and so is a list's open/closed state.
--
-- Each takes the `org_isolation` policy (lib/tenancy/isolation.ts
-- orgIsolationPolicySql(), verbatim). The policy alone is dormant: it binds only
-- once `ENABLE ROW LEVEL SECURITY` is set, which `db:tenancy:enable` does.
--
-- These are the first tenant-owned tables created after an install may already
-- have run that switch. On such an install, `migrate deploy` would otherwise
-- leave these two tables with RLS off — every row readable across orgs — until
-- an operator re-ran the switch, and nothing about a deploy says to. So the
-- block at the end mirrors the install's state: if the tenancy switch is on
-- (read off `ai_agent`, a tenant-owned table every install has), the new tables
-- are enabled and forced too. At `single` nothing is set, as before.

-- CreateTable
CREATE TABLE "waitlist_entry" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "list" TEXT NOT NULL DEFAULT 'default',
    "details" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'form',
    "locale" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "referrerHost" TEXT,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "flaggedReason" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "rejoinRequestedAt" TIMESTAMP(3),
    "rejoinRequests" INTEGER NOT NULL DEFAULT 0,
    "invitedAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3),
    "userId" TEXT,
    "orgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waitlist_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_list_state" (
    "id" TEXT NOT NULL,
    "list" TEXT NOT NULL,
    "open" BOOLEAN NOT NULL,
    "changedById" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orgId" TEXT,

    CONSTRAINT "waitlist_list_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "waitlist_entry_orgId_idx" ON "waitlist_entry"("orgId");

-- CreateIndex
CREATE INDEX "waitlist_entry_orgId_list_createdAt_idx" ON "waitlist_entry"("orgId", "list", "createdAt");

-- CreateIndex
CREATE INDEX "waitlist_entry_email_idx" ON "waitlist_entry"("email");

-- CreateIndex
CREATE INDEX "waitlist_entry_userId_idx" ON "waitlist_entry"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entry_orgId_list_email_key" ON "waitlist_entry"("orgId", "list", "email");

-- CreateIndex
CREATE INDEX "waitlist_list_state_orgId_idx" ON "waitlist_list_state"("orgId");

-- CreateIndex
CREATE INDEX "waitlist_list_state_changedById_idx" ON "waitlist_list_state"("changedById");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_list_state_orgId_list_key" ON "waitlist_list_state"("orgId", "list");

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_list_state" ADD CONSTRAINT "waitlist_list_state_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_list_state" ADD CONSTRAINT "waitlist_list_state_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- waitlist_entry
CREATE POLICY "org_isolation" ON "waitlist_entry"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "orgId" = NULLIF(current_setting('app.current_org', true), '')
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "orgId" = NULLIF(current_setting('app.current_org', true), '')
  );

-- waitlist_list_state
CREATE POLICY "org_isolation" ON "waitlist_list_state"
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
    WHERE oid = to_regclass('public.ai_agent') AND relrowsecurity
  ) THEN
    ALTER TABLE "waitlist_entry" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "waitlist_entry" FORCE ROW LEVEL SECURITY;
    ALTER TABLE "waitlist_list_state" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "waitlist_list_state" FORCE ROW LEVEL SECURITY;
  END IF;
END
$$;
