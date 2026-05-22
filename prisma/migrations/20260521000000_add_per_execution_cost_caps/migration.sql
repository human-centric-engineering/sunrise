-- Per-execution / per-turn hard cost caps (improvement #39, runaway-loop guard).
-- All columns are nullable; null preserves prior behaviour (no per-call cap,
-- monthly budget still applies). Resolution chain:
--   Per-execution: caller override > AiWorkflow.maxCostPerExecutionUsd
--                  > AiOrchestrationSettings.defaultMaxCostPerExecutionUsd
--                  > unlimited
--   Per-turn:      AiAgent.maxCostPerTurnUsd
--                  > AiOrchestrationSettings.defaultMaxCostPerTurnUsd
--                  > unlimited
-- See lib/orchestration/llm/cost-caps.ts.

ALTER TABLE "ai_agent" ADD COLUMN "maxCostPerTurnUsd" DOUBLE PRECISION;

ALTER TABLE "ai_workflow" ADD COLUMN "maxCostPerExecutionUsd" DOUBLE PRECISION;

ALTER TABLE "ai_orchestration_settings"
  ADD COLUMN "defaultMaxCostPerExecutionUsd" DOUBLE PRECISION,
  ADD COLUMN "defaultMaxCostPerTurnUsd"       DOUBLE PRECISION;
