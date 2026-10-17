-- §121 t-825: name the support grant (and the org it was in) on every admin
-- audit row made during a support session. Both nullable: a row made outside
-- one carries neither. `supportOrgId` has no FK, deliberately — erasing the org
-- nulls `supportGrantId` (SET NULL) and the vendor's own log keeps the row
-- marked as support, naming where it happened.

-- AlterTable
ALTER TABLE "ai_admin_audit_log" ADD COLUMN     "supportGrantId" TEXT,
ADD COLUMN     "supportOrgId" TEXT;

-- CreateIndex
CREATE INDEX "ai_admin_audit_log_supportGrantId_createdAt_idx" ON "ai_admin_audit_log"("supportGrantId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_admin_audit_log_supportOrgId_idx" ON "ai_admin_audit_log"("supportOrgId");

-- AddForeignKey
ALTER TABLE "ai_admin_audit_log" ADD CONSTRAINT "ai_admin_audit_log_supportGrantId_fkey" FOREIGN KEY ("supportGrantId") REFERENCES "org_support_grant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
