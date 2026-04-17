-- AlterTable
ALTER TABLE "ai_agent" ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ai_capability" ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;
