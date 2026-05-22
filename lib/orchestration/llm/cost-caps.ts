/**
 * Per-execution + per-turn cost-cap resolvers.
 *
 * Sunrise enforces a monthly per-agent budget via `checkBudget()` in
 * `cost-tracker.ts`. These helpers resolve the additional **single-run** caps
 * introduced by improvement #39:
 *
 *   - Per-execution (workflows): defends against a `reflect` / `orchestrator`
 *     loop or misbehaving capability burning through a month's budget in
 *     one run. Enforced after every cost-emitting step by the engine
 *     (`lib/orchestration/engine/orchestration-engine.ts`).
 *
 *   - Per-turn (chat + workflow agent_call): defends against a tool-loop
 *     iteration that ping-pongs LLM ↔ tool calls without converging.
 *     Enforced inside the streaming chat handler after every LLM turn /
 *     tool dispatch, AND inside the `agent_call` workflow executor's
 *     iteration loop so a per-turn cap on an agent applies regardless
 *     of how the agent is invoked.
 *
 * Resolution order is the same shape both: caller / entity / org default,
 * first non-null wins, `undefined` if none set (= unlimited at this layer).
 * The resolved per-execution value is persisted onto
 * `AiWorkflowExecution.budgetLimitUsd` at execution-creation time so
 * resumes and the lease-reaper path inherit it without re-resolving.
 *
 * Both helpers are pure (no DB / IO). Inputs come from the caller — the
 * agent / workflow / settings rows are loaded by the call site so we don't
 * impose a particular query pattern.
 */

/** Arguments for `resolveMaxCostPerExecution`. */
export interface ResolveMaxCostPerExecutionArgs {
  /** Explicit value supplied by the caller (execute API, capability, rerun). */
  callerOverride: number | null | undefined;
  /** `AiWorkflow.maxCostPerExecutionUsd` for the workflow being executed. */
  workflowDefault: number | null | undefined;
  /** `AiOrchestrationSettings.defaultMaxCostPerExecutionUsd`. */
  settingsDefault: number | null | undefined;
}

/**
 * Resolve the effective per-execution cap. Returns `undefined` when no
 * layer sets a value — the engine treats that as "no cap" (only the
 * monthly budget applies).
 *
 * Resolution: caller > workflow > settings > undefined.
 */
export function resolveMaxCostPerExecution(
  args: ResolveMaxCostPerExecutionArgs
): number | undefined {
  return firstFinitePositive(args.callerOverride, args.workflowDefault, args.settingsDefault);
}

/** Arguments for `resolveMaxCostPerTurn`. */
export interface ResolveMaxCostPerTurnArgs {
  /** `AiAgent.maxCostPerTurnUsd` for the agent serving the chat. */
  agentDefault: number | null | undefined;
  /** `AiOrchestrationSettings.defaultMaxCostPerTurnUsd`. */
  settingsDefault: number | null | undefined;
}

/**
 * Resolve the effective per-turn cap for chat. Returns `undefined` when
 * neither agent nor settings sets a value — the chat handler treats that
 * as "no per-turn cap" (the monthly budget check still runs).
 *
 * Resolution: agent > settings > undefined.
 */
export function resolveMaxCostPerTurn(args: ResolveMaxCostPerTurnArgs): number | undefined {
  return firstFinitePositive(args.agentDefault, args.settingsDefault);
}

/**
 * Pick the first value that is a finite, strictly-positive number.
 *
 * We reject 0, NaN, Infinity, and negative values defensively so a stale
 * or corrupt DB row never silently becomes a hard "block everything" cap.
 * The Zod layer at `lib/validations/orchestration.ts` enforces `min(0.01)`
 * on write, but this guard keeps the read path honest if the DB ever
 * drifts (manual SQL, restore from old backup, etc.).
 */
function firstFinitePositive(...values: Array<number | null | undefined>): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}
