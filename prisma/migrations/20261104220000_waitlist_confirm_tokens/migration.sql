-- §125 t-977: an unconfirmed entry's retention window, a cap on its links, and
-- the table that holds its confirmation tokens.
--
-- Existing entries take the migration's time as their window start: none of
-- them was ever sent a confirmation link, so their join date says nothing about
-- how long they have had to confirm.
--
-- `waitlist_confirm_token` is tenant-owned and cascades with its entry, so
-- every path that deletes an entry deletes its tokens without being told to.
-- It takes the `org_isolation` policy (lib/tenancy/isolation.ts
-- orgIsolationPolicySql(), verbatim), and the block at the end follows the
-- install's tenancy switch as `20261103120000_waitlist` explains: if RLS is on
-- for `ai_agent`, the new table is enabled and forced too.

-- AlterTable
ALTER TABLE "waitlist_entry" ADD COLUMN     "confirmLinksSent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "confirmWindowFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "waitlist_confirm_token" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "orgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_confirm_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "waitlist_confirm_token_entryId_expiresAt_idx" ON "waitlist_confirm_token"("entryId", "expiresAt");

-- CreateIndex
CREATE INDEX "waitlist_confirm_token_orgId_idx" ON "waitlist_confirm_token"("orgId");

-- AddForeignKey
ALTER TABLE "waitlist_confirm_token" ADD CONSTRAINT "waitlist_confirm_token_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "waitlist_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_confirm_token" ADD CONSTRAINT "waitlist_confirm_token_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- waitlist_confirm_token
CREATE POLICY "org_isolation" ON "waitlist_confirm_token"
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
    ALTER TABLE "waitlist_confirm_token" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "waitlist_confirm_token" FORCE ROW LEVEL SECURITY;
  END IF;
END
$$;
