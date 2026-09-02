-- Durable user attribution for cost rows.
--
-- Nullable and ON DELETE SET NULL, matching the agentId/conversationId/
-- workflowExecutionId FKs on this table: a cost row is a billing record, so
-- erasing the user (or deleting the agent or conversation) must not silently
-- subtract spend that actually happened. NULL is a correct value here, not a
-- gap to backfill -- ingestion, embedding, scheduled runs and embed traffic
-- have no session user, and every row written before this column has none.
--
-- Hand-folded, as every migration in this repo is: `prisma migrate dev`
-- regenerates DROP INDEX for the three raw-SQL pgvector/tsvector indexes the
-- baseline creates and an `ALTER COLUMN "searchVector" DROP DEFAULT` that
-- fails at apply time (42601 -- it is a generated column). Generated with
-- --create-only precisely so that drift could be stripped before anything ran.

ALTER TABLE "ai_cost_log" ADD COLUMN     "userId" TEXT;

-- CreateIndex
CREATE INDEX "ai_cost_log_userId_idx" ON "ai_cost_log"("userId");

-- AddForeignKey
ALTER TABLE "ai_cost_log" ADD CONSTRAINT "ai_cost_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
