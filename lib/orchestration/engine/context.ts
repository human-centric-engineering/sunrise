/**
 * Execution context — shared state passed to every executor.
 *
 * The context accumulates token counts, cost, and per-step outputs as
 * the engine walks the DAG. Executors receive a **frozen snapshot** and
 * return a `StepResult`; the engine calls `mergeStepResult()` to fold
 * the result back into the live context.
 *
 * This keeps executors side-effect-free w.r.t. context mutation, which
 * makes them trivial to unit-test and protects against executors
 * accidentally clobbering each other's state during parallel branches.
 */

import type { Logger } from '@/lib/logging';
import type { LlmTelemetryEntry, StepResult, TurnEntry } from '@/types/orchestration';

/**
 * Context passed to each step executor.
 *
 * Most fields are read-only from the executor's perspective; the only
 * mutable scratchpad is `variables`. Even there, executors should
 * prefer adding scoped sub-keys rather than mutating existing ones.
 */
export interface ExecutionContext {
  /** `AiWorkflowExecution.id` of the row backing this run. */
  executionId: string;
  /** `AiWorkflow.id` being executed. */
  workflowId: string;
  /** User who initiated the execution. Forwarded to cost-tracking. */
  userId: string;
  /** The raw `inputData` supplied by the caller. */
  inputData: Record<string, unknown>;
  /** Map of `step.id` → that step's structured output so far. */
  stepOutputs: Record<string, unknown>;
  /** Free-form scratchpad for executors (planner state, loop counters, ...). */
  variables: Record<string, unknown>;
  /** Running total of tokens consumed by LLM calls in this execution. */
  totalTokensUsed: number;
  /** Running total of cost incurred by this execution in USD. */
  totalCostUsd: number;
  /** Optional hard cap on `totalCostUsd`. When exceeded, the engine aborts. */
  budgetLimitUsd?: number;
  /** Workflow-level default error strategy — used when a step doesn't specify its own. */
  defaultErrorStrategy: 'retry' | 'fallback' | 'skip' | 'fail';
  /** External cancellation signal forwarded to provider calls. */
  signal?: AbortSignal;
  /** Child logger scoped to `{ executionId, workflowId }`. */
  logger: Logger;
  /**
   * Per-step LLM telemetry accumulator. Snapshots produced by
   * `snapshotContext` always carry their own array (the engine threads
   * one in via `telemetryOut` so it can drain entries after the executor
   * returns). The live context produced by `createContext` carries an
   * empty array as well, but it is never read in production — the engine
   * only reads from the per-step `telemetryOut` array.
   *
   * Optional on the type so existing test fixtures that build literal
   * ExecutionContext shapes don't have to change. Production callers
   * (engine, `runLlmCall`, `agent_call`) all set or guard the array.
   */
  stepTelemetry?: LlmTelemetryEntry[];
  /**
   * Resume state for multi-turn step types. When non-empty, the executor
   * (`agent_call`, `orchestrator`, `reflect`) is being re-invoked after a
   * crash and should restore its in-memory state from these entries rather
   * than starting from turn 0. The engine populates this from the row's
   * `currentStepTurns` column on the resume path and clears it after the
   * first multi-turn step terminates — a one-shot field for the in-flight
   * step only.
   *
   * Single-shot step types ignore this field; their crash safety comes from
   * the dispatch cache, not turn replay.
   */
  resumeTurns?: TurnEntry[];
  /**
   * Mid-step checkpoint hook. Multi-turn executors call this after each
   * completed turn to persist progress. The engine's implementation appends
   * to an in-memory accumulator AND writes the full array to the row's
   * `currentStepTurns` column (lease-guarded). The lease is refreshed in the
   * same UPDATE so a long single step doesn't lose ownership while a
   * heartbeat tick is queued.
   *
   * Optional on the type so single-shot executors and test fixtures can
   * ignore it. The engine sets this field for every step; calling it from
   * any executor is no-op safe.
   */
  recordTurn?: (turn: TurnEntry) => Promise<void>;
}

/**
 * Build a fresh `ExecutionContext`. The engine calls this once at the
 * start of `execute()` before yielding `workflow_started`.
 */
export function createContext(params: {
  executionId: string;
  workflowId: string;
  userId: string;
  inputData: Record<string, unknown>;
  defaultErrorStrategy?: 'retry' | 'fallback' | 'skip' | 'fail';
  budgetLimitUsd?: number;
  signal?: AbortSignal;
  logger: Logger;
}): ExecutionContext {
  return {
    executionId: params.executionId,
    workflowId: params.workflowId,
    userId: params.userId,
    inputData: params.inputData,
    stepOutputs: {},
    variables: {},
    totalTokensUsed: 0,
    totalCostUsd: 0,
    defaultErrorStrategy: params.defaultErrorStrategy ?? 'fail',
    budgetLimitUsd: params.budgetLimitUsd,
    signal: params.signal,
    logger: params.logger,
    stepTelemetry: [],
  };
}

/**
 * Fold a `StepResult` back into the live context.
 *
 * - Records `result.output` under `ctx.stepOutputs[stepId]`.
 * - Accumulates `tokensUsed` and `costUsd` onto the running totals.
 *
 * Returns the mutated context for fluent chaining; the context is
 * mutated in place so holders of the reference see the new totals.
 */
export function mergeStepResult(
  ctx: ExecutionContext,
  stepId: string,
  result: StepResult
): ExecutionContext {
  ctx.stepOutputs[stepId] = result.output;
  ctx.totalTokensUsed += result.tokensUsed;
  ctx.totalCostUsd += result.costUsd;
  return ctx;
}

/**
 * Produce a read-only snapshot of the context to pass to an executor.
 *
 * `Object.freeze` is shallow — executors that want to mutate
 * `stepOutputs` or `variables` will get a clear runtime error rather
 * than silently corrupting shared state during parallel branches.
 *
 * `stepTelemetry` is a write channel: every snapshot gets its OWN array
 * so concurrent parallel branches don't interleave. When the engine wants
 * to capture telemetry from a specific step, it passes its own array via
 * `telemetryOut` and reads the entries back after the executor returns.
 * Callers that don't pass `telemetryOut` (e.g., test harnesses) still get
 * a correctly-typed empty array — pushes are silently discarded.
 */
export function snapshotContext(
  ctx: ExecutionContext,
  telemetryOut?: LlmTelemetryEntry[]
): Readonly<ExecutionContext> {
  return Object.freeze({
    ...ctx,
    stepOutputs: Object.freeze({ ...ctx.stepOutputs }),
    variables: Object.freeze({ ...ctx.variables }),
    stepTelemetry: telemetryOut ?? [],
  });
}
