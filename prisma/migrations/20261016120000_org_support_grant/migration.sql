-- §121 t-823: an org's consent for vendor support to act inside it.
--
-- A system table (lib/tenancy/classification.ts SYSTEM_MODELS), so it takes no
-- org_isolation policy: the guard reads it before any org is entered.

-- CreateEnum
CREATE TYPE "SupportGrantLevel" AS ENUM ('ADMIN', 'READ_ONLY');

-- CreateTable
CREATE TABLE "org_support_grant" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "level" "SupportGrantLevel" NOT NULL DEFAULT 'ADMIN',
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "grantedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_support_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_support_grant_orgId_expiresAt_idx" ON "org_support_grant"("orgId", "expiresAt");

-- CreateIndex
CREATE INDEX "org_support_grant_grantedById_idx" ON "org_support_grant"("grantedById");

-- CreateIndex
CREATE INDEX "org_support_grant_revokedById_idx" ON "org_support_grant"("revokedById");

-- AddForeignKey
ALTER TABLE "org_support_grant" ADD CONSTRAINT "org_support_grant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_support_grant" ADD CONSTRAINT "org_support_grant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_support_grant" ADD CONSTRAINT "org_support_grant_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

