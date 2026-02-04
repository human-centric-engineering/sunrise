-- Backfill any null roles to 'USER' before adding NOT NULL constraint
UPDATE "user" SET "role" = 'USER' WHERE "role" IS NULL;

-- AlterTable: make role non-nullable (was String? with @default("USER"))
ALTER TABLE "user" ALTER COLUMN "role" SET NOT NULL;
