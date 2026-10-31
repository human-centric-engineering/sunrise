-- t-965 (#1143): which attempt of a step is running, and its id, so a
-- resumed run continues the attempt its replayed turns belong to under the
-- same number and id. Rows in flight at deploy read as attempt 0 with no id,
-- which is what they reported before; their step gets a fresh id.

-- AlterTable
ALTER TABLE "ai_workflow_running_step" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "attemptId" TEXT;
