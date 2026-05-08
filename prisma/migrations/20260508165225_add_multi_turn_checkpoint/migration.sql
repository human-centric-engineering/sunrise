-- Multi-turn checkpoint state for crash-safe resume of long-running steps.
-- See `.context/orchestration/engine.md` (Recovery model) and
-- `lib/orchestration/engine/orchestration-engine.ts` (recordStepTurn) for the
-- contract.
--
-- The column holds the array of TurnEntry objects for the step currently named
-- in `currentStep`. Multi-turn executors (`agent_call`, `orchestrator`,
-- `reflect`) call `ctx.recordTurn(...)` after each completed turn; the engine
-- writes the full array each call (lease-guarded). On step termination the
-- engine moves the array into the trace entry's `turns` field; the next
-- `markCurrentStep` clears this column so it always reflects the in-flight
-- step's state — never stale data from a prior step.
--
-- On orphan-resume, `initRun` reads this column alongside `currentStep` and
-- hands the entries to the executor via `ctx.resumeTurns`. A 10-turn agent_call
-- killed on turn 7 resumes at turn 8 instead of restarting from turn 1; the
-- dispatch cache (ai_workflow_step_dispatch) handles per-turn tool dedup so
-- side effects within already-completed turns are not re-fired.
--
-- Strict additive change. Existing rows pick up NULL — the resume path treats
-- NULL as "no in-flight turns", so legacy executions resume identically to
-- before this migration.

ALTER TABLE "ai_workflow_execution"
  ADD COLUMN "currentStepTurns" JSONB;
