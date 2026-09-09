-- The experiments list filters on createdBy and sorts createdAt desc (#741).
-- Compound so one index serves both halves, matching the owner-scoped lists
-- over AiDataset and AiEvaluationRun.
CREATE INDEX "ai_experiment_createdBy_createdAt_idx" ON "ai_experiment"("createdBy", "createdAt");
