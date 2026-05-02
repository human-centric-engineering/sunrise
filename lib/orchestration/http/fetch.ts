/**
 * Unified HTTP request executor for the orchestration layer.
 *
 * Both the workflow `external_call` step executor and the
 * `call_external_api` capability go through `executeHttpRequest`. It
 * coordinates allowlist enforcement, outbound rate limiting, auth
 * (bearer / api-key / query-param / basic / hmac), idempotency-key
 * header injection, timeout, response size cap, JSON parse, and
 * optional response transformation.
 *
 * Errors are surfaced as typed `HttpError` instances with codes that
 * callers map to their domain error type.
 *
 * Request body interpolation (e.g. `{{input}}` in workflow templates)
 * is the caller's responsibility — `executeHttpRequest` takes a fully
 * resolved URL and body string.
 */

import { logger } from '@/lib/logging';
import {
  checkOutboundRateLimit,
  recordRetryAfter,
} from '@/lib/orchestration/engine/outbound-rate-limiter';
import { isHostAllowed, ALLOWED_HOSTS_ENV } from '@/lib/orchestration/http/allowlist';
import { applyAuth, type HttpAuthConfig } from '@/lib/orchestration/http/auth';
import { HttpError } from '@/lib/orchestration/http/errors';
import { mergeHeaders } from '@/lib/orchestration/http/headers';
import {
  resolveIdempotencyHeader,
  type HttpIdempotencyConfig,
} from '@/lib/orchestration/http/idempotency';
import {
  applyResponseTransform,
  isRetriableStatus,
  readResponseBody,
  type ResponseTransform,
} from '@/lib/orchestration/http/response';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576; // 1 MB
const BODYLESS_METHODS = new Set(['GET', 'DELETE']);

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequestOptions {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  /** Stringified body. Ignored for GET/DELETE. */
  body?: string;
  auth?: HttpAuthConfig;
  idempotency?: HttpIdempotencyConfig;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Optional response transformation applied before returning. */
  responseTransform?: ResponseTransform;
  /** Caller's abort signal. Linked to the internal timeout controller. */
  signal?: AbortSignal;
  /** Logging tag — included in info/warn lines so callers can correlate. */
  logContext?: Record<string, unknown>;
}

export interface HttpResponseBody {
  status: number;
  body: unknown;
  /** Latency in milliseconds (network + parse). */
  latencyMs: number;
  /**
   * Set when `responseTransform` was supplied but threw. The original
   * body is returned in `body` and the error message in
   * `transformError`. Callers decide whether to treat as fatal.
   */
  transformError?: string;
}

export async function executeHttpRequest(opts: HttpRequestOptions): Promise<HttpResponseBody> {
  const startedAt = Date.now();
  const method = opts.method;

  if (!isHostAllowed(opts.url)) {
    throw new HttpError(
      'host_not_allowed',
      `Host not in ${ALLOWED_HOSTS_ENV} allowlist: ${opts.url}`,
      false
    );
  }

  const hostname = new URL(opts.url).hostname.toLowerCase();
  const rateLimitResult = checkOutboundRateLimit(hostname);
  if (!rateLimitResult.allowed) {
    throw new HttpError(
      'outbound_rate_limited',
      `Outbound rate limit exceeded for host ${hostname}` +
        (rateLimitResult.retryAfterMs
          ? ` — retry after ${Math.ceil(rateLimitResult.retryAfterMs / 1000)}s`
          : ''),
      true
    );
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const body = BODYLESS_METHODS.has(method) ? '' : (opts.body ?? '');

  const { url: authedUrl, headers: authHeaders } = applyAuth(opts.auth, opts.url, method, body);
  const idempotencyHeaders = resolveIdempotencyHeader(opts.idempotency);

  // mergeHeaders is case-insensitive — opts.headers (caller-supplied, possibly
  // LLM-influenced) cannot smuggle a `authorization` past authHeaders'
  // `Authorization` by varying case.
  const headers = mergeHeaders(
    BODYLESS_METHODS.has(method) ? undefined : { 'Content-Type': 'application/json' },
    opts.headers,
    authHeaders,
    idempotencyHeaders
  );

  logger.info('HTTP request: sending', {
    method,
    hostname,
    path: new URL(authedUrl).pathname,
    timeoutMs,
    ...(opts.logContext ?? {}),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = (): void => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      throw new HttpError('request_aborted', 'Caller aborted before request was sent', false);
    }
    opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(authedUrl, {
      method,
      headers,
      body: BODYLESS_METHODS.has(method) ? undefined : body || undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const code: 'request_timeout' | 'request_failed' = isAbort
      ? 'request_timeout'
      : 'request_failed';
    const message = isAbort
      ? `Request timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : 'Request failed';
    throw new HttpError(code, message, false, err);
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
  }

  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    const retryAfterHeader = response.headers.get('retry-after');
    if (retryAfterHeader) recordRetryAfter(hostname, retryAfterHeader);

    const text = await response.text().catch(() => '');
    const retriable = isRetriableStatus(response.status);

    logger.warn('HTTP request: non-2xx response', {
      method,
      hostname,
      status: response.status,
      retriable,
      latencyMs,
      bodyPreview: text.slice(0, 200),
      ...(opts.logContext ?? {}),
    });

    throw new HttpError(
      retriable ? 'http_error_retriable' : 'http_error',
      `HTTP ${response.status}: ${text.slice(0, 256)}`,
      retriable,
      undefined,
      response.status
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = await readResponseBody(response, maxResponseBytes);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      'response_too_large',
      err instanceof Error ? err.message : 'Failed to read response body',
      false,
      err
    );
  }

  logger.info('HTTP request: success', {
    method,
    hostname,
    status: response.status,
    latencyMs,
    ...(opts.logContext ?? {}),
  });

  if (opts.responseTransform) {
    try {
      const transformed = applyResponseTransform(parsedBody, opts.responseTransform);
      return { status: response.status, body: transformed, latencyMs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('HTTP request: response transform failed', {
        transformType: opts.responseTransform.type,
        error: message,
        ...(opts.logContext ?? {}),
      });
      return { status: response.status, body: parsedBody, latencyMs, transformError: message };
    }
  }

  return { status: response.status, body: parsedBody, latencyMs };
}
