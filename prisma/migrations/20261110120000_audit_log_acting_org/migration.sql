-- t-1005 (#1181): name the org every admin audit row was made in, so an org
-- can be shown its own admin history. Nullable: a system-scope write is made
-- in no org, and rows written before this column carry none. No FK,
-- deliberately, as with `supportOrgId`: erasing the org keeps the rows naming
-- where they happened. Not `orgId`: the table stays a system model, outside
-- row isolation, read per org only through one confined reader.

-- AlterTable
ALTER TABLE "ai_admin_audit_log" ADD COLUMN     "actingOrgId" TEXT;

-- CreateIndex
CREATE INDEX "ai_admin_audit_log_actingOrgId_createdAt_idx" ON "ai_admin_audit_log"("actingOrgId", "createdAt");
