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
import type { StepResult } from '@/types/orchestration';

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
 */
export function snapshotContext(ctx: ExecutionContext): Readonly<ExecutionContext> {
  return Object.freeze({
    ...ctx,
    stepOutputs: Object.freeze({ ...ctx.stepOutputs }),
    variables: Object.freeze({ ...ctx.variables }),
  });
}
