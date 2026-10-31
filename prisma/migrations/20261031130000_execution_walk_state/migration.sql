-- t-966: where the DAG walk had got to, so a crash-resume continues exactly
-- where the run stopped. Nullable: a run started before this column existed
-- resumes the way it did before.

-- AlterTable
ALTER TABLE "ai_workflow_execution" ADD COLUMN     "walkState" JSONB;
