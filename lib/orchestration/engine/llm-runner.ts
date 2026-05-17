/**
 * Shared helper for running a one-shot LLM call from inside a step
 * executor.
 *
 * Wraps the full "resolve model → resolve provider → call `chat()` →
 * accumulate cost" dance so each executor that needs an LLM stays
 * ~10 lines. Also handles:
 *
 *   - Resolving an empty/missing `modelOverride` to the task-default.
 *   - Template interpolation on the prompt (`{{input}}`, `{{input.foo}}`,
 *     `{{previous.output}}`, `{{<stepId>.output}}`).
 *   - Fire-and-forget `logCost()` so an accounting failure never blocks
 *     the step.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import type { LlmResponseFormat } from '@/lib/orchestration/llm/types';
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
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
  /** Request structured JSON output from the model. */
  responseFormat?: LlmResponseFormat;
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

      const modelId =
        params.modelOverride && params.modelOverride.length > 0
          ? params.modelOverride
          : await getDefaultModelForTask('chat');

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
          ...(params.responseFormat ? { responseFormat: params.responseFormat } : {}),
          signal: ctx.signal,
        });
      } catch (err) {
        throw new ExecutorError(
          params.stepId,
          'llm_call_failed',
          err instanceof Error ? err.message : 'LLM call failed',
          err
        );
      }
      const callDurationMs = Date.now() - callStarted;

      // Telemetry: record this turn for the engine to roll up into the trace
      // entry. The engine pre-allocates the array on the snapshot via
      // `snapshotContext(ctx, telemetryOut)`; test harnesses that don't care
      // about telemetry leave the field undefined and the optional chain
      // silently no-ops.
      ctx.stepTelemetry?.push({
        model: modelId,
        provider: modelInfo.provider,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        durationMs: callDurationMs,
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
        model: modelId,
        provider: modelInfo.provider,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        operation: CostOperation.CHAT,
        isLocal: cost.isLocal,
        traceId: span.traceId(),
        spanId: span.spanId(),
        metadata: { stepId: params.stepId },
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
