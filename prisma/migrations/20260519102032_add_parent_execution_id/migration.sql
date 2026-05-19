-- AlterTable: add `parentExecutionId` to ai_workflow_execution for rerun lineage.
-- Nullable + onDelete: SetNull at the application layer (the Prisma FK is
-- declared with onDelete: SetNull so cascading parent-deletion just nulls the
-- child's link rather than removing the child execution history).
ALTER TABLE "ai_workflow_execution"
  ADD COLUMN "parentExecutionId" TEXT;

-- ForeignKey: self-reference for the lineage chain.
ALTER TABLE "ai_workflow_execution"
  ADD CONSTRAINT "ai_workflow_execution_parentExecutionId_fkey"
  FOREIGN KEY ("parentExecutionId") REFERENCES "ai_workflow_execution"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Index: "find all reruns of this execution" lookup pattern.
CREATE INDEX "ai_workflow_execution_parentExecutionId_idx"
  ON "ai_workflow_execution"("parentExecutionId");
