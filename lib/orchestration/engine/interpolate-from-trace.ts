/**
 * Client-side resolver for "what did the LLM actually see at this step?"
 *
 * The execution trace records each step's `input` field as its raw
 * config snapshot — `{{stepId.output}}` placeholders intact. The actual
 * interpolation happens inside the executor (see
 * `interpolate-prompt.ts`) and is not stored in the trace.
 *
 * The admin trace viewer can re-derive the interpolated form by
 * running the same interpolator against the trace's accumulated step
 * outputs. This module is the bridge: take a trace + execution input,
 * walk a step's `input` object, and return a same-shape object with
 * every string leaf re-interpolated.
 *
 * **Caveats:**
 * - `{{vars.foo}}` references resolve only against what the trace
 *   carries. Internal engine vars like `vars.__retryContext` are set
 *   transiently by the retry path and not persisted to the trace, so
 *   they render as the empty string here even when the engine saw a
 *   value at run time.
 * - This is a re-derivation, not the recorded LLM input. If the
 *   interpolator's behaviour changes after a run, the viewer renders
 *   the new logic against the old data.
 */

import type { InterpolationContext } from '@/lib/orchestration/engine/interpolate-prompt';
import type { ExecutionTraceEntry } from '@/types/orchestration';

/**
 * Build an interpolation context from an execution's trace and input.
 *
 * Each completed (or awaiting) step's output is keyed by its `stepId`,
 * so a downstream step's `{{prevStep.output}}` resolves to the output
 * the engine saw at run time. Unrun steps contribute nothing.
 *
 * `previousStepId` should be the id of the step running just before the
 * one whose template you're resolving — used for `{{previous.output}}`.
 * Pass `undefined` if you want that reference to expand to empty.
 */
export function buildInterpolationContextFromTrace(
  trace: ExecutionTraceEntry[],
  inputData: unknown,
  /** Variables the engine had at run time, when known. Empty by default. */
  variables: Record<string, unknown> = {}
): InterpolationContext {
  const stepOutputs: Record<string, unknown> = {};
  for (const entry of trace) {
    if (entry.output !== undefined && entry.output !== null) {
      stepOutputs[entry.stepId] = entry.output;
    }
  }
  return {
    inputData:
      inputData && typeof inputData === 'object' && !Array.isArray(inputData)
        ? (inputData as Record<string, unknown>)
        : {},
    stepOutputs,
    variables,
  };
}

/**
 * Find the id of the step that ran immediately before `targetStepId`
 * in the trace. Returns undefined when the target is first or absent.
 *
 * Mirrors the engine's `previousStepId` semantics: the most recent
 * completed step, NOT necessarily a structural predecessor in the DAG.
 */
export function findPreviousStepId(
  trace: ExecutionTraceEntry[],
  targetStepId: string
): string | undefined {
  const idx = trace.findIndex((e) => e.stepId === targetStepId);
  if (idx <= 0) return undefined;
  return trace[idx - 1].stepId;
}

/**
 * The walker the engine's `tool_call` executor also uses, so the trace
 * viewer's "Resolve templates" view and the args a step actually sent agree.
 * It lives beside `interpolatePrompt`; re-exported here for the viewer.
 */
export { resolveTemplatesIn } from '@/lib/orchestration/engine/interpolate-prompt';

/**
 * Returns true when the given value (or any leaf of it) contains a
 * `{{...}}` template token. Cheap heuristic for showing or hiding the
 * "Resolve templates" affordance in the trace viewer.
 */
export function hasTemplateTokens(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{');
  if (Array.isArray(value)) return value.some(hasTemplateTokens);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasTemplateTokens);
  }
  return false;
}
