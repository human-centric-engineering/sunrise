import type { SeedUnit } from '@/prisma/runner';

/**
 * Seed the `call_external_api` capability row.
 *
 * Adds the capability to the registry without binding it to any agent.
 * Bindings are created per-agent in the admin UI (or via API) using
 * the recipes in `.context/orchestration/recipes/` — keeping
 * outbound-HTTP power off-by-default for every agent.
 *
 * Idempotent — safe to run on every deploy. Re-seeding re-applies the
 * code-owned fields (see the constant below) and leaves everything the
 * admin owns — `name`, `description`, `category`, `isActive`, `rateLimit` —
 * exactly as it found them.
 */
/**
 * Code-owned half of the capability row: these must track the capability
 * class, so the seed re-applies them to rows that already exist. A stale
 * `functionDefinition` is not an admin customisation — it is a schema the
 * handler will reject, advertised to every LLM and MCP client (#545).
 *
 * The LLM-facing name and description live INSIDE `functionDefinition`;
 * the row's own `name` / `description` are admin-UI presentation and stay
 * operator-owned, along with `isActive` and `rateLimit`.
 */
export const CALL_EXTERNAL_API_IMPL = {
  executionType: 'internal',
  executionHandler: 'CallExternalApiCapability',
  functionDefinition: {
    name: 'call_external_api',
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
            'Optional request body. Object → JSON-stringified; string → sent verbatim. Ignored for GET and DELETE. Mutually exclusive with `multipart` — supply one or the other.',
        },
        multipart: {
          type: 'object',
          description:
            'Optional multipart/form-data body for endpoints that require named file parts (e.g. document renderers like Gotenberg). Mutually exclusive with `body`. Per-file size cap is 8 MB base64; total request body cap is 25 MB.',
          properties: {
            files: {
              type: 'array',
              description:
                'File parts. Each entry is `{ name, filename?, contentType, data }` where `data` is base64-encoded bytes. If a previous tool returned `{ encoding: "base64", data }`, pass that `data` directly here.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  filename: { type: 'string' },
                  contentType: { type: 'string' },
                  data: { type: 'string' },
                },
                required: ['name', 'contentType', 'data'],
              },
            },
            fields: {
              type: 'object',
              description: 'Optional plain-text field parts (form key → value).',
              additionalProperties: { type: 'string' },
            },
          },
          required: ['files'],
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
  },
};

const unit: SeedUnit = {
  name: '011-call-external-api',
  async run({ prisma, logger }) {
    logger.info('🌐 Seeding call_external_api capability...');

    await prisma.aiCapability.upsert({
      where: { slug: 'call_external_api' },
      update: { isSystem: true, ...CALL_EXTERNAL_API_IMPL },
      create: {
        slug: 'call_external_api',
        name: 'Call External API',
        description:
          'Make an outbound HTTP request to an allowlisted external API. Auth credentials, URL prefix restrictions, and idempotency policy are configured per-agent and not visible to the LLM.',
        category: 'external',
        rateLimit: 60,
        isActive: true,
        isSystem: true,
        ...CALL_EXTERNAL_API_IMPL,
      },
    });

    logger.info('✅ Seeded call_external_api capability (no agent bindings — see recipes)');
  },
};

export default unit;
