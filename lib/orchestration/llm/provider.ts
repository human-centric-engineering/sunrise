/**
 * LLM Provider Interface + Shared Helpers
 *
 * Defines the abstract `LlmProvider` contract implemented by
 * `AnthropicProvider` and `OpenAiCompatibleProvider`, plus the shared
 * resilience primitives (`fetchWithTimeout`, `withRetry`, `ProviderError`,
 * and timeout constants) used by every provider.
 *
 * Platform-agnostic: no Next.js imports, no globals beyond `fetch`,
 * `AbortController`, and `setTimeout`.
 */

import { logger } from '@/lib/logging';
import type {
  EmbedOptions,
  LlmMessage,
  LlmOptions,
  LlmResponse,
  ModelInfo,
  StreamChunk,
  TranscribeAudio,
  TranscribeChunk,
  TranscribeOptions,
  TranscribeResponse,
} from '@/lib/orchestration/llm/types';

/**
 * Default request timeout for cloud providers.
 *
 * 2 minutes covers reasoning models (gpt-5, o-series, claude opus extended
 * thinking) producing verbose structured JSON — the workload pattern that
 * shows up in workflow `llm_call` steps with large `__loop__` inputs or
 * many-object schemas. Aligned with the orchestrator step's own default
 * (`lib/orchestration/engine/executors/orchestrator.ts`) so a workflow
 * step and the LLM call inside it can't fight each other over timeout.
 *
 * Reference points: OpenAI/Anthropic SDK defaults are 10 minutes (too
 * generous — masks stuck calls); 30s (the previous value here) was too
 * aggressive — a single GPT-5 call analysing ~30 objects in JSON mode
 * routinely runs past it.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Timeout for local providers (Ollama, vLLM, llama.cpp).
 *
 * Local models on prosumer hardware are NOT instant — a 7B model
 * producing ~500 output tokens on an M-series Mac takes ~10–30s, and
 * larger models or quantised CPU inference can take longer. The
 * previous 10s value was tuned for "tiny model on fast hardware"
 * and broke every realistic local deployment.
 */
export const LOCAL_TIMEOUT_MS = 60_000;

/**
 * Default maximum retries on transient failures (after the initial
 * attempt). 2 retries → 3 total attempts. Matches the OpenAI and
 * Anthropic SDK defaults. With the longer per-attempt timeout above,
 * keeping retries low bounds the worst-case wall time (~6 min for
 * cloud, ~3 min for local).
 */
export const DEFAULT_MAX_RETRIES = 2;

/** Base delay between retries (ms); doubled each attempt with jitter. */
const RETRY_BASE_DELAY_MS = 500;

/** Upper bound on any single retry delay. */
const RETRY_MAX_DELAY_MS = 10_000;

/**
 * Result type for `LlmProvider.testConnection`.
 *
 * `ok: true` means we reached the provider and discovered at least one
 * model id. `error` carries a sanitised, human-readable reason on failure.
 */
export interface ProviderTestResult {
  ok: boolean;
  models: string[];
  error?: string;
}

/**
 * Abstract LLM provider interface.
 *
 * Every concrete provider (Anthropic, OpenAI-compatible, ...) must implement
 * this. Callers work purely against this interface so the chat handler,
 * workflow engine, and evaluation harness stay provider-agnostic.
 */
export interface LlmProvider {
  /** Name of the provider instance (matches `AiProviderConfig.name`). */
  readonly name: string;

  /** Whether this provider runs locally (affects timeouts and cost tracking). */
  readonly isLocal: boolean;

  /** Run a single non-streaming chat completion. */
  chat(messages: LlmMessage[], options: LlmOptions): Promise<LlmResponse>;

  /** Stream a chat completion as `StreamChunk`s. */
  chatStream(messages: LlmMessage[], options: LlmOptions): AsyncIterable<StreamChunk>;

  /** Generate an embedding vector for a single text. */
  embed(text: string, options?: EmbedOptions): Promise<number[]>;

  /**
   * Discover the models this provider can serve.
   *
   * For cloud providers this is a curated list; for OpenAI-compatible
   * hosts it calls the remote `/models` endpoint.
   */
  listModels(): Promise<ModelInfo[]>;

  /**
   * Ping the provider to confirm connectivity and authentication.
   * Never throws — returns `{ ok: false, error }` on failure so callers
   * can surface provider health without wrapping every call.
   */
  testConnection(): Promise<ProviderTestResult>;

  /**
   * Transcribe audio bytes to text. Optional — providers without an
   * audio surface (e.g. Anthropic, plain Ollama) simply omit it. The
   * routing layer (`getAudioProvider` in `provider-manager.ts`) filters
   * to providers whose `AiProviderModel.capabilities` row includes
   * `'audio'`, so callers can rely on this method being defined when
   * a model with that capability is selected.
   */
  transcribe?(audio: TranscribeAudio, options: TranscribeOptions): Promise<TranscribeResponse>;

  /**
   * Stream a transcription as `TranscribeChunk`s — the streaming analogue
   * of {@link transcribe}, mirroring the `chat` → `chatStream` split.
   *
   * Optional and rarely implemented natively: the only batch STT provider
   * today (OpenAI-compatible Whisper) has no streaming transcription API, so
   * most providers omit this. Callers should go through `streamTranscription`
   * (`@/lib/orchestration/llm/transcribe-stream`), which adapts the batch
   * `transcribe` result into a single `final` + `done` stream when this is
   * absent. A provider that genuinely supports low-latency interim
   * transcripts (e.g. Deepgram, AssemblyAI) implements this directly to emit
   * `partial` chunks as audio arrives.
   */
  transcribeStream?(
    audio: TranscribeAudio,
    options: TranscribeOptions
  ): AsyncIterable<TranscribeChunk>;
}

/**
 * Structured error thrown by providers and helpers.
 *
 * `retriable` is consulted by {@link withRetry}; `status` carries the
 * upstream HTTP status when known, and `code` is a stable short string
 * suitable for logging.
 */
export class ProviderError extends Error {
  public readonly code: string;
  public readonly status?: number;
  public readonly retriable: boolean;
  public readonly cause?: unknown;
  /**
   * Tokens the provider billed for the call this error ended.
   *
   * Set by the truncation guards, where the request genuinely consumed a full
   * cap's worth of output before failing — the largest single charge a turn
   * can incur, and one that used to vanish with the response when the guard
   * threw. Callers that log cost should fold it in on their error paths.
   *
   * Absent for errors raised before the model produced anything (bad schema,
   * auth, connection), and absent when the provider reported no usage.
   */
  public readonly usage?: { inputTokens: number; outputTokens: number };

  constructor(
    message: string,
    options: {
      code?: string;
      status?: number;
      retriable?: boolean;
      cause?: unknown;
      usage?: { inputTokens: number; outputTokens: number };
    } = {}
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = options.code ?? 'provider_error';
    if (options.status !== undefined) this.status = options.status;
    this.retriable = options.retriable ?? false;
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.usage !== undefined) this.usage = options.usage;
  }
}

/**
 * `ProviderError` codes describing a fault in the REQUEST rather than in the
 * provider — the same cap, the same schema, the same rejection at any vendor.
 *
 * Callers use this to decide not to re-run something that cannot succeed:
 * `streamChat` skips provider failover, and the engine's executors mark the
 * `ExecutorError` non-retriable so a step's `retry` strategy stops.
 *
 * **Do not replace this with the `retriable` flag.** They answer different
 * questions and the flag is far broader than it looks: `toProviderError` sets
 * `retriable` only when it can read a retriable HTTP status, so a connection
 * reset or a read timeout — which carry no status — comes through as
 * `provider_error` with `retriable: false`, as does anything using
 * `ProviderError`'s own default. Gating retry on the flag would stop a
 * workflow step retrying an ordinary network blip, and stop a chat turn
 * failing over from a provider whose key has gone stale, both of which are
 * exactly what those mechanisms are for.
 *
 * Keep it narrow, and add only codes that are deterministic for the request.
 * `invalid_schema` is the obvious next member; it is held back to #592 with
 * the rest of the failover-policy work rather than shipped untested here.
 */
const REQUEST_FAULT_CODES = new Set(['truncated_no_output']);

/**
 * Whether `err` is a {@link REQUEST_FAULT_CODES} `ProviderError` — i.e. a
 * failure that re-running, re-routing or failing over cannot fix.
 */
export function isRequestFault(err: unknown): err is ProviderError {
  return err instanceof ProviderError && REQUEST_FAULT_CODES.has(err.code);
}

/**
 * Narrow an unknown error to a `ProviderError`. Preserves status codes
 * from SDK errors (`@anthropic-ai/sdk` and `openai` both expose a
 * `status` property on their error classes).
 */
export function toProviderError(err: unknown, fallbackMessage: string): ProviderError {
  if (err instanceof ProviderError) return err;

  if (err instanceof Error) {
    const status = extractStatus(err);
    const retriable = status !== undefined && isRetriableStatus(status);
    return new ProviderError(err.message || fallbackMessage, {
      code: status !== undefined ? `http_${status}` : 'provider_error',
      ...(status !== undefined ? { status } : {}),
      retriable,
      cause: err,
    });
  }

  return new ProviderError(fallbackMessage, { cause: err });
}

/**
 * {@link toProviderError}, plus whatever the call had already been billed for.
 *
 * For a stream that dies part-way through. The adapters track `inputTokens` /
 * `outputTokens` as chunks arrive, so at the moment they throw they know what
 * the provider has charged for — and the plain `toProviderError` path drops it,
 * which is the half of #592 that survived #593. The model produced output; the
 * vendor bills for it; only the `done` chunk that never arrived was going to
 * tell us how much.
 *
 * **Zero is not "free", it is "unknown", so zeroed usage is dropped.** An
 * OpenAI-compatible stream reports usage in a final chunk (via
 * `stream_options.include_usage`), so an error before that leaves both counts
 * at 0 — and a zeroed `AiCostLog` row would tell the dashboard the turn cost
 * nothing, which is a worse answer than no row. Anthropic sets `inputTokens` at
 * `message_start` and updates `outputTokens` on every `message_delta`, so its
 * mid-stream errors do carry real numbers.
 *
 * An error that already carries usage keeps it: the truncation guards attach
 * exactly what the provider reported, which beats anything reconstructed here.
 */
export function toProviderErrorWithUsage(
  err: unknown,
  fallbackMessage: string,
  usage: { inputTokens: number; outputTokens: number }
): ProviderError {
  const base = toProviderError(err, fallbackMessage);
  if (base.usage || (usage.inputTokens <= 0 && usage.outputTokens <= 0)) return base;

  const rebuilt = new ProviderError(base.message, {
    code: base.code,
    ...(base.status !== undefined ? { status: base.status } : {}),
    retriable: base.retriable,
    // Every `toProviderError` branch that CONSTRUCTS an error already sets
    // `cause`; the only branch that does not is the one returning its input
    // untouched, where there is no wrapped error to point at. So `base.cause`
    // is the whole answer — an `?? err` fallback would be unreachable.
    cause: base.cause,
    usage,
  });
  // Carry the original stack across. Without this the rebuilt error points at
  // this helper rather than the adapter loop that threw, so
  // `log.error('Streaming chat handler crashed', err)` and the span exception
  // both lose the throw site — the one thing an operator opens them for.
  if (base.stack) rebuilt.stack = base.stack;
  return rebuilt;
}

/**
 * Per-request overrides accepted as the second argument by both
 * `@anthropic-ai/sdk` and `openai` (`RequestOptions` in each).
 */
export interface ProviderRequestOptions {
  timeout?: number;
  signal?: AbortSignal;
}

/**
 * Translate the per-call `timeoutMs` / `signal` from `LlmOptions` into the
 * request-options argument the SDKs take.
 *
 * Returns `undefined` when the caller supplied neither, so the client's
 * construction-time timeout (`DEFAULT_TIMEOUT_MS` / `LOCAL_TIMEOUT_MS`, or the
 * provider's configured override) still applies. Passing `{}` would be
 * equivalent, but the explicit `undefined` keeps "caller said nothing" and
 * "caller asked for the default" distinguishable at the call site.
 *
 * `timeoutMs` is a per-request cap on the whole HTTP exchange, so a caller that
 * needs several minutes — live document extraction on a reasoning model is the
 * case that surfaced this — gets what it asked for rather than the client
 * default. Note that `withRetry` wraps the non-streaming paths: the timeout
 * bounds each attempt, not the retry sequence as a whole.
 */
export function buildRequestOptions(options: LlmOptions): ProviderRequestOptions | undefined {
  const requestOptions: ProviderRequestOptions = {};
  if (options.timeoutMs !== undefined) requestOptions.timeout = options.timeoutMs;
  if (options.signal !== undefined) requestOptions.signal = options.signal;
  return Object.keys(requestOptions).length > 0 ? requestOptions : undefined;
}

/**
 * `fetch` wrapper that attaches an `AbortController` for a hard timeout
 * and transparently links any caller-supplied `AbortSignal`.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) {
      throw new ProviderError('request aborted', { code: 'aborted', retriable: false });
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      const reason: unknown = controller.signal.reason;
      const isTimeout = reason instanceof Error && reason.message === 'request timeout';
      throw new ProviderError(
        isTimeout ? `request timed out after ${timeoutMs}ms` : 'request aborted',
        {
          code: isTimeout ? 'timeout' : 'aborted',
          retriable: isTimeout,
          cause: err,
        }
      );
    }
    throw toProviderError(err, 'fetch failed');
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

/** HTTP status codes that merit a retry. */
function isRetriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** Pull a status code off common SDK error shapes. */
function extractStatus(err: Error): number | undefined {
  const candidate = (err as unknown as { status?: unknown }).status;
  return typeof candidate === 'number' ? candidate : undefined;
}

/** Options controlling `withRetry`. */
export interface WithRetryOptions {
  maxRetries?: number;
  isLocal?: boolean;
  signal?: AbortSignal;
  /** Descriptor used in logs only. */
  operation?: string;
}

/**
 * Run `fn`, retrying on retriable `ProviderError`s with exponential
 * backoff and jitter. Honours caller `AbortSignal` and the "no 5xx
 * retry for local providers" rule from the orchestration spec.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: WithRetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const isLocal = options.isLocal ?? false;
  const signal = options.signal;
  const op = options.operation ?? 'llm request';

  let attempt = 0;
  // Loop control is via return / throw.
  for (;;) {
    if (signal?.aborted) {
      throw new ProviderError('request aborted', { code: 'aborted', retriable: false });
    }

    try {
      return await fn();
    } catch (rawErr) {
      const err =
        rawErr instanceof ProviderError ? rawErr : toProviderError(rawErr, `${op} failed`);

      // Non-retriable errors propagate immediately.
      if (!err.retriable) throw err;
      // Local providers don't retry 5xx — restart won't help.
      if (isLocal && err.status !== undefined && err.status >= 500 && err.status < 600) throw err;
      // Out of retries.
      if (attempt >= maxRetries) throw err;

      const delay = computeBackoffDelay(attempt);
      logger.warn('LLM request retriable failure, backing off', {
        operation: op,
        attempt: attempt + 1,
        maxRetries,
        status: err.status,
        code: err.code,
        delayMs: delay,
      });

      await sleep(delay, signal);
      attempt += 1;
    }
  }
}

function computeBackoffDelay(attempt: number): number {
  const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
  const capped = Math.min(base, RETRY_MAX_DELAY_MS);
  // +/- 25% jitter.
  const jitter = capped * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('request aborted', { code: 'aborted', retriable: false }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ProviderError('request aborted', { code: 'aborted', retriable: false }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
