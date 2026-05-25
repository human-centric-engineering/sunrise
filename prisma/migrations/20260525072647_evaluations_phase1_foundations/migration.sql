-- NOTE: Prisma migrate dev tried to emit `DROP INDEX
-- idx_ai_knowledge_chunk_search_vector`, `DROP INDEX idx_message_embedding`,
-- and `ALTER TABLE ai_knowledge_chunk ALTER COLUMN searchVector DROP DEFAULT`
-- as part of this diff. Those changes are NOT real schema changes — they
-- are the documented Prisma drift from raw-SQL-managed tsvector + pgvector
-- objects. See the warning block above `model AiKnowledgeChunk` in
-- schema.prisma. Removed here intentionally.

-- AlterTable
ALTER TABLE "ai_experiment_variant" ADD COLUMN     "evaluationRunId" TEXT;

-- CreateTable
CREATE TABLE "ai_dataset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "caseCount" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_dataset_case" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "input" JSONB NOT NULL,
    "expectedOutput" TEXT,
    "referenceCitations" JSONB,
    "metadata" JSONB,

    CONSTRAINT "ai_dataset_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_evaluation_run" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "subjectKind" TEXT NOT NULL,
    "agentId" TEXT,
    "workflowId" TEXT,
    "datasetId" TEXT NOT NULL,
    "datasetContentHash" TEXT NOT NULL,
    "metricConfigs" JSONB NOT NULL,
    "judgeProvider" TEXT,
    "judgeModel" TEXT,
    "subjectOutputSelector" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" JSONB NOT NULL DEFAULT '{"casesTotal":0,"casesDone":0,"casesFailed":0}',
    "summary" JSONB,
    "totalCostUsd" DOUBLE PRECISION,
    "parentRunId" TEXT,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_evaluation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_evaluation_case_result" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "datasetCaseId" TEXT NOT NULL,
    "casePosition" INTEGER NOT NULL,
    "subjectOutput" TEXT NOT NULL,
    "subjectMetadata" JSONB,
    "metricScores" JSONB NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_evaluation_case_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_dataset_userId_updatedAt_idx" ON "ai_dataset"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ai_dataset_case_datasetId_idx" ON "ai_dataset_case"("datasetId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_dataset_case_datasetId_position_key" ON "ai_dataset_case"("datasetId", "position");

-- CreateIndex
CREATE INDEX "ai_evaluation_run_userId_updatedAt_idx" ON "ai_evaluation_run"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ai_evaluation_run_status_lockedAt_idx" ON "ai_evaluation_run"("status", "lockedAt");

-- CreateIndex
CREATE INDEX "ai_evaluation_run_datasetId_idx" ON "ai_evaluation_run"("datasetId");

-- CreateIndex
CREATE INDEX "ai_evaluation_run_agentId_idx" ON "ai_evaluation_run"("agentId");

-- CreateIndex
CREATE INDEX "ai_evaluation_run_workflowId_idx" ON "ai_evaluation_run"("workflowId");

-- CreateIndex
CREATE INDEX "ai_evaluation_case_result_runId_idx" ON "ai_evaluation_case_result"("runId");

-- CreateIndex
CREATE INDEX "ai_evaluation_case_result_datasetCaseId_idx" ON "ai_evaluation_case_result"("datasetCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_evaluation_case_result_runId_casePosition_key" ON "ai_evaluation_case_result"("runId", "casePosition");

-- CreateIndex
CREATE INDEX "ai_experiment_variant_evaluationRunId_idx" ON "ai_experiment_variant"("evaluationRunId");

-- AddForeignKey
ALTER TABLE "ai_dataset" ADD CONSTRAINT "ai_dataset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_dataset_case" ADD CONSTRAINT "ai_dataset_case_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "ai_dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_run" ADD CONSTRAINT "ai_evaluation_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_run" ADD CONSTRAINT "ai_evaluation_run_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_run" ADD CONSTRAINT "ai_evaluation_run_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ai_workflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_run" ADD CONSTRAINT "ai_evaluation_run_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "ai_dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_run" ADD CONSTRAINT "ai_evaluation_run_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "ai_evaluation_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_case_result" ADD CONSTRAINT "ai_evaluation_case_result_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ai_evaluation_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_case_result" ADD CONSTRAINT "ai_evaluation_case_result_datasetCaseId_fkey" FOREIGN KEY ("datasetCaseId") REFERENCES "ai_dataset_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_experiment_variant" ADD CONSTRAINT "ai_experiment_variant_evaluationRunId_fkey" FOREIGN KEY ("evaluationRunId") REFERENCES "ai_evaluation_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- NOTE: A `RENAME INDEX ai_conversation_inbound_key TO
-- ai_conversation_agentId_channel_fromAddress_key` was auto-generated
-- by Prisma here. Removed: the schema explicitly pins the index name
-- to `ai_conversation_inbound_key` via the `name:` argument on
-- AiConversation.@@unique([agentId, channel, fromAddress], ...) — the
-- rename would have created persistent drift on every future diff.
