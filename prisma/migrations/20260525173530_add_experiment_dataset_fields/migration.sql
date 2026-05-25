-- Phase 2.4: experiments-as-dataset-runs
--
-- Adds nullable `datasetId` + `metricConfigs` to `ai_experiment` so the
-- run route can create one `AiEvaluationRun` per variant against the
-- experiment's shared dataset. Both fields are nullable to preserve
-- back-compat with legacy experiments that pre-date dataset-driven
-- runs — those continue to execute via the existing `AiEvaluationSession`
-- path until they complete and age out naturally.

ALTER TABLE "ai_experiment"
  ADD COLUMN "datasetId" TEXT,
  ADD COLUMN "metricConfigs" JSONB;

CREATE INDEX "ai_experiment_datasetId_idx" ON "ai_experiment"("datasetId");

ALTER TABLE "ai_experiment"
  ADD CONSTRAINT "ai_experiment_datasetId_fkey"
  FOREIGN KEY ("datasetId") REFERENCES "ai_dataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
