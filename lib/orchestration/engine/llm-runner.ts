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

  const cost = calculateCost(modelId, response.usage.inputTokens, response.usage.outputTokens);

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
    metadata: { stepId: params.stepId },
  }).catch((err: unknown) => {
    logger.warn('runLlmCall: logCost rejected', {
      executionId: ctx.executionId,
      stepId: params.stepId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const totalTokens = response.usage.inputTokens + response.usage.outputTokens;
  return {
    content: response.content,
    tokensUsed: totalTokens,
    costUsd: cost.totalCostUsd,
    model: modelId,
  };
}

/**
 * Minimal template interpolation.
 *
 *   - `{{input}}`                 → JSON of ctx.inputData or the string
 *                                   form when inputData is a primitive.
 *   - `{{input.key}}`             → ctx.inputData.key (JSON-stringified
 *                                   if not a string).
 *   - `{{previous.output}}`       → ctx.stepOutputs[previousStepId]
 *                                   (JSON-stringified if not a string).
 *   - `{{<stepId>.output}}`       → ctx.stepOutputs[stepId]
 *                                   (JSON-stringified if not a string).
 *
 * Missing references expand to the empty string — mirrors the common
 * template-engine behaviour and keeps executors from needing to
 * understand template failures.
 */
export function interpolatePrompt(
  template: string,
  ctx: Readonly<ExecutionContext>,
  previousStepId?: string
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, rawExpr: string) => {
    const expr = rawExpr.trim();

    if (expr === 'input') {
      return typeof ctx.inputData === 'string'
        ? (ctx.inputData as string)
        : JSON.stringify(ctx.inputData);
    }

    if (expr.startsWith('input.')) {
      const key = expr.slice('input.'.length);
      const value = ctx.inputData[key];
      return stringifyValue(value);
    }

    if (expr === 'previous.output') {
      if (!previousStepId) return '';
      return stringifyValue(ctx.stepOutputs[previousStepId]);
    }

    const dotIdx = expr.lastIndexOf('.');
    if (dotIdx > 0 && expr.slice(dotIdx + 1) === 'output') {
      const stepId = expr.slice(0, dotIdx);
      return stringifyValue(ctx.stepOutputs[stepId]);
    }

    return '';
  });
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}
