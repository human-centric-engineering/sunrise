-- t-1123: a grant of named admin tiers on an org membership.
--
-- `org_membership_grant` holds at most one row per membership: the named tiers
-- (`registerAdminTier()`) a MEMBER holds in their org beyond their role. It
-- goes with its membership (ON DELETE CASCADE), so removing the member, or
-- erasing them or their org, removes it. A system table, as `org_membership`
-- is: it carries no `orgId` and takes no `org_isolation` policy.
--
-- `user.signupOrgTiers` joins t-838's signup record (`signupOrgId`,
-- `signupOrgRole`), so a signup whose membership write failed is healed with
-- its grant. Empty for every existing row.
--
-- Nothing writes a grant until an app registers a named tier and an org admin
-- grants it, so applying this changes nothing for any org.

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "signupOrgTiers" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "org_membership_grant" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "tiers" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_membership_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_membership_grant_membershipId_key" ON "org_membership_grant"("membershipId");

-- AddForeignKey
ALTER TABLE "org_membership_grant" ADD CONSTRAINT "org_membership_grant_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "org_membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
