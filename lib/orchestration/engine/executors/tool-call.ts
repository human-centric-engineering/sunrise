/**
 * `tool_call` — invoke a registered capability.
 *
 * Config:
 *   - `capabilitySlug: string` (required, validated upstream)
 *   - `args?: Record<string, unknown>` — passed through to the dispatcher.
 *     When omitted, `ctx.inputData` is forwarded instead.
 *   - `argsFrom?: string` — step ID whose output should be used as args.
 *     Takes precedence over `ctx.inputData` but not over explicit `args`.
 *
 * Workflow executions aren't bound to a specific `AiAgent`, so we pass
 * a sentinel `agentId` of the form `workflow:${workflowId}` to the
 * dispatcher. This keeps rate limits scoped per-workflow and prevents
 * accidental collision with a real agent's bucket. The capability
 * registry uses opt-out semantics, so a missing pivot row just means
 * "use the capability's defaults", which is what workflows want.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import { toolCallConfigSchema } from '@/lib/validations/orchestration';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import {
  buildIdempotencyKey,
  lookupDispatch,
  recordDispatch,
} from '@/lib/orchestration/engine/dispatch-cache';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';

export async function executeToolCall(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = toolCallConfigSchema.parse(step.config);
  const slug = config.capabilitySlug;
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new ExecutorError(
      step.id,
      'missing_capability_slug',
      'tool_call step is missing capabilitySlug',
      undefined,
      false
    );
  }

  // Resolve the capability's `isIdempotent` flag from the registry. A registry
  // miss (cache cold, capability unknown) defaults to `false`: the conservative
  // assumption is that a capability has side effects, so a re-drive must
  // consult the dispatch cache rather than re-invoke. The dispatcher itself
  // re-validates the slug a few lines later — this read is purely the
  // idempotency hint.
  await capabilityDispatcher.loadFromDatabase();
  const entry = capabilityDispatcher.getRegistryEntry(slug);
  const isIdempotent = entry?.isIdempotent ?? false;

  // Crash-safe re-run: when the capability isn't idempotent at the destination,
  // a prior successful dispatch's StepResult is cached on the dispatch table
  // by `${executionId}:${stepId}`. A cache hit returns the cached result and
  // the dispatcher is never re-invoked. Idempotent capabilities skip this
  // (their destination handles dedup; a re-invocation is harmless).
  //
  // Posture symmetry with `recordDispatch`: a transient DB hiccup at lookup
  // time is treated as a cache miss (warn-and-continue), matching the
  // post-dispatch recordDispatch failure handling.
  const cacheKey = buildIdempotencyKey({ executionId: ctx.executionId, stepId: step.id });
  if (!isIdempotent) {
    let cached: StepResult | null = null;
    try {
      cached = await lookupDispatch<StepResult>(cacheKey);
    } catch (err) {
      ctx.logger.warn('tool_call: dispatch cache lookup failed; treating as miss', {
        stepId: step.id,
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (cached !== null) {
      ctx.logger.info('tool_call: dispatch cache hit, skipping capability invocation', {
        stepId: step.id,
        slug,
      });
      return cached;
    }
  }

  // Priority: explicit args > argsFrom (step output reference) > ctx.inputData
  let rawArgs: Record<string, unknown>;
  if (config.args) {
    rawArgs = config.args;
  } else if (config.argsFrom && ctx.stepOutputs[config.argsFrom] != null) {
    const fromOutput = ctx.stepOutputs[config.argsFrom];
    rawArgs =
      typeof fromOutput === 'object' && !Array.isArray(fromOutput)
        ? (fromOutput as Record<string, unknown>)
        : { data: fromOutput };
  } else {
    rawArgs = ctx.inputData;
  }

  const result = await capabilityDispatcher.dispatch(slug, rawArgs, {
    userId: ctx.userId,
    agentId: `workflow:${ctx.workflowId}`,
  });

  if (!result.success) {
    const code = result.error?.code ?? 'capability_failed';
    // Only rate_limited and execution_error are potentially transient;
    // all other dispatcher errors (unknown_capability, capability_inactive,
    // capability_disabled_for_agent, invalid_args, requires_approval) are
    // permanent and should not be retried.
    const TRANSIENT_CODES = new Set(['rate_limited', 'execution_error']);
    throw new ExecutorError(
      step.id,
      code,
      result.error?.message ?? 'Capability dispatch failed',
      undefined,
      TRANSIENT_CODES.has(code)
    );
  }

  const stepResult: StepResult = {
    output: result.data ?? null,
    tokensUsed: 0,
    costUsd: 0,
  };

  // Record the dispatch so a re-drive after a crash returns this result instead
  // of re-invoking. Skipped for idempotent capabilities — no need to grow the
  // cache when the destination already handles re-runs. `recordDispatch`
  // returns `false` on a P2002 race-loss; we discard the boolean because the
  // loser of the dispatch-row race is the loser of the lease race, and PR 1's
  // lease-loss model cancels the loser's terminal events. Other DB errors are
  // non-fatal — log and continue.
  if (!isIdempotent) {
    try {
      await recordDispatch({
        executionId: ctx.executionId,
        stepId: step.id,
        result: stepResult,
      });
    } catch (err) {
      ctx.logger.warn('tool_call: failed to record dispatch; re-drive may re-invoke', {
        stepId: step.id,
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return stepResult;
}

registerStepType('tool_call', executeToolCall);
