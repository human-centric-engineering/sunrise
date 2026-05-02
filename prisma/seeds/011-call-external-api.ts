import type { SeedUnit } from '@/prisma/runner';

/**
 * Seed the `call_external_api` capability row.
 *
 * Adds the capability to the registry without binding it to any agent.
 * Bindings are created per-agent in the admin UI (or via API) using
 * the recipes in `.context/orchestration/recipes/` — keeping
 * outbound-HTTP power off-by-default for every agent.
 *
 * Idempotent — safe to run on every deploy. The `update` branch only
 * sets `isSystem: true` so re-seeding never overwrites admin edits.
 */
const unit: SeedUnit = {
  name: '011-call-external-api',
  async run({ prisma, logger }) {
    logger.info('🌐 Seeding call_external_api capability...');

    await prisma.aiCapability.upsert({
      where: { slug: 'call_external_api' },
      update: { isSystem: true },
      create: {
        slug: 'call_external_api',
        name: 'Call External API',
        description:
          'Make an outbound HTTP request to an allowlisted external API. Auth credentials, URL prefix restrictions, and idempotency policy are configured per-agent and not visible to the LLM.',
        category: 'external',
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
                  'Fully qualified HTTPS URL. The host must be in the deployment allowlist; if the binding restricts URL prefixes, the URL must start with an allowed prefix.',
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
            required: ['url', 'method'],
          },
        },
        rateLimit: 60,
        isActive: true,
        isSystem: true,
      },
    });

    logger.info('✅ Seeded call_external_api capability (no agent bindings — see recipes)');
  },
};

export default unit;
