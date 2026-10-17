-- t-838: the org membership a signup decided and has not yet written. Set by
-- the signup's before hook in the same INSERT as the user, cleared in the
-- transaction that writes the membership, so the sign-in self-heal can put a
-- user whose membership write failed into the org that invited them. Both
-- nullable: every existing user has no pending membership.

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "signupOrgId" TEXT,
ADD COLUMN     "signupOrgRole" "OrgRole";
