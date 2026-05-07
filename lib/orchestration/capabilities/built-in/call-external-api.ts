/**
 * `call_external_api` capability
 *
 * Lets an agent make outbound HTTP requests to allowlisted hosts. The
 * LLM picks `url` / `method` / `body` / `headers` from a per-agent
 * binding; auth credentials, idempotency policy, and URL prefix
 * restrictions live in `AiAgentCapability.customConfig` so the LLM
 * never sees a secret env-var name and can't escape an admin-defined
 * URL prefix.
 *
 * Recipes in `.context/orchestration/recipes/` show how to bind this
 * capability for transactional email, payments, chat notifications,
 * calendar events, and document rendering — all without bundling any
 * vendor SDK.
 *
 * Security posture:
 * - Hosts are gated by `ORCHESTRATION_ALLOWED_HOSTS` (allowlist module).
 * - Auth secrets are env-var names resolved at request time; never in
 *   args, never logged, never round-tripped through the LLM.
 * - Optional `allowedUrlPrefixes` in `customConfig` constrains the LLM
 *   to specific endpoints within an allowed host (recommended for
 *   payment-shaped APIs).
 */

import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import {
  EnvTemplateError,
  containsEnvTemplate,
  resolveEnvTemplate,
  resolveEnvTemplatesInRecord,
} from '@/lib/orchestration/env-template';
import {
  executeHttpRequest,
  HttpError,
  mergeHeaders,
  type HttpAuthConfig,
  type HttpMethod,
  type ResponseTransform,
} from '@/lib/orchestration/http';

/**
 * Per-agent binding config stored in `AiAgentCapability.customConfig`.
 * Validated when admin saves the binding (see callers in the API
 * route); validated again here defensively before each call so a
 * malformed JSON column never silently disables guard rails.
 */
const customConfigSchema = z
  .object({
    /** Optional URL-prefix allowlist. If set, the LLM-supplied URL must startsWith one entry. */
    allowedUrlPrefixes: z.array(z.string().url()).min(1).optional(),
    /** Replaces the LLM-supplied URL entirely. When set, `allowedUrlPrefixes` is ignored — the binding
     * pins one exact endpoint. Useful for chat-platform incoming webhooks where the URL itself is a
     * secret the LLM should not need to know. May contain `${env:VAR}` references (resolved at call
     * time); the resolved value must parse as a URL. */
    forcedUrl: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) => containsEnvTemplate(value) || isParsableUrl(value), {
        message: 'forcedUrl must be a valid URL or contain ${env:VAR} references',
      })
      .optional(),
    /** Auth config — `type: 'none'` is valid and explicit. */
    auth: z
      .object({
        type: z.enum(['none', 'bearer', 'api-key', 'query-param', 'basic', 'hmac']),
        secret: z.string().optional(),
        queryParam: z.string().optional(),
        apiKeyHeaderName: z.string().optional(),
        hmacHeaderName: z.string().optional(),
        hmacAlgorithm: z.enum(['sha256', 'sha512']).optional(),
        hmacBodyTemplate: z.string().optional(),
      })
      .optional(),
    /** Headers always applied; override anything the LLM tries to set with the same key. */
    forcedHeaders: z.record(z.string(), z.string()).optional(),
    /** When true, attach an auto-generated UUID Idempotency-Key on every call. */
    autoIdempotency: z.boolean().optional(),
    /** Override the default Idempotency-Key header name. */
    idempotencyHeader: z.string().optional(),
    /** Apply this transform to every response unless the LLM supplies its own via `responseExtract`. */
    defaultResponseTransform: z
      .object({
        type: z.enum(['jmespath', 'template']),
        expression: z.string().min(1).max(2000),
      })
      .optional(),
    /** Per-binding timeout override (ms). */
    timeoutMs: z.number().int().positive().optional(),
    /** Per-binding response-size cap override (bytes). */
    maxResponseBytes: z.number().int().positive().optional(),
  })
  .strict();

type CustomConfig = z.infer<typeof customConfigSchema>;

const argsSchema = z.object({
  /** Optional — the binding's `forcedUrl` (if set) takes precedence; otherwise this is required. */
  url: z.string().url().max(2048).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  /**
   * Optional JMESPath expression. The LLM can request a structured
   * extraction inline; otherwise the binding's
   * `defaultResponseTransform` is used (if any).
   */
  responseExtract: z.string().min(1).max(2000).optional(),
});

type Args = z.infer<typeof argsSchema>;

interface Data {
  status: number;
  body: unknown;
  /** Set when a response transform threw; the unprocessed body is returned in `body`. */
  transformError?: string;
}

const SLUG = 'call_external_api';

function isParsableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export class CallExternalApiCapability extends BaseCapability<Args, Data> {
  readonly slug = SLUG;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: SLUG,
    description:
      'Make an outbound HTTP request to an allowlisted external API. URL, method, headers, and body are supplied by the caller; authentication is configured by the admin per-agent and is not visible to the LLM. Use this when the agent needs to send an email, post a notification, charge a card, fetch data from a third-party service, or otherwise interact with an external system.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Fully qualified HTTPS URL. The host must be in the deployment allowlist; if the binding restricts URL prefixes, the URL must start with an allowed prefix. May be omitted when the binding pins a `forcedUrl`.',
          maxLength: 2048,
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          description: 'HTTP method.',
        },
        headers: {
          type: 'object',
          description:
            'Optional request headers. Per-binding `forcedHeaders` override any matching key here.',
          additionalProperties: { type: 'string' },
        },
        body: {
          description:
            'Optional request body. Object → JSON-stringified; string → sent verbatim. Ignored for GET and DELETE.',
        },
        responseExtract: {
          type: 'string',
          description:
            'Optional JMESPath expression to apply to the response body before returning. Falls back to the binding default when omitted.',
          maxLength: 2000,
        },
      },
      required: ['method'],
    },
  };

  protected readonly schema = argsSchema;

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const loaded = await this.loadCustomConfig(context.agentId);

    // Fail-closed on malformed binding JSON: every per-binding guard rail
    // (forcedUrl, allowedUrlPrefixes, auth, forcedHeaders) is gated on
    // `customConfig?.<field>`, so silently downgrading to "no binding"
    // would let the LLM call any path on the allowlisted host with no
    // auth — a real risk for chat-webhook-style bindings where the URL
    // itself is the credential. Refuse the call until an admin repairs
    // the customConfig column.
    if (loaded.kind === 'malformed') {
      logger.error('call_external_api: refusing call — customConfig JSON is malformed', {
        agentId: context.agentId,
        issues: loaded.issues,
      });
      return this.error(
        'Capability binding is misconfigured — admin must repair the customConfig JSON',
        'invalid_binding'
      );
    }
    const customConfig = loaded.config;

    // Resolve `${env:VAR}` templates in admin-set credential-bearing
    // fields. Read-time resolution: the literal template stays in the
    // DB and the secret only exists in process memory. Fail-closed —
    // missing env var is reported as an invalid binding so the call
    // never silently downgrades to wrong-target / unauthenticated.
    let resolvedForcedUrl: string | undefined;
    let resolvedForcedHeaders: Record<string, string> | undefined;
    try {
      resolvedForcedUrl = customConfig?.forcedUrl
        ? resolveEnvTemplate(customConfig.forcedUrl)
        : undefined;
      resolvedForcedHeaders = resolveEnvTemplatesInRecord(customConfig?.forcedHeaders);
    } catch (err) {
      if (err instanceof EnvTemplateError) {
        logger.error(
          'call_external_api: refusing call — env var referenced by binding is not set',
          {
            agentId: context.agentId,
            envVarName: err.envVarName,
          }
        );
        return this.error(
          `Capability binding references env var "${err.envVarName}" which is not set`,
          'invalid_binding'
        );
      }
      throw err;
    }

    if (resolvedForcedUrl && !isParsableUrl(resolvedForcedUrl)) {
      logger.error('call_external_api: refusing call — resolved forcedUrl is not a valid URL', {
        agentId: context.agentId,
      });
      return this.error(
        'Capability binding forcedUrl resolved to an invalid URL',
        'invalid_binding'
      );
    }

    // forcedUrl takes precedence over both args.url and allowedUrlPrefixes —
    // the binding pins one exact endpoint and the LLM-supplied URL is discarded.
    const url = resolvedForcedUrl ?? args.url;
    if (!url) {
      return this.error(
        'No URL supplied — provide a `url` arg, or bind `forcedUrl` in the customConfig',
        'invalid_args'
      );
    }

    if (
      !customConfig?.forcedUrl &&
      customConfig?.allowedUrlPrefixes &&
      args.url &&
      !customConfig.allowedUrlPrefixes.some((prefix) => args.url!.startsWith(prefix))
    ) {
      return this.error(
        `URL not allowed by binding: must start with one of ${customConfig.allowedUrlPrefixes.join(', ')}`,
        'url_not_allowed'
      );
    }

    const auth: HttpAuthConfig | undefined = customConfig?.auth
      ? {
          type: customConfig.auth.type,
          secret: customConfig.auth.secret,
          queryParam: customConfig.auth.queryParam,
          apiKeyHeaderName: customConfig.auth.apiKeyHeaderName,
          hmacHeaderName: customConfig.auth.hmacHeaderName,
          hmacAlgorithm: customConfig.auth.hmacAlgorithm,
          hmacBodyTemplate: customConfig.auth.hmacBodyTemplate,
        }
      : undefined;

    // mergeHeaders is case-insensitive so the LLM can't smuggle an
    // `authorization` past forcedHeaders' `Authorization` by varying case.
    const headers = mergeHeaders(args.headers, resolvedForcedHeaders);

    const idempotency = customConfig?.autoIdempotency
      ? { key: 'auto', headerName: customConfig.idempotencyHeader }
      : undefined;

    const body = stringifyBody(args.body);

    const responseTransform: ResponseTransform | undefined = args.responseExtract
      ? { type: 'jmespath', expression: args.responseExtract }
      : customConfig?.defaultResponseTransform;

    try {
      const response = await executeHttpRequest({
        url,
        method: args.method as HttpMethod,
        headers,
        body,
        auth,
        idempotency,
        timeoutMs: customConfig?.timeoutMs,
        maxResponseBytes: customConfig?.maxResponseBytes,
        responseTransform,
        logContext: {
          capability: SLUG,
          agentId: context.agentId,
          conversationId: context.conversationId,
        },
      });

      return this.success({
        status: response.status,
        body: response.body,
        ...(response.transformError ? { transformError: response.transformError } : {}),
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return this.error(err.message, mapHttpErrorCode(err.code));
      }
      logger.error('call_external_api: unexpected error', {
        agentId: context.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.error(err instanceof Error ? err.message : 'Unknown error', 'capability_error');
    }
  }

  private async loadCustomConfig(agentId: string): Promise<LoadCustomConfigResult> {
    const binding = await prisma.aiAgentCapability.findFirst({
      where: { agentId, capability: { slug: SLUG } },
      select: { customConfig: true },
    });
    if (!binding?.customConfig) return { kind: 'ok', config: undefined };

    const parsed = customConfigSchema.safeParse(binding.customConfig);
    if (!parsed.success) {
      return { kind: 'malformed', issues: parsed.error.issues };
    }
    return { kind: 'ok', config: parsed.data };
  }
}

type LoadCustomConfigResult =
  | { kind: 'ok'; config: CustomConfig | undefined }
  | { kind: 'malformed'; issues: ReadonlyArray<unknown> };

function stringifyBody(body: Args['body']): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

function mapHttpErrorCode(code: string): string {
  switch (code) {
    case 'host_not_allowed':
      return 'host_not_allowed';
    case 'missing_auth_secret':
      return 'auth_failed';
    case 'outbound_rate_limited':
      return 'rate_limited';
    case 'request_timeout':
      return 'timeout';
    case 'request_aborted':
      return 'request_aborted';
    case 'response_too_large':
      return 'response_too_large';
    case 'http_error':
    case 'http_error_retriable':
      return 'http_error';
    default:
      return 'request_failed';
  }
}

/** Test-only export. */
export const __testing = { customConfigSchema, argsSchema };
