/**
 * `external_call` — HTTP call to an external endpoint or agent.
 *
 * Config:
 *   - `url: string` — target endpoint.
 *   - `method: 'GET' | 'POST' | 'PUT'` — HTTP method.
 *   - `headers?: Record<string, string>` — additional headers.
 *   - `bodyTemplate?: string` — JSON template with `{{input}}` interpolation.
 *   - `timeoutMs?: number` — request timeout (default 30 000 ms).
 *   - `authType?: 'none' | 'bearer' | 'api-key'` — authentication type.
 *   - `authSecret?: string` — env var name holding the secret (never a raw value).
 *
 * Security: URLs are validated against the `ORCHESTRATION_ALLOWED_HOSTS`
 * env var (comma-separated hostnames). An empty or absent allowlist
 * blocks all external calls.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import { externalCallConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';

const ALLOWED_HOSTS_ENV = 'ORCHESTRATION_ALLOWED_HOSTS';

function getAllowedHosts(): Set<string> {
  const raw = process.env[ALLOWED_HOSTS_ENV] ?? '';
  return new Set(
    raw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0)
  );
}

function isHostAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    const allowed = getAllowedHosts();
    return allowed.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function resolveAuthHeaders(
  authType: string | undefined,
  authSecret: string | undefined
): Record<string, string> {
  if (!authType || authType === 'none' || !authSecret) return {};

  const secretValue = process.env[authSecret];
  if (!secretValue) {
    return {};
  }

  if (authType === 'bearer') {
    return { Authorization: `Bearer ${secretValue}` };
  }
  if (authType === 'api-key') {
    return { 'X-API-Key': secretValue };
  }
  return {};
}

export async function executeExternalCall(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = externalCallConfigSchema.parse(step.config);

  const url = config.url;
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new ExecutorError(step.id, 'missing_url', 'external_call step is missing a URL');
  }

  if (!isHostAllowed(url)) {
    throw new ExecutorError(
      step.id,
      'host_not_allowed',
      `Host not in ${ALLOWED_HOSTS_ENV} allowlist: ${url}`
    );
  }

  const method = config.method ?? 'POST';
  const timeoutMs = typeof config.timeoutMs === 'number' ? config.timeoutMs : 30_000;
  const configHeaders = config.headers ?? {};
  const authHeaders = resolveAuthHeaders(config.authType, config.authSecret);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...configHeaders,
    ...authHeaders,
  };

  let body: string | undefined;
  if (method !== 'GET' && config.bodyTemplate) {
    body = interpolatePrompt(config.bodyTemplate, ctx);
  }

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `Request timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : 'Request failed';
    throw new ExecutorError(step.id, 'request_failed', message, err);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ExecutorError(
      step.id,
      'http_error',
      `HTTP ${response.status}: ${text.slice(0, 256)}`
    );
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = await response.text().catch(() => '');
  }

  return {
    output: { status: response.status, body: responseBody },
    tokensUsed: 0,
    costUsd: 0,
  };
}

registerStepType('external_call', executeExternalCall);
