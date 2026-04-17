/**
 * `external_call` — HTTP call to an external endpoint or agent.
 *
 * Config:
 *   - `url: string` — target endpoint.
 *   - `method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'` — HTTP method.
 *   - `headers?: Record<string, string>` — additional headers.
 *   - `bodyTemplate?: string` — JSON template with `{{input}}` interpolation.
 *   - `timeoutMs?: number` — request timeout (default 30 000 ms).
 *   - `authType?: 'none' | 'bearer' | 'api-key' | 'query-param'` — authentication type.
 *   - `authSecret?: string` — env var name holding the secret (never a raw value).
 *   - `authQueryParam?: string` — query param name when authType is 'query-param' (default: 'api_key').
 *   - `maxResponseBytes?: number` — max response body size (default 1 MB).
 *
 * Security:
 *   - URLs validated against `ORCHESTRATION_ALLOWED_HOSTS` (comma-separated hostnames).
 *   - Missing auth secrets fail-fast with a clear error (never silently dropped).
 *   - Per-host outbound rate limiting prevents overwhelming external APIs.
 *   - Response body size capped to prevent OOM from large responses.
 *   - HTTP errors classified as retriable vs non-retriable for smart retry.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import { externalCallConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { logger } from '@/lib/logging';
import {
  checkOutboundRateLimit,
  recordRetryAfter,
} from '@/lib/orchestration/engine/outbound-rate-limiter';

// ─── Constants ──────────────────────────────────────────────────────────────

const ALLOWED_HOSTS_ENV = 'ORCHESTRATION_ALLOWED_HOSTS';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576; // 1 MB

/** HTTP status codes that indicate transient failures worth retrying. */
const RETRIABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

/** HTTP methods that should not include a request body. */
const BODYLESS_METHODS = new Set(['GET', 'DELETE']);

// ─── Allowlist (cached) ─────────────────────────────────────────────────────

let cachedAllowedHosts: Set<string> | null = null;
let cachedAllowedHostsRaw: string | undefined;

function getAllowedHosts(): Set<string> {
  const raw = process.env[ALLOWED_HOSTS_ENV] ?? '';
  if (cachedAllowedHosts && cachedAllowedHostsRaw === raw) return cachedAllowedHosts;
  cachedAllowedHostsRaw = raw;
  cachedAllowedHosts = new Set(
    raw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0)
  );
  return cachedAllowedHosts;
}

function isHostAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return getAllowedHosts().has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Reset cached allowlist — for tests. */
export function resetAllowlistCache(): void {
  cachedAllowedHosts = null;
  cachedAllowedHostsRaw = undefined;
}

// ─── Auth resolution ────────────────────────────────────────────────────────

function resolveAuthHeaders(
  stepId: string,
  authType: string | undefined,
  authSecret: string | undefined
): Record<string, string> {
  if (!authType || authType === 'none' || !authSecret) return {};

  const secretValue = process.env[authSecret];
  if (!secretValue) {
    throw new ExecutorError(
      stepId,
      'missing_auth_secret',
      `Auth secret env var "${authSecret}" is not set — cannot authenticate external call`,
      undefined,
      false
    );
  }

  if (authType === 'bearer') {
    return { Authorization: `Bearer ${secretValue}` };
  }
  if (authType === 'api-key') {
    return { 'X-API-Key': secretValue };
  }
  // 'query-param' auth is handled in the URL, not headers.
  return {};
}

function applyQueryParamAuth(
  url: string,
  authType: string | undefined,
  authSecret: string | undefined,
  authQueryParam: string | undefined,
  stepId: string
): string {
  if (authType !== 'query-param' || !authSecret) return url;

  const secretValue = process.env[authSecret];
  if (!secretValue) {
    throw new ExecutorError(
      stepId,
      'missing_auth_secret',
      `Auth secret env var "${authSecret}" is not set — cannot authenticate external call`,
      undefined,
      false
    );
  }

  const parsed = new URL(url);
  parsed.searchParams.set(authQueryParam ?? 'api_key', secretValue);
  return parsed.toString();
}

// ─── Response helpers ───────────────────────────────────────────────────────

function isRetriableStatus(status: number): boolean {
  return RETRIABLE_STATUS_CODES.has(status);
}

async function readResponseBody(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new Error(`Response body exceeds max size: ${contentLength} bytes > ${maxBytes} bytes`);
  }

  // Read body as ArrayBuffer to enforce size limit, then decode.
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new Error(
      `Response body exceeds max size: ${buffer.byteLength} bytes > ${maxBytes} bytes`
    );
  }

  const text = new TextDecoder().decode(buffer);

  // Try JSON parse if content looks like JSON.
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json') || text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      // Fall through to text.
    }
  }

  return text;
}

// ─── Executor ───────────────────────────────────────────────────────────────

export async function executeExternalCall(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = externalCallConfigSchema.parse(step.config);
  const startedAt = Date.now();

  // ── Validate URL ──────────────────────────────────────────────────────
  const rawUrl = config.url;
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new ExecutorError(step.id, 'missing_url', 'external_call step is missing a URL');
  }

  if (!isHostAllowed(rawUrl)) {
    throw new ExecutorError(
      step.id,
      'host_not_allowed',
      `Host not in ${ALLOWED_HOSTS_ENV} allowlist: ${rawUrl}`,
      undefined,
      false
    );
  }

  // ── Outbound rate limit ───────────────────────────────────────────────
  const hostname = new URL(rawUrl).hostname.toLowerCase();
  const rateLimitResult = checkOutboundRateLimit(hostname);
  if (!rateLimitResult.allowed) {
    throw new ExecutorError(
      step.id,
      'outbound_rate_limited',
      `Outbound rate limit exceeded for host ${hostname}` +
        (rateLimitResult.retryAfterMs
          ? ` — retry after ${Math.ceil(rateLimitResult.retryAfterMs / 1000)}s`
          : ''),
      undefined,
      true
    );
  }

  // ── Build request ─────────────────────────────────────────────────────
  const method = config.method ?? 'POST';
  const timeoutMs = typeof config.timeoutMs === 'number' ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxResponseBytes =
    typeof config.maxResponseBytes === 'number'
      ? config.maxResponseBytes
      : DEFAULT_MAX_RESPONSE_BYTES;

  const configHeaders = config.headers ?? {};
  const authHeaders = resolveAuthHeaders(step.id, config.authType, config.authSecret);

  const headers: Record<string, string> = {
    ...(BODYLESS_METHODS.has(method) ? {} : { 'Content-Type': 'application/json' }),
    ...configHeaders,
    ...authHeaders,
  };

  // Apply query-param auth to URL.
  const url = applyQueryParamAuth(
    rawUrl,
    config.authType,
    config.authSecret,
    config.authQueryParam,
    step.id
  );

  let body: string | undefined;
  if (!BODYLESS_METHODS.has(method) && config.bodyTemplate) {
    body = interpolatePrompt(config.bodyTemplate, ctx);
  }

  // ── Execute request ───────────────────────────────────────────────────
  logger.info('External call: sending request', {
    stepId: step.id,
    method,
    hostname,
    path: new URL(url).pathname,
    timeoutMs,
  });

  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Link execution-level abort signal if present.
  const onExternalAbort = (): void => controller.abort();
  if (ctx.signal) {
    if (ctx.signal.aborted) {
      clearTimeout(timer);
      throw new ExecutorError(step.id, 'request_aborted', 'Execution was already aborted');
    }
    ctx.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `Request timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : 'Request failed';
    throw new ExecutorError(step.id, 'request_failed', message, err);
  } finally {
    clearTimeout(timer);
    if (ctx.signal) ctx.signal.removeEventListener('abort', onExternalAbort);
  }

  const latencyMs = Date.now() - startedAt;

  // ── Handle non-2xx responses ──────────────────────────────────────────
  if (!response.ok) {
    // Record Retry-After if present (before throwing).
    const retryAfterHeader = response.headers.get('retry-after');
    if (retryAfterHeader) {
      recordRetryAfter(hostname, retryAfterHeader);
    }

    const text = await response.text().catch(() => '');
    const retriable = isRetriableStatus(response.status);

    logger.warn('External call: non-2xx response', {
      stepId: step.id,
      method,
      hostname,
      status: response.status,
      retriable,
      latencyMs,
      bodyPreview: text.slice(0, 200),
    });

    throw new ExecutorError(
      step.id,
      retriable ? 'http_error_retriable' : 'http_error',
      `HTTP ${response.status}: ${text.slice(0, 256)}`,
      undefined,
      retriable
    );
  }

  // ── Read & cap response body ──────────────────────────────────────────
  let responseBody: unknown;
  try {
    responseBody = await readResponseBody(response, maxResponseBytes);
  } catch (err) {
    throw new ExecutorError(
      step.id,
      'response_too_large',
      err instanceof Error ? err.message : 'Failed to read response body',
      err,
      false
    );
  }

  logger.info('External call: success', {
    stepId: step.id,
    method,
    hostname,
    status: response.status,
    latencyMs,
  });

  return {
    output: { status: response.status, body: responseBody },
    tokensUsed: 0,
    costUsd: 0,
  };
}

registerStepType('external_call', executeExternalCall);
