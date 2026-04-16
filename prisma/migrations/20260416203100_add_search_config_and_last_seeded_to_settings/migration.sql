-- AlterTable
ALTER TABLE "ai_orchestration_settings" ADD COLUMN     "lastSeededAt" TIMESTAMP(3),
ADD COLUMN     "searchConfig" JSONB;
