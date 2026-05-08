/**
 * `external_call` — HTTP call to an external endpoint or agent.
 *
 * Thin adapter over `lib/orchestration/http/` (shared with the
 * `call_external_api` capability). This file owns:
 *   - Workflow-step concerns: config-schema parsing, prompt
 *     interpolation against the execution context, mapping
 *     `HttpError` codes to `ExecutorError`, the `StepResult` shape,
 *     execution-context abort signal wiring.
 *   - The `external_call` step-registry registration.
 *
 * All HTTP machinery — allowlist, rate limit, auth (none / bearer /
 * api-key / query-param / basic / hmac), idempotency, response
 * size cap, JSON parse, response transform — lives in the shared
 * module.
 *
 * Config:
 *   - `url: string` — target endpoint (interpolated against ctx).
 *   - `method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'` — HTTP method.
 *   - `headers?: Record<string, string>` — additional headers.
 *   - `bodyTemplate?: string` — JSON template with `{{input}}` interpolation.
 *   - `timeoutMs?: number` — request timeout (default 30 000 ms).
 *   - `authType?: 'none' | 'bearer' | 'api-key' | 'query-param' | 'basic' | 'hmac'`.
 *   - `authSecret?: string` — env var name holding the secret (never a raw value).
 *   - `authQueryParam?: string` — query param name when authType is 'query-param' (default: 'api_key').
 *   - `hmacHeaderName?: string` — header name for the HMAC signature (default: 'X-Signature').
 *   - `hmacAlgorithm?: 'sha256' | 'sha512'` — HMAC digest (default: 'sha256').
 *   - `hmacBodyTemplate?: string` — signed-string template (default: `{method}\n{path}\n{body}`).
 *   - `idempotencyKey?: string` — `'auto'` for a fresh UUID, otherwise verbatim. Omit to skip.
 *   - `idempotencyKeyHeader?: string` — header name (default: 'Idempotency-Key').
 *   - `maxResponseBytes?: number` — max response body size (default 1 MB).
 *   - `responseTransform?: { type: 'jmespath' | 'template'; expression: string }` — optional output transform.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import { externalCallConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import {
  buildIdempotencyKey,
  lookupDispatch,
  recordDispatch,
} from '@/lib/orchestration/engine/dispatch-cache';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import {
  EnvTemplateError,
  resolveEnvTemplate,
  resolveEnvTemplatesInRecord,
} from '@/lib/orchestration/env-template';
import {
  buildMultipartBody,
  executeHttpRequest,
  HttpError,
  MultipartError,
  type HttpAuthConfig,
  type HttpMethod,
} from '@/lib/orchestration/http';

const HTTP_TO_EXECUTOR_CODE: Record<string, string> = {
  host_not_allowed: 'host_not_allowed',
  missing_auth_secret: 'missing_auth_secret',
  multipart_hmac_unsupported: 'multipart_hmac_unsupported',
  outbound_rate_limited: 'outbound_rate_limited',
  request_failed: 'request_failed',
  request_aborted: 'request_aborted',
  request_timeout: 'request_failed',
  http_error: 'http_error',
  http_error_retriable: 'http_error_retriable',
  response_too_large: 'response_too_large',
  response_transform_failed: 'response_transform_failed',
};

export async function executeExternalCall(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  // Crash-safe re-run: if a prior attempt of this step already fired the HTTP
  // call and recorded its result, return the cached StepResult without
  // re-firing. The cache key is `${executionId}:${stepId}` (deterministic per
  // step within a single execution) — independent of the `Idempotency-Key`
  // header sent to the remote, which the author may override or set to 'auto'
  // for a fresh UUID per call. See `lib/orchestration/engine/dispatch-cache.ts`.
  //
  // Posture symmetry with `recordDispatch`: a transient DB hiccup at lookup
  // time treats as cache miss (warn-and-continue), matching the post-write
  // recordDispatch failure handling. Keeps cache-availability errors from
  // killing a step before its side effect would have fired.
  const cacheKey = buildIdempotencyKey({ executionId: ctx.executionId, stepId: step.id });
  let cached: StepResult | null = null;
  try {
    cached = await lookupDispatch<StepResult>(cacheKey);
  } catch (err) {
    ctx.logger.warn('external_call: dispatch cache lookup failed; treating as miss', {
      stepId: step.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (cached !== null) {
    ctx.logger.info('external_call: dispatch cache hit, skipping HTTP request', {
      stepId: step.id,
    });
    return cached;
  }

  const config = externalCallConfigSchema.parse(step.config);

  if (typeof config.url !== 'string' || config.url.trim().length === 0) {
    throw new ExecutorError(step.id, 'missing_url', 'external_call step is missing a URL');
  }
  // Two interpolation passes, in order:
  //   1. resolveEnvTemplate — `${env:VAR}` references in the
  //      admin-authored config string only.
  //   2. interpolatePrompt — workflow-context variables (`{{input.x}}`)
  //      injected into the post-resolution literal.
  //
  // Order is security-critical. Reversing it would let user-controlled
  // workflow input (`{{input.message}}` etc.) introduce a literal
  // `${env:SECRET}` token into the URL that the env resolver would
  // then expand — exfiltrating env vars as URL path components to
  // allowlisted endpoints that log paths. Resolving env templates
  // FIRST means the admin-authored template is the only source of
  // `${env:VAR}` references; user content remains literal text.
  //
  // Headers don't go through prompt interpolation today, so order
  // doesn't matter for them — env-substitute the admin-authored map
  // directly.
  let url: string;
  let resolvedHeaders: Record<string, string> | undefined;
  try {
    url = interpolatePrompt(resolveEnvTemplate(config.url), ctx);
    resolvedHeaders = resolveEnvTemplatesInRecord(config.headers);
  } catch (err) {
    if (err instanceof EnvTemplateError) {
      throw new ExecutorError(
        step.id,
        'missing_env_var',
        `external_call step references env var "${err.envVarName}" which is not set`,
        err
      );
    }
    throw err;
  }
  const method = (config.method ?? 'POST') as HttpMethod;

  // Pre-check execution-level abort so we surface as request_aborted
  // (rather than the generic request_failed the HTTP layer would emit).
  if (ctx.signal?.aborted) {
    throw new ExecutorError(step.id, 'request_aborted', 'Execution was already aborted');
  }

  // Body resolution. Three states:
  //   - GET / DELETE → no body
  //   - `multipart` config set → interpolate field values + file
  //     templates against the workflow context, then build FormData
  //   - `bodyTemplate` set → string interpolation (unchanged)
  // Mutual exclusion between bodyTemplate and multipart is enforced
  // by the schema's .refine.
  const isBodyless = method === 'GET' || method === 'DELETE';
  let body: string | FormData | undefined;
  if (!isBodyless && config.multipart) {
    const interpolatedFiles = config.multipart.files.map((file) => ({
      name: file.name,
      filename: file.filename ? interpolatePrompt(file.filename, ctx) : undefined,
      contentType: interpolatePrompt(file.contentType, ctx),
      data: interpolatePrompt(file.data, ctx),
    }));
    const interpolatedFields = config.multipart.fields
      ? Object.fromEntries(
          Object.entries(config.multipart.fields).map(([k, v]) => [k, interpolatePrompt(v, ctx)])
        )
      : undefined;
    try {
      body = buildMultipartBody({ files: interpolatedFiles, fields: interpolatedFields });
    } catch (err) {
      if (err instanceof MultipartError) {
        throw new ExecutorError(
          step.id,
          err.code,
          `external_call multipart body build failed: ${err.message}`,
          err
        );
      }
      throw err;
    }
  } else if (!isBodyless && config.bodyTemplate) {
    body = interpolatePrompt(config.bodyTemplate, ctx);
  }

  const auth: HttpAuthConfig | undefined = config.authType
    ? {
        type: config.authType,
        secret: config.authSecret,
        queryParam: config.authQueryParam,
        apiKeyHeaderName: config.apiKeyHeaderName,
        hmacHeaderName: config.hmacHeaderName,
        hmacAlgorithm: config.hmacAlgorithm,
        hmacBodyTemplate: config.hmacBodyTemplate,
      }
    : undefined;

  // Idempotency-Key header: when the author hasn't supplied one, default to
  // our deterministic cache key so a cooperative remote dedups across
  // re-drives. Author overrides take precedence — a literal string is used
  // verbatim, and `'auto'` mints a fresh UUID per call (preserved from the
  // prior contract for authors who want no remote dedup).
  const idempotency = config.idempotencyKey
    ? { key: config.idempotencyKey, headerName: config.idempotencyKeyHeader }
    : { key: cacheKey, headerName: config.idempotencyKeyHeader };

  let stepResult: StepResult;
  try {
    const response = await executeHttpRequest({
      url,
      method,
      headers: resolvedHeaders,
      body,
      auth,
      idempotency,
      timeoutMs: config.timeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      responseTransform: config.responseTransform,
      signal: ctx.signal,
      logContext: { stepId: step.id },
    });

    if (response.transformError) {
      stepResult = {
        output: {
          status: response.status,
          body: response.body,
          _transformError: response.transformError,
        },
        tokensUsed: 0,
        costUsd: 0,
      };
    } else {
      stepResult = {
        output: { status: response.status, body: response.body },
        tokensUsed: 0,
        costUsd: 0,
      };
    }
  } catch (err) {
    if (err instanceof HttpError) {
      const code = HTTP_TO_EXECUTOR_CODE[err.code] ?? 'http_error';
      throw new ExecutorError(step.id, code, err.message, err.cause, err.retriable);
    }
    throw err;
  }

  // Record the dispatch so a re-drive after a crash returns the cached result
  // instead of re-firing the HTTP call. P2002 means another host won the race
  // — `recordDispatch` returns `false`. We deliberately discard that boolean:
  // the loser of the dispatch-row race is by definition the loser of the lease
  // race, and PR 1's lease-loss model cancels the loser's terminal events on
  // the next checkpoint write (`finalize` returns `false` on `count: 0` and
  // suppresses the `workflow_completed` yield + hooks + webhook). The loser's
  // `stepResult` is computed but never observed downstream, so re-reading the
  // winner's cached result here would be wasted work.
  //
  // Other DB errors are non-fatal — the step already succeeded, so we log and
  // continue. Worst-case on a re-drive that misses the cache: the call fires
  // again, and the cooperative remote's `Idempotency-Key` honour is the second
  // layer of dedup.
  try {
    await recordDispatch({
      executionId: ctx.executionId,
      stepId: step.id,
      result: stepResult,
    });
  } catch (err) {
    ctx.logger.warn('external_call: failed to record dispatch; re-drive may re-fire', {
      stepId: step.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return stepResult;
}

registerStepType('external_call', executeExternalCall);
