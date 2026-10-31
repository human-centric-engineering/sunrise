-- t-965 (#1143): the running attempt's id, so a crash-resume continues the
-- attempt under the same id. Nullable: rows in flight at deploy have none,
-- and their step gets a fresh id.

-- AlterTable
ALTER TABLE "ai_workflow_running_step" ADD COLUMN     "attemptId" TEXT;
