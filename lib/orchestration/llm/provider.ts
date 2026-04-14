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
} from './types';

/** Default request timeout for cloud providers. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Shorter timeout for local providers — they should be on-box and fast. */
export const LOCAL_TIMEOUT_MS = 10_000;

/** Default maximum retries on transient failures. */
export const DEFAULT_MAX_RETRIES = 3;

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

  constructor(
    message: string,
    options: {
      code?: string;
      status?: number;
      retriable?: boolean;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = options.code ?? 'provider_error';
    if (options.status !== undefined) this.status = options.status;
    this.retriable = options.retriable ?? false;
    if (options.cause !== undefined) this.cause = options.cause;
  }
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
