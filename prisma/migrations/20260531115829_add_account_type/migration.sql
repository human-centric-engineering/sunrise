-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('HUMAN', 'SERVICE');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "accountType" "AccountType" NOT NULL DEFAULT 'HUMAN';

-- CreateIndex
CREATE INDEX "user_role_accountType_idx" ON "user"("role", "accountType");

-- Mark any already-seeded system config-owner as a SERVICE account. Safe no-op
-- on databases where the row does not exist yet (it is created by the
-- 001-system-owner seed). Runs on every environment via `migrate deploy`.
UPDATE "user" SET "accountType" = 'SERVICE' WHERE "email" = 'system@sunrise.local';
