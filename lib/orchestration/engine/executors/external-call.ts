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

  const idempotency = config.idempotencyKey
    ? { key: config.idempotencyKey, headerName: config.idempotencyKeyHeader }
    : undefined;

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
      return {
        output: {
          status: response.status,
          body: response.body,
          _transformError: response.transformError,
        },
        tokensUsed: 0,
        costUsd: 0,
      };
    }

    return {
      output: { status: response.status, body: response.body },
      tokensUsed: 0,
      costUsd: 0,
    };
  } catch (err) {
    if (err instanceof HttpError) {
      const code = HTTP_TO_EXECUTOR_CODE[err.code] ?? 'http_error';
      throw new ExecutorError(step.id, code, err.message, err.cause, err.retriable);
    }
    throw err;
  }
}

registerStepType('external_call', executeExternalCall);
