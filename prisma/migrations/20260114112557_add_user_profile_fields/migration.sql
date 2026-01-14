-- AlterTable
ALTER TABLE "user" ADD COLUMN     "bio" TEXT,
ADD COLUMN     "location" VARCHAR(100),
ADD COLUMN     "phone" VARCHAR(20),
ADD COLUMN     "preferences" JSONB DEFAULT '{}',
ADD COLUMN     "timezone" TEXT DEFAULT 'UTC';
