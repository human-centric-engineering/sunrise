-- Org identity (§106 t-669): the two tenancy tables, the install org, and
-- every existing user made a member of it.
--
-- Principle 1 of .context/architecture/multi-tenancy-design.md: one org
-- ALWAYS exists. At TENANCY_MODE=single that org is the install org created
-- below, so the write path, the authorization policy and the console split
-- run one code path rather than a dormant multi-tenant branch. The data
-- statements live here and not in a seed because hosted installs never run
-- `db:seed` (.context/database/seeding.md) — a migration is the only thing
-- guaranteed to reach every environment.
--
-- Every data statement is idempotent (ON CONFLICT DO NOTHING / WHERE … IS
-- NULL), so a re-run — or an operator who created the install org by hand
-- first — is a no-op rather than a failed deploy.
--
-- Also lands: a nullable `orgId` on the four long-lived credential models,
-- backfilled to the install org (§106 t-673 starts writing it at mint), and
-- `session.activeOrgId`, which better-auth learns to write in t-670. Folded
-- into this migration so the identity release carries ONE migration, as the
-- spec's merge-impact section promises forks.
--
-- Hand-folded, as every migration in this repo is: `prisma migrate diff`
-- regenerates DROP INDEX for the three raw-SQL pgvector/tsvector indexes the
-- baseline creates and an `ALTER COLUMN "searchVector" DROP DEFAULT` that
-- fails at apply time (42601 — it is a generated column). Both stripped.

-- CreateEnum
CREATE TYPE "OrgStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- AlterTable
ALTER TABLE "ai_agent_embed_token" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_agent_invite_token" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_api_key" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "mcp_api_key" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "activeOrgId" TEXT;

-- CreateTable
CREATE TABLE "org" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OrgStatus" NOT NULL DEFAULT 'ACTIVE',
    "settings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_membership" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_membership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_slug_key" ON "org"("slug");

-- CreateIndex
CREATE INDEX "org_membership_userId_idx" ON "org_membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "org_membership_orgId_userId_key" ON "org_membership"("orgId", "userId");

-- CreateIndex
CREATE INDEX "ai_agent_embed_token_orgId_idx" ON "ai_agent_embed_token"("orgId");

-- CreateIndex
CREATE INDEX "ai_agent_invite_token_orgId_idx" ON "ai_agent_invite_token"("orgId");

-- CreateIndex
CREATE INDEX "ai_api_key_orgId_idx" ON "ai_api_key"("orgId");

-- CreateIndex
CREATE INDEX "mcp_api_key_orgId_idx" ON "mcp_api_key"("orgId");

-- AddForeignKey
ALTER TABLE "mcp_api_key" ADD CONSTRAINT "mcp_api_key_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_invite_token" ADD CONSTRAINT "ai_agent_invite_token_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_embed_token" ADD CONSTRAINT "ai_agent_embed_token_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_api_key" ADD CONSTRAINT "ai_api_key_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_membership" ADD CONSTRAINT "org_membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_membership" ADD CONSTRAINT "org_membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Data: the install org, and the invariant "every user is a member".
-- ---------------------------------------------------------------------------

-- The install org. Its id and slug are the fixed literals in
-- lib/tenancy/constants.ts (INSTALL_ORG_ID / INSTALL_ORG_SLUG — the
-- AUTH_BOOTSTRAP_ID precedent), so application code can address it without a
-- lookup. The name is a placeholder an operator renames through the org
-- lifecycle API (§106 t-672); a migration cannot read the fork's BRAND.
INSERT INTO "org" ("id", "slug", "name", "status", "createdAt", "updatedAt")
VALUES ('install', 'install', 'Default organisation', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Every existing user becomes a member of the install org. The role rule is
-- the one the byte-identical argument needs: a platform ADMIN (a real human
-- one — `lib/auth/account.ts`'s humanAdminWhere) becomes OWNER, and everyone
-- else — including the seeded SERVICE config-owner, which holds role ADMIN
-- but never logs in — becomes MEMBER. Nobody gains an org-level grant they
-- did not already hold as platform admin. `userCreateAfterHook` applies the
-- same rule to every user created after this migration.
--
-- Ids are generated here as UUIDs (Postgres ≥ 13's gen_random_uuid()) rather
-- than the cuids Prisma mints — ids on this table are opaque and nothing
-- parses their format. ON CONFLICT on the (orgId, userId) unique keeps a
-- re-run, or a membership created by hand, from failing the deploy.
INSERT INTO "org_membership" ("id", "orgId", "userId", "role", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    'install',
    u."id",
    CASE WHEN u."role" = 'ADMIN' AND u."accountType" = 'HUMAN' THEN 'OWNER'::"OrgRole" ELSE 'MEMBER'::"OrgRole" END,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "user" u
ON CONFLICT ("orgId", "userId") DO NOTHING;

-- Every credential minted before orgs existed was minted in the only org
-- there is. Guarded on NULL so a row §106 t-673 has since bound is never
-- rewritten by a re-run.
--
-- Except an `admin`-scoped API key. The feature's read rule (reconciliation
-- finding 13) is that `admin` ⇒ orgId NULL ⇒ a PLATFORM credential with no
-- org context, and t-673's mint rule is that an org-bound admin key cannot
-- exist. Binding the existing ones here would create exactly that state and
-- hand t-673 a backfill to undo, so they are left NULL — which is what a
-- platform credential's orgId means.
UPDATE "ai_api_key"            SET "orgId" = 'install' WHERE "orgId" IS NULL AND NOT ('admin' = ANY("scopes"));
UPDATE "ai_agent_embed_token"  SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_agent_invite_token" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "mcp_api_key"           SET "orgId" = 'install' WHERE "orgId" IS NULL;
