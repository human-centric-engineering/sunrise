-- AlterTable
ALTER TABLE "ai_workflow_schedule" ADD COLUMN     "scope" JSONB;

-- AlterTable
ALTER TABLE "ai_workflow_trigger" ADD COLUMN     "scope" JSONB;
