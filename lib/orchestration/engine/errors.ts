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
  /**
   * Partial token/cost usage from the current step before the pause.
   * Carried so the engine's retry-accumulator can fold prior failed
   * attempts' billed cost into the awaiting_approval trace entry instead
   * of hardcoding zero. Defaults to 0 for executors that pause without
   * doing LLM work first (the common case — `human_approval`).
   */
  public readonly tokensUsed: number;
  public readonly costUsd: number;

  constructor(stepId: string, payload: unknown, tokensUsed = 0, costUsd = 0) {
    super(`Workflow paused for approval at step "${stepId}"`);
    this.name = 'PausedForApproval';
    this.stepId = stepId;
    this.payload = payload;
    this.tokensUsed = tokensUsed;
    this.costUsd = costUsd;
  }
}

/**
 * Thrown by the engine when `totalCostUsd` exceeds `budgetLimitUsd`.
 * Results in a terminal `workflow_failed` event with `error: 'Budget exceeded'`.
 */
export class BudgetExceeded extends Error {
  public readonly usedUsd: number;
  public readonly limitUsd: number;
  /**
   * Partial token/cost from the current step that triggered the budget
   * check. Distinct from `usedUsd` (the running execution total). Carried
   * so retry-loop accumulators can fold prior attempts' billed cost into
   * the failure trace entry. Defaults to 0 — only set when the engine
   * has a non-zero accumulator at the throw site.
   */
  public readonly tokensUsed: number;
  public readonly costUsd: number;

  constructor(usedUsd: number, limitUsd: number, tokensUsed = 0, costUsd = 0) {
    super(`Budget exceeded: $${usedUsd.toFixed(4)} / $${limitUsd.toFixed(4)}`);
    this.name = 'BudgetExceeded';
    this.usedUsd = usedUsd;
    this.limitUsd = limitUsd;
    this.tokensUsed = tokensUsed;
    this.costUsd = costUsd;
  }
}

/** The code a provider-policy refusal carries, here and on `ProviderCallRefusedError`. */
export const PROVIDER_NOT_PERMITTED = 'provider_not_permitted';

/**
 * Whether `cause`, or anything it wraps, is a provider-policy refusal: the
 * call-time gate's `ProviderCallRefusedError`, or an `ExecutorError` already
 * coded for one (§120 t-741). Read by duck type on `code` so this module keeps
 * no imports; bounded, because a `cause` chain is caller-built.
 */
function isPolicyRefusal(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
    if ((current as Error & { code?: unknown }).code === PROVIDER_NOT_PERMITTED) return true;
    current = current.cause;
  }
  return false;
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
    // A provider-policy refusal anywhere in the cause chain decides the code
    // and the retry verdict, whatever the wrapping executor passed. One rule
    // here rather than a check in each executor: the per-executor version
    // missed the orchestrator and `rag_retrieve`, and would miss a fork's. A
    // refusal is the same answer on every attempt, so it is never retriable,
    // and traces and alerts filter on the one code.
    const refused = isPolicyRefusal(cause);
    this.code = refused ? PROVIDER_NOT_PERMITTED : code;
    this.cause = cause;
    this.retriable = refused ? false : retriable;
    this.tokensUsed = tokensUsed;
    this.costUsd = costUsd;
  }
}
