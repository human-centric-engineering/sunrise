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
 *   - `{{vars.<path>}}`           → drills into ctx.variables along the
 *                                   dotted path; e.g.
 *                                   `vars.__retryContext.failureReason`.
 *   - `{{#if vars.<path>}}body{{/if}}`
 *                                 → body is included only when the
 *                                   resolved value is truthy. Flat
 *                                   conditionals only — bodies must not
 *                                   contain another `{{#if ...}}`.
 *
 * Missing references expand to the empty string — mirrors the common
 * template-engine behaviour and keeps executors from needing to
 * understand template failures.
 */
export interface InterpolateOptions {
  /**
   * How object/array values are stringified when an interpolation
   * expands to a non-string.
   *   - `'plain'` (default): `JSON.stringify(value)` — compact single
   *     line, suitable for LLM prompts where token efficiency matters.
   *   - `'markdown'`: pretty-printed JSON wrapped in a fenced
   *     ```json``` block. Suitable for prompts that get rendered as
   *     markdown to humans (e.g. the human_approval step's prompt
   *     shown to admins in the approval queue).
   */
  format?: 'plain' | 'markdown';
}

export function interpolatePrompt(
  template: string,
  ctx: Readonly<ExecutionContext>,
  previousStepId?: string,
  options?: InterpolateOptions
): string {
  const stringify = options?.format === 'markdown' ? stringifyMarkdownValue : stringifyValue;

  // First pass: resolve flat `{{#if EXPR}}BODY{{/if}}` conditionals.
  // Body match is non-greedy so multiple flat conditionals on the same
  // line each terminate at their own `{{/if}}`.
  const withoutConditionals = template.replace(
    /\{\{#if\s+([^}]+?)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, rawExpr: string, body: string) => {
      const expr = rawExpr.trim();
      const value = expr.startsWith('vars.')
        ? resolveDottedPath(ctx.variables, expr.slice('vars.'.length))
        : undefined;
      return isTruthy(value) ? body : '';
    }
  );

  // Second pass: resolve single-token `{{...}}` references.
  return withoutConditionals.replace(/\{\{([^}]+)\}\}/g, (_match, rawExpr: string) => {
    const expr = rawExpr.trim();

    if (expr === 'input') {
      // `input` is special: when ctx.inputData is a primitive string we
      // emit it raw (no JSON quoting); otherwise stringify through the
      // configured stringifier so markdown callers get a fenced block.
      return typeof ctx.inputData === 'string' ? ctx.inputData : stringify(ctx.inputData);
    }

    if (expr.startsWith('input.')) {
      const key = expr.slice('input.'.length);
      const value = ctx.inputData[key];
      return stringify(value);
    }

    if (expr === 'previous.output') {
      if (!previousStepId) return '';
      return stringify(ctx.stepOutputs[previousStepId]);
    }

    if (expr.startsWith('vars.')) {
      return stringify(resolveDottedPath(ctx.variables, expr.slice('vars.'.length)));
    }

    const dotIdx = expr.lastIndexOf('.');
    if (dotIdx > 0 && expr.slice(dotIdx + 1) === 'output') {
      const stepId = expr.slice(0, dotIdx);
      return stringify(ctx.stepOutputs[stepId]);
    }

    return '';
  });
}

function resolveDottedPath(root: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
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

/**
 * Markdown-aware variant. Pretty-prints object/array values and wraps
 * them in a fenced ```json``` block so they render as a readable code
 * block when the interpolated prompt is shown through a markdown
 * renderer. Strings that happen to parse as JSON are unwrapped first
 * — this is a common pattern for upstream LLM steps that emit
 * stringified JSON (e.g. the `reflect` step's `finalDraft` field). All
 * other primitive values stringify as-is.
 */
function stringifyMarkdownValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (typeof value === 'string') {
    // Detect a string that's actually JSON-encoded structured data
    // (object or array) and unwrap so we render the structure rather
    // than the escaped one-line form. Plain strings pass through.
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object') {
          return fencedJson(parsed);
        }
      } catch {
        // not JSON — fall through to the raw string path
      }
    }
    return value;
  }

  return fencedJson(value);
}

function fencedJson(value: unknown): string {
  try {
    const body = JSON.stringify(value, null, 2);
    if (body === undefined) return '';
    return `\n\n\`\`\`json\n${body}\n\`\`\`\n\n`;
  } catch {
    return '[unserializable]';
  }
}
