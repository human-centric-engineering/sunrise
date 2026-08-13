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
   * Optional caller-supplied error to throw when the attempts are exhausted
   * and nothing parsed.
   *
   * **Not consulted when the final attempt was truncated** (`finishReason:
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
   *
   * **One provider caveat.** On Anthropic with a `responseSchema`, this can
   * never be `'length'`: the adapter reports `'stop'` for a structured
   * extraction (`anthropic.ts`) because it has already thrown on the
   * truncating case, so the mask loses nothing today. Nothing is silently
   * dropped — but don't build a fork's continuation or observability signal
   * on this field alone and expect it to fire there.
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
 *
 * Reaching a caller means the attempts are exhausted, so the cap really is the
 * problem — not that a retry might have fitted.
 *
 * `usage` rides along because throwing is how an attempt unwinds here (so
 * `withSpan` records an error rather than stamping the span ok), and a
 * full-cap response's billed tokens would otherwise be lost on the way out.
 * Same field the adapters' own guards populate.
 */
function truncationError(
  model: string,
  maxTokens: number,
  usage?: { inputTokens: number; outputTokens: number }
): ProviderError {
  return new ProviderError(
    `Structured completion for model "${model}" was truncated at maxTokens (${maxTokens}) ` +
      `before it could be parsed — the response is incomplete, not schema-invalid. Raise ` +
      `maxTokens: on OpenAI reasoning models this cap is sent as max_completion_tokens and ` +
      `covers hidden reasoning tokens as well as visible output.`,
    { code: 'truncated_no_output', retriable: false, ...(usage ? { usage } : {}) }
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

  // One attempt. `truncated` covers both routes to the same event: the
  // provider raised it (both in-repo adapters do, for a structured
  // extraction), or it came back as a `'length'` finish we notice here (a
  // provider that ignores `responseFormat`, or no `responseSchema` at all).
  //
  // `usage` survives either route: we have the response in hand when we
  // detect it ourselves, and the adapters attach `ProviderError.usage` when
  // they raise it. It is null only when the host reported no usage at all. A
  // truncated attempt is a full cap's worth of output, so dropping it would
  // under-report the largest component of the bill and break this module's
  // own promise to sum across attempts.
  //
  // The truncation is thrown INSIDE `withSpan` and caught outside it rather
  // than returned from the callback. That is load-bearing: `withSpan` stamps
  // `{ code: 'ok' }` on any normal return, so returning early would file a
  // truncated attempt in the trace as a success — hiding the exact fault this
  // module exists to make visible. The response rides out on the error so the
  // usage survives the throw.
  const attempt = async (
    messages: LlmMessage[],
    attemptTemperature: number
  ): Promise<{
    parsed: T | null;
    truncated: boolean;
    usage: { inputTokens: number; outputTokens: number } | null;
    finishReason: LlmFinishReason | null;
  }> => {
    // Note this is a fresh deadline per attempt, so `timeoutMs` bounds each
    // call and not the sequence — two attempts can take 2 × `timeoutMs`. That
    // is long-standing behaviour (both attempts always built their own
    // signal); the comment that used to sit here claimed the opposite.
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await withSpan(
        SPAN_LLM_CALL,
        {
          ...phaseAttrs,
          [GEN_AI_REQUEST_TEMPERATURE]: attemptTemperature,
          [GEN_AI_REQUEST_MAX_TOKENS]: maxTokens,
        },
        async (span) => {
          const response = await opts.provider.chat(messages, {
            model: opts.model,
            temperature: attemptTemperature,
            maxTokens,
            // `timeoutMs` also caps the individual HTTP request inside the
            // provider SDK; `signal` aborts it from out here.
            timeoutMs,
            signal,
            ...(responseFormat ? { responseFormat } : {}),
          });
          setSpanAttributes(span, {
            [GEN_AI_RESPONSE_MODEL]: opts.model,
            [GEN_AI_USAGE_INPUT_TOKENS]: response.usage.inputTokens,
            [GEN_AI_USAGE_OUTPUT_TOKENS]: response.usage.outputTokens,
            [GEN_AI_USAGE_TOTAL_TOKENS]: response.usage.inputTokens + response.usage.outputTokens,
          });
          const parsed = opts.parse(response.content);
          // Unparseable AND cut off at the cap. A `'length'` finish that still
          // parses is NOT a truncation for our purposes — the caller got its
          // value, and `finishReason` on the result lets it judge.
          if (parsed === null && response.finishReason === 'length') {
            throw truncationError(opts.model, maxTokens, response.usage);
          }
          return {
            parsed,
            truncated: false,
            usage: response.usage,
            finishReason: response.finishReason,
          };
        }
      );
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'truncated_no_output') {
        // `usage` is absent when the provider discarded the numbers before we
        // saw them — an adapter guard that had none to report.
        return {
          parsed: null,
          truncated: true,
          usage: err.usage ?? null,
          finishReason: 'length',
        };
      }
      throw err;
    }
  };

  const first = await attempt(opts.messages, temperature);
  if (first.parsed !== null) {
    const inputTokens = first.usage?.inputTokens ?? 0;
    const outputTokens = first.usage?.outputTokens ?? 0;
    return {
      value: first.parsed,
      tokenUsage: { input: inputTokens, output: outputTokens },
      costUsd: calculateCost(opts.model, inputTokens, outputTokens).totalCostUsd,
      finishReason: first.finishReason ?? 'stop',
    };
  }

  // A truncation gets the retry too. Skipping it needs "the same cap cannot
  // fit this", and the only signal available is `responseFormat` — which
  // records what we SENT, not what the server honoured. Plenty of hosts
  // ignore it (Ollama, LM Studio, vLLM, older gateways) and can still emit a
  // preamble the retry's "respond ONLY with a JSON object" would remove. Skip
  // on that proxy and a recoverable call hard-fails; run it and a doomed one
  // costs a call. Not symmetric, so it runs.
  //
  // Not, note, because the retry appends a message: `max_tokens` /
  // `max_completion_tokens` bound the COMPLETION on both providers, so prompt
  // length does not shrink the output budget.
  //
  // The malformed prior response is NOT included — never trust output that
  // just misbehaved as part of a subsequent prompt.
  const retry = await attempt(
    [...opts.messages, { role: 'user', content: opts.retryUserMessage }],
    0
  );

  // Both attempts are spent. Only now is the cap provably the problem.
  //
  // Report BOTH attempts' tokens: each was billed, and a truncated attempt is
  // a full cap's worth of output. Attributing only one of them under-reports
  // the most expensive failure shape there is.
  if (retry.truncated) {
    const billed = {
      inputTokens: (first.usage?.inputTokens ?? 0) + (retry.usage?.inputTokens ?? 0),
      outputTokens: (first.usage?.outputTokens ?? 0) + (retry.usage?.outputTokens ?? 0),
    };
    // Omit rather than report zeros, matching the adapter guards: a consumer
    // doing `if (err.usage) logCost(...)` would otherwise write the "this turn
    // was free" row those guards exist to avoid. Both attempts can come back
    // usage-less from a host that ignores `stream_options.include_usage`.
    throw truncationError(
      opts.model,
      maxTokens,
      billed.inputTokens > 0 || billed.outputTokens > 0 ? billed : undefined
    );
  }

  if (retry.parsed === null) {
    if (opts.onFinalFailure) throw opts.onFinalFailure();
    throw new Error('Structured completion response was not valid JSON after retry');
  }

  // Both attempts are billed, so both are counted — including a first attempt
  // that was truncated, which is by definition a full cap's worth of output
  // and so the LARGEST component of the bill.
  const inputTokens = (first.usage?.inputTokens ?? 0) + (retry.usage?.inputTokens ?? 0);
  const outputTokens = (first.usage?.outputTokens ?? 0) + (retry.usage?.outputTokens ?? 0);
  return {
    value: retry.parsed,
    tokenUsage: { input: inputTokens, output: outputTokens },
    costUsd: calculateCost(opts.model, inputTokens, outputTokens).totalCostUsd,
    finishReason: retry.finishReason ?? 'stop',
  };
}
