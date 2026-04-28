/**
 * Engine-internal error classes.
 *
 * Platform-agnostic. Used by executors and the engine to signal
 * exceptional control flow (pause, budget, wrapped executor failures)
 * without string-matching on error messages.
 */

/**
 * Thrown by the `human_approval` executor. The engine catches this
 * specifically, transitions the execution row to `paused_for_approval`,
 * persists the approval payload on the step's trace entry, and stops
 * iterating — the stream ends cleanly.
 */
export class PausedForApproval extends Error {
  public readonly stepId: string;
  public readonly payload: unknown;

  constructor(stepId: string, payload: unknown) {
    super(`Workflow paused for approval at step "${stepId}"`);
    this.name = 'PausedForApproval';
    this.stepId = stepId;
    this.payload = payload;
  }
}

/**
 * Thrown by the engine when `totalCostUsd` exceeds `budgetLimitUsd`.
 * Results in a terminal `workflow_failed` event with `error: 'Budget exceeded'`.
 */
export class BudgetExceeded extends Error {
  public readonly usedUsd: number;
  public readonly limitUsd: number;

  constructor(usedUsd: number, limitUsd: number) {
    super(`Budget exceeded: $${usedUsd.toFixed(4)} / $${limitUsd.toFixed(4)}`);
    this.name = 'BudgetExceeded';
    this.usedUsd = usedUsd;
    this.limitUsd = limitUsd;
  }
}

/**
 * Wrap any executor failure. Carries a sanitized message suitable for
 * the SSE client plus the underlying cause for server logs.
 */
export class ExecutorError extends Error {
  public readonly stepId: string;
  public readonly code: string;
  public readonly cause?: unknown;
  /**
   * Whether the error is transient and the step could succeed on retry.
   * Used by the engine to decide whether `retry` error strategy applies.
   * Defaults to `true` for backward compatibility.
   */
  public readonly retriable: boolean;
  /**
   * Partial token/cost usage from the failed attempt. Executors that
   * consume LLM tokens before failing should populate these so the
   * engine can accumulate them across retries and fallbacks.
   */
  public readonly tokensUsed: number;
  public readonly costUsd: number;

  constructor(
    stepId: string,
    code: string,
    message: string,
    cause?: unknown,
    retriable = true,
    tokensUsed = 0,
    costUsd = 0
  ) {
    super(message);
    this.name = 'ExecutorError';
    this.stepId = stepId;
    this.code = code;
    this.cause = cause;
    this.retriable = retriable;
    this.tokensUsed = tokensUsed;
    this.costUsd = costUsd;
  }
}
