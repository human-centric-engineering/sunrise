-- AlterTable
ALTER TABLE "ai_workflow" ADD COLUMN     "workflowDefinitionHistory" JSONB NOT NULL DEFAULT '[]';
