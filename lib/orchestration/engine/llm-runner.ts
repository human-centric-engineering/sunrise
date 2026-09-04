/**
 * Shared helper for running a one-shot LLM call from inside a step
 * executor.
 *
 * Wraps the full "resolve model → resolve provider → call `chat()` →
 * accumulate cost" dance so each executor that needs an LLM stays
 * ~10 lines. Also handles:
 *
 *   - Resolving an empty/missing `modelOverride` to the task-default, and
 *     checking the resulting provider against the eligibility seam — a
 *     task-default model is Sunrise's choice, so a fork's policy applies to it.
 *     An explicit override is the operator's and is left alone.
 *   - Template interpolation on the prompt (`{{input}}`, `{{input.foo}}`,
 *     `{{previous.output}}`, `{{<stepId>.output}}`).
 *   - Fire-and-forget `logCost()` so an accounting failure never blocks
 *     the step.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import type { LlmRequestParamsSnapshot } from '@/types/orchestration';
import type { LlmResponseFormat, ReasoningEffort } from '@/lib/orchestration/llm/types';
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import { isProviderEligible } from '@/lib/orchestration/llm/provider-eligibility';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { isRequestFault, ProviderError } from '@/lib/orchestration/llm/provider';
import { interpolatePrompt } from '@/lib/orchestration/engine/interpolate-prompt';
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_SYSTEM,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  SPAN_LLM_CALL,
  SUNRISE_COST_USD,
  SUNRISE_EXECUTION_ID,
  SUNRISE_STEP_ID,
  setSpanAttributes,
  withSpan,
} from '@/lib/orchestration/tracing';

export interface LlmRunParams {
  stepId: string;
  prompt: string;
  modelOverride?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * How much reasoning the model should do before producing visible
   * output. Honoured only by reasoning-capable models (the OpenAI
   * o-series / gpt-5 families and Anthropic Claude 4 thinking models);
   * silently dropped on others. See `lib/orchestration/llm/types.ts`
   * for the per-provider mapping.
   */
  reasoningEffort?: ReasoningEffort;
  /** Request structured JSON output from the model. */
  responseFormat?: LlmResponseFormat;
  /**
   * Origin tag for steps whose `ctx.stepTelemetry` mixes calls of
   * different intent (today: only `orchestrator`'s planner call).
   * Forwarded onto the telemetry entry so `rollupTelemetry` can pick
   * the planner's identity for the trace headline instead of whichever
   * delegation ran last. Omit on single-purpose calls.
   */
  source?: 'planner' | 'delegation';
  /** Most recent step id, used to resolve `{{previous.output}}`. */
  previousStepId?: string;
}

export interface LlmRunResult {
  content: string;
  tokensUsed: number;
  costUsd: number;
  model: string;
}

/**
 * Run a single LLM turn and return `{ content, tokensUsed, costUsd }`.
 *
 * Throws `ExecutorError` on any provider/model/config failure — the
 * engine catches it and applies the step's `errorStrategy`.
 */
export async function runLlmCall(
  ctx: Readonly<ExecutionContext>,
  params: LlmRunParams
): Promise<LlmRunResult> {
  return withSpan(
    SPAN_LLM_CALL,
    {
      [GEN_AI_OPERATION_NAME]: 'chat',
      [SUNRISE_STEP_ID]: params.stepId,
      [SUNRISE_EXECUTION_ID]: ctx.executionId,
      [GEN_AI_REQUEST_TEMPERATURE]: params.temperature,
      [GEN_AI_REQUEST_MAX_TOKENS]: params.maxTokens,
    },
    async (span) => {
      const interpolated = interpolatePrompt(params.prompt, ctx, params.previousStepId);

      // Held rather than folded into `modelId`, because the eligibility check
      // below turns on WHERE the model came from, not on what it is.
      const override =
        params.modelOverride && params.modelOverride.length > 0 ? params.modelOverride : null;
      const modelId = override ?? (await getDefaultModelForTask('chat'));

      const modelInfo = getModel(modelId);
      if (!modelInfo) {
        throw new ExecutorError(
          params.stepId,
          'unknown_model',
          `Model "${modelId}" is not in the model registry`
        );
      }

      setSpanAttributes(span, {
        [GEN_AI_REQUEST_MODEL]: modelId,
        [GEN_AI_SYSTEM]: modelInfo.provider,
      });

      // The second provider-eligibility chokepoint (t-658). Nothing here goes
      // through `resolveAgentProviderAndModel` — a step reads the model
      // registry directly — so the seam has to be consulted on the spot or a
      // fork's policy simply does not apply to workflow steps.
      //
      // Only when there is NO override. An override is an operator's recorded
      // choice in the workflow definition, the same category as an explicit
      // `agent.provider`, which the seam also leaves alone; rerouting it would
      // run a step on a provider its own definition does not name. With no
      // override, Sunrise picked the task default and then inherited whatever
      // provider that model happens to name — nobody's intent to override.
      if (override === null) {
        const permitted = await isProviderEligible(modelInfo.provider, {
          task: 'chat',
          source: 'primary',
          primarySlug: null,
        });
        if (!permitted) {
          // Operator detail in the log, not in the message: `ExecutorError`'s
          // message reaches the SSE client, and the workflow path has no scrub
          // of its own. Same split the agent resolver uses.
          logger.error('Workflow step blocked: the default model resolves to a barred provider', {
            stepId: params.stepId,
            executionId: ctx.executionId,
            modelId,
            providerSlug: modelInfo.provider,
            fix: 'The rule registered via registerProviderEligibility() in lib/app/llm-providers.ts did not permit this provider — by policy, or because it threw (a rule that cannot be evaluated denies). Either point the chat task default at a permitted model, give the step an explicit modelOverride, or widen the rule.',
          });
          // NOT retriable. A policy denial is deterministic, so a `retry`
          // strategy would spend the step's whole retry budget re-asking a
          // question whose answer cannot change within the run.
          throw new ExecutorError(
            params.stepId,
            'provider_not_permitted',
            'The model for this step resolves to a provider this deployment does not permit',
            undefined,
            false
          );
        }
      }

      let provider;
      try {
        provider = await getProvider(modelInfo.provider);
      } catch (err) {
        throw new ExecutorError(
          params.stepId,
          'provider_unavailable',
          `Provider "${modelInfo.provider}" unavailable`,
          err
        );
      }

      const callStarted = Date.now();
      let response;
      try {
        response = await provider.chat([{ role: 'user', content: interpolated }], {
          model: modelId,
          temperature: params.temperature,
          maxTokens: params.maxTokens,
          ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
          ...(params.responseFormat ? { responseFormat: params.responseFormat } : {}),
          signal: ctx.signal,
        });
      } catch (err) {
        // Honour a deterministic provider verdict. `responseFormat` reaches
        // here from `llm_call` step config, so a truncated structured
        // extraction lands as a non-retriable `truncated_no_output` — and the
        // step's `retry` strategy would otherwise re-issue it at the same cap
        // until `retryCount` ran out.
        const billed = err instanceof ProviderError ? err.usage : undefined;
        // Carry what the vendor billed before it gave up. A truncation is a
        // full cap's worth of output — the most expensive attempt a step can
        // make — and `ExecutorError`'s `tokensUsed`/`costUsd` are exactly the
        // slots the engine's retry accumulator reads (orchestration-engine.ts).
        // Leaving them 0 under-reports the execution total for the priciest
        // call it made. Same hole `streamChat` closes on its own error path.
        throw new ExecutorError(
          params.stepId,
          'llm_call_failed',
          err instanceof Error ? err.message : 'LLM call failed',
          err,
          !isRequestFault(err),
          billed ? billed.inputTokens + billed.outputTokens : 0,
          billed ? calculateCost(modelId, billed.inputTokens, billed.outputTokens).totalCostUsd : 0
        );
      }
      const callDurationMs = Date.now() - callStarted;

      // Telemetry: record this turn for the engine to roll up into the trace
      // entry. The engine pre-allocates the array on the snapshot via
      // `snapshotContext(ctx, telemetryOut)`; test harnesses that don't care
      // about telemetry leave the field undefined and the optional chain
      // silently no-ops.
      const requestParams: LlmRequestParamsSnapshot = {};
      if (params.maxTokens !== undefined) requestParams.maxTokens = params.maxTokens;
      if (params.temperature !== undefined) requestParams.temperature = params.temperature;
      if (params.responseFormat) requestParams.responseFormat = params.responseFormat.type;
      if (params.reasoningEffort) requestParams.reasoningEffort = params.reasoningEffort;
      ctx.stepTelemetry?.push({
        model: modelId,
        provider: modelInfo.provider,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        durationMs: callDurationMs,
        ...(Object.keys(requestParams).length > 0 ? { requestParams } : {}),
        ...(params.source ? { source: params.source } : {}),
      });

      const cost = calculateCost(modelId, response.usage.inputTokens, response.usage.outputTokens);

      const totalTokens = response.usage.inputTokens + response.usage.outputTokens;
      setSpanAttributes(span, {
        [GEN_AI_RESPONSE_MODEL]: modelId,
        [GEN_AI_USAGE_INPUT_TOKENS]: response.usage.inputTokens,
        [GEN_AI_USAGE_OUTPUT_TOKENS]: response.usage.outputTokens,
        [GEN_AI_USAGE_TOTAL_TOKENS]: totalTokens,
        [SUNRISE_COST_USD]: cost.totalCostUsd,
      });

      // Fire-and-forget. Cost logging failure must never surface as a
      // step failure — accounting is best-effort.
      void logCost({
        workflowExecutionId: ctx.executionId,
        userId: ctx.userId,
        model: modelId,
        provider: modelInfo.provider,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        operation: CostOperation.CHAT,
        isLocal: cost.isLocal,
        traceId: span.traceId(),
        spanId: span.spanId(),
        // `ctx.costLogMetadata` first, `stepId` last — same precedence rule as
        // the dispatcher: the engine's own attribution key wins.
        //
        // #600 described this file as already forwarding the carrier. It was
        // not: `llm_call` rows carried `stepId` and nothing else, so an
        // evaluation run's `{ evaluationRunId, role }` tags were missing from
        // every LLM step as well as from every tool call. Found by enumerating
        // the `logCost` sites rather than by reading the issue.
        metadata: { ...(ctx.costLogMetadata ?? {}), stepId: params.stepId },
      }).catch((err: unknown) => {
        logger.warn('runLlmCall: logCost rejected', {
          executionId: ctx.executionId,
          stepId: params.stepId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      return {
        content: response.content,
        tokensUsed: totalTokens,
        costUsd: cost.totalCostUsd,
        model: modelId,
      };
    }
  );
}

// Template interpolation lives in a separate module so the admin trace
// viewer can re-run the same logic client-side. Re-exported here for
// backward compat — every existing `import { interpolatePrompt } from
// '@/lib/orchestration/engine/llm-runner'` keeps working.
export { interpolatePrompt };
export type {
  InterpolateOptions,
  InterpolationContext,
} from '@/lib/orchestration/engine/interpolate-prompt';
