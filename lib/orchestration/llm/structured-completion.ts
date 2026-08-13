/**
 * Structured-output runner for LLM calls.
 *
 * Wraps the call → parse → retry-once-on-malformed-JSON pattern that any
 * caller needing a shape-validated single completion wants. Keeping the
 * retry policy in one place ensures every call site:
 *  - never include the malformed prior response in the retry prompt
 *    (don't trust output that just misbehaved);
 *  - drop temperature to 0 on retry;
 *  - sum input/output tokens across both attempts so cost accounting is
 *    accurate.
 *
 * Neutral LLM utility — no evaluation coupling, no Next.js imports. Callers
 * tag their own `phase` (see the field docs) so spans/costs are labelled by
 * whatever operation is running (`'summary'`/`'scoring'` for evaluations, a
 * caller-specific string like `'slot-extraction'` for anything else).
 *
 * ## Contract: this module PERSISTS NOTHING (#472)
 *
 * Neither the prompt nor the completion is written anywhere. No database client
 * is imported, no row is created, and nothing is logged that contains prompt or
 * completion text. A call goes to the provider, the response is parsed, and the
 * text is returned to the caller and then forgotten.
 *
 * **This is a guarantee, not an accident of the current implementation.** It was
 * previously only incidentally true — the docstring promised *layering*
 * neutrality ("no evaluation coupling, no Next.js imports"), which says nothing
 * about writes. Callers had begun to depend on the stronger property: a fork
 * categorising calendar-event titles into aggregate buckets persists only the
 * per-bucket totals and makes a user-facing privacy claim that no title,
 * attendee or description is ever stored. Under the weaker reading, adding
 * prompt logging for debugging or completion persistence for eval replay would
 * have been an entirely reasonable change that silently broke that claim without
 * touching a line of the fork's code.
 *
 * So it is now contractual, and enforced by
 * `tests/unit/lib/orchestration/llm/structured-completion-no-persistence.test.ts`,
 * which fails if this module gains a database import or a `prisma.*` call.
 *
 * If a future feature genuinely needs to persist here, that is a **breaking
 * change to a documented guarantee**: it needs an opt-in flag defaulting to off,
 * a CHANGELOG entry saying so, and the test above updated deliberately rather
 * than deleted to make a build pass.
 *
 * Note the boundary: cost *metadata* (token counts, USD) is returned to the
 * caller, and a caller may well persist that. Aggregate token counts carry no
 * prompt content, so that is outside this guarantee.
 */

import { calculateCost } from '@/lib/orchestration/llm/cost-tracker';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import type { LlmFinishReason, LlmMessage, LlmResponseFormat } from '@/lib/orchestration/llm/types';
import type { getProvider } from '@/lib/orchestration/llm/provider-manager';
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  SPAN_LLM_CALL,
  SUNRISE_EVALUATION_PHASE,
  setSpanAttributes,
  withSpan,
} from '@/lib/orchestration/tracing';

type LlmProvider = Awaited<ReturnType<typeof getProvider>>;

export interface StructuredCompletionOptions<T> {
  provider: LlmProvider;
  model: string;
  messages: LlmMessage[];
  parse: (raw: string) => T | null;
  /** Sent as a `user` message on retry. Should describe the expected shape. */
  retryUserMessage: string;
  /**
   * Optional JSON Schema to enforce as provider-native structured output.
   * When present, it is forwarded as `responseFormat` on BOTH the first
   * attempt and the temp-0 retry, so the model is constrained to the shape
   * rather than relying on the prompt's prose alone.
   *
   * Providers that support it constrain the response (OpenAI-compatible via
   * `response_format: { type: 'json_schema', ... }`; Anthropic via a forced
   * single-tool extraction whose input is serialized back into the response
   * string). Providers without support ignore it — so `parse` plus the
   * existing temp-0 retry remain the cross-provider safety net, and the
   * prompt's prose contract should still describe the shape as a
   * belt-and-suspenders fallback.
   *
   * Contract: supply a **non-empty, object-rooted** JSON Schema. An empty
   * (`{}`) or undefined schema is treated as "no enforcement" and forwarded
   * as nothing. A non-object root (top-level array / `oneOf` / `$ref`) is
   * not portable — the Anthropic tool-extraction path coerces the root to
   * `object`, so wrap such shapes in an object property.
   */
  responseSchema?: Record<string, unknown>;
  /**
   * Name for the enforced schema — required by OpenAI's `json_schema`
   * format and surfaced as the Anthropic extraction tool name. Defaults to
   * `'structured_output'` when a `responseSchema` is supplied without one.
   *
   * On Anthropic the name is prefixed into a tool name (`__structured_<name>`)
   * that must satisfy the provider's tool-name charset (`^[a-zA-Z0-9_-]{1,64}$`
   * after the prefix), so prefer a short snake/kebab identifier — avoid spaces
   * and punctuation, or keep the default.
   */
  responseSchemaName?: string;
  /**
   * Opt into OpenAI strict mode. Strict requires the schema to set
   * `additionalProperties: false` and list every property in `required`; an
   * un-normalized `z.toJSONSchema` output will be rejected by the provider.
   * Left undefined (non-strict) by default — the lower-risk choice that
   * still forwards the shape. Ignored by providers without strict support.
   */
  responseSchemaStrict?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Optional caller-supplied error to throw when both attempts fail.
   *
   * **Not consulted when the failure is a truncation** (`finishReason:
   * 'length'`). This hook exists to phrase "the model broke my contract",
   * and on a truncation that premise is false — the response was cut off at
   * the token cap, so there was never a complete answer to check against the
   * schema. The runner throws its own `ProviderError('truncated_no_output')`
   * instead, so every caller gets the real cause without having to
   * rediscover this one (#587).
   */
  onFinalFailure?: () => Error;
  /**
   * Phase tag for OTEL spans and cost logs — an open string set by the
   * caller (e.g. `'summary'` for an evaluation completion summary,
   * `'scoring'` for metric scoring, `'slot-extraction'` for a capability's
   * structured extraction). Surfaces as `gen_ai.operation.name` and
   * `sunrise.evaluation.phase` on the spans. Omitted → spans fall back to
   * the default `'evaluation'` operation name and carry no phase attribute.
   */
  phase?: string;
}

export interface StructuredCompletionResult<T> {
  value: T;
  tokenUsage: { input: number; output: number };
  costUsd: number;
  /**
   * Finish reason of the attempt that produced `value` (the retry's, when
   * there was one).
   *
   * Worth checking for `'length'` even on success: a lenient `parse` can
   * accept content that happened to be well-formed at the point it was cut
   * off — a truncated array of results reads as a complete short one. The
   * failure path throws, so this field is the only place a caller can see
   * that case.
   */
  finishReason: LlmFinishReason;
}

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The response ran out of token budget before it could be parsed.
 *
 * Reported as `truncated_no_output` — the same code both providers already
 * raise for the cases they can detect themselves (see the truncation guards
 * in `anthropic.ts` and `openai-compatible.ts`), so a caller has one code to
 * catch whichever layer noticed. This layer catches what they cannot: a
 * provider that ignores `responseSchema` altogether, or a caller relying on
 * the prompt's prose contract rather than native structured output.
 */
function truncationError(model: string, maxTokens: number): ProviderError {
  return new ProviderError(
    `Structured completion for model "${model}" was truncated at maxTokens (${maxTokens}) ` +
      `before it could be parsed — the response is incomplete, not schema-invalid. Raise ` +
      `maxTokens: on OpenAI reasoning models this cap is sent as max_completion_tokens and ` +
      `covers hidden reasoning tokens as well as visible output.`,
    { code: 'truncated_no_output', retriable: false }
  );
}

export async function runStructuredCompletion<T>(
  opts: StructuredCompletionOptions<T>
): Promise<StructuredCompletionResult<T>> {
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Build the provider-native structured-output directive once and forward it
  // on both attempts. Providers that don't support it ignore the field. An
  // empty `{}` schema carries no constraint, so it is treated as "no
  // enforcement" rather than forwarded as a degenerate (and strict-rejecting)
  // shape.
  const responseFormat: LlmResponseFormat | undefined =
    opts.responseSchema && Object.keys(opts.responseSchema).length > 0
      ? {
          type: 'json_schema',
          name: opts.responseSchemaName ?? 'structured_output',
          schema: opts.responseSchema,
          ...(opts.responseSchemaStrict !== undefined ? { strict: opts.responseSchemaStrict } : {}),
        }
      : undefined;

  const phaseAttrs = {
    [GEN_AI_OPERATION_NAME]: opts.phase ?? 'evaluation',
    [GEN_AI_REQUEST_MODEL]: opts.model,
    ...(opts.phase ? { [SUNRISE_EVALUATION_PHASE]: opts.phase } : {}),
  };

  const firstSignal = AbortSignal.timeout(timeoutMs);
  const first = await withSpan(
    SPAN_LLM_CALL,
    {
      ...phaseAttrs,
      [GEN_AI_REQUEST_TEMPERATURE]: temperature,
      [GEN_AI_REQUEST_MAX_TOKENS]: maxTokens,
    },
    async (span) => {
      const response = await opts.provider.chat(opts.messages, {
        model: opts.model,
        temperature,
        maxTokens,
        // Both halves: the signal bounds the whole attempt sequence (it is
        // absolute, so retries share it), `timeoutMs` caps the individual HTTP
        // request inside the provider SDK.
        timeoutMs,
        signal: firstSignal,
        ...(responseFormat ? { responseFormat } : {}),
      });
      setSpanAttributes(span, {
        [GEN_AI_RESPONSE_MODEL]: opts.model,
        [GEN_AI_USAGE_INPUT_TOKENS]: response.usage.inputTokens,
        [GEN_AI_USAGE_OUTPUT_TOKENS]: response.usage.outputTokens,
        [GEN_AI_USAGE_TOTAL_TOKENS]: response.usage.inputTokens + response.usage.outputTokens,
      });
      return response;
    }
  );

  const firstParsed = opts.parse(first.content);
  if (firstParsed !== null) {
    const inputTokens = first.usage.inputTokens;
    const outputTokens = first.usage.outputTokens;
    return {
      value: firstParsed,
      tokenUsage: { input: inputTokens, output: outputTokens },
      costUsd: calculateCost(opts.model, inputTokens, outputTokens).totalCostUsd,
      finishReason: first.finishReason,
    };
  }

  // Truncation, not a contract violation — and the retry cannot fix it.
  // Nothing in the content distinguishes "cut off mid-object" from "the model
  // ignored the schema": both arrive as text that `parse` rejects. Only
  // `finishReason` tells them apart, and the retry would run the same cap
  // against a *longer* prompt (the retry message is appended), so it is a
  // second paid call whose failure is already knowable from data we hold.
  //
  // Both providers catch what they can see themselves, but neither covers
  // every route here: a provider may ignore `responseSchema` entirely, and a
  // caller may be relying on the prompt's prose contract instead. This is the
  // provider-agnostic backstop (#587).
  if (first.finishReason === 'length') throw truncationError(opts.model, maxTokens);

  // Retry with a stricter prompt at temperature 0. We do NOT include
  // the malformed prior response — never trust output that just
  // misbehaved as part of a subsequent prompt.
  const retrySignal = AbortSignal.timeout(timeoutMs);
  const retry = await withSpan(
    SPAN_LLM_CALL,
    {
      ...phaseAttrs,
      [GEN_AI_REQUEST_TEMPERATURE]: 0,
      [GEN_AI_REQUEST_MAX_TOKENS]: maxTokens,
    },
    async (span) => {
      const response = await opts.provider.chat(
        [...opts.messages, { role: 'user', content: opts.retryUserMessage }],
        {
          model: opts.model,
          temperature: 0,
          maxTokens,
          timeoutMs,
          signal: retrySignal,
          ...(responseFormat ? { responseFormat } : {}),
        }
      );
      setSpanAttributes(span, {
        [GEN_AI_RESPONSE_MODEL]: opts.model,
        [GEN_AI_USAGE_INPUT_TOKENS]: response.usage.inputTokens,
        [GEN_AI_USAGE_OUTPUT_TOKENS]: response.usage.outputTokens,
        [GEN_AI_USAGE_TOTAL_TOKENS]: response.usage.inputTokens + response.usage.outputTokens,
      });
      return response;
    }
  );

  const retryParsed = opts.parse(retry.content);
  if (retryParsed === null) {
    // The first attempt failed for some other reason and this one ran out of
    // budget — same misdiagnosis, so the same error.
    if (retry.finishReason === 'length') throw truncationError(opts.model, maxTokens);
    if (opts.onFinalFailure) throw opts.onFinalFailure();
    throw new Error('Structured completion response was not valid JSON after retry');
  }

  const inputTokens = first.usage.inputTokens + retry.usage.inputTokens;
  const outputTokens = first.usage.outputTokens + retry.usage.outputTokens;
  return {
    value: retryParsed,
    tokenUsage: { input: inputTokens, output: outputTokens },
    costUsd: calculateCost(opts.model, inputTokens, outputTokens).totalCostUsd,
    finishReason: retry.finishReason,
  };
}
