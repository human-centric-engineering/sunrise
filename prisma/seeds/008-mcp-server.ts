import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seed the MCP server: the global config singleton and the default exposed
 * resources.
 *
 * The `mcp-system` agent — the identity MCP tool calls dispatch as — is a
 * platform agent now (§116 t-724), materialised in every org by
 * `021-platform-agents`.
 *
 * Idempotent — safe to run on every deploy. Re-seeding never
 * overwrites admin edits (update branch is minimal).
 */
const unit: SeedUnit = {
  name: '008-mcp-server',
  async run({ prisma, logger }) {
    logger.info('🔌 Seeding MCP server config...');

    // 1. Global config singleton (disabled by default)
    await prisma.mcpServerConfig.upsert({
      where: { slug: 'global' },
      update: {},
      create: {
        slug: 'global',
        isEnabled: false,
        serverName: 'Sunrise MCP Server',
        serverVersion: '1.0.0',
        globalRateLimit: 60,
        auditRetentionDays: 90,
      },
    });

    // 2. Default resources (disabled by default)
    const defaultResources = [
      {
        uri: 'sunrise://knowledge/search',
        name: 'Knowledge Base Search',
        description: 'Semantic search over the agentic patterns knowledge base.',
        mimeType: 'application/json',
        resourceType: 'knowledge_search',
      },
      {
        uri: 'sunrise://agents',
        name: 'Agent List',
        description: 'List of active AI agents with name, slug, and description.',
        mimeType: 'application/json',
        resourceType: 'agent_list',
      },
      {
        uri: 'sunrise://workflows',
        name: 'Workflow List',
        description: 'List of active workflows with name, slug, and description.',
        mimeType: 'application/json',
        resourceType: 'workflow_list',
      },
    ];

    for (const res of defaultResources) {
      await prisma.mcpExposedResource.upsert({
        where: { uri: res.uri },
        update: {},
        create: {
          ...res,
          isEnabled: false,
          handlerConfig: Prisma.JsonNull,
        },
      });
    }

    logger.info('✅ Seeded MCP server config and 3 default resources');
  },
};

export default unit;
