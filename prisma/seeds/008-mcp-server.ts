import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seed the MCP server: global config singleton + mcp-system agent.
 *
 * Idempotent — safe to run on every deploy. Re-seeding never
 * overwrites admin edits (update branch is minimal).
 */
const unit: SeedUnit = {
  name: '008-mcp-server',
  async run({ prisma, logger }) {
    logger.info('🔌 Seeding MCP server config and system agent...');

    // 1. Global config singleton (disabled by default)
    await prisma.mcpServerConfig.upsert({
      where: { slug: 'global' },
      update: {},
      create: {
        slug: 'global',
        isEnabled: false,
        serverName: 'Sunrise MCP Server',
        serverVersion: '1.0.0',
        maxSessionsPerKey: 5,
        globalRateLimit: 60,
        auditRetentionDays: 90,
      },
    });

    // 2. System agent for MCP tool dispatch
    const admin = await prisma.user.findFirst({
      where: { role: 'ADMIN' },
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-test-users runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: 'mcp-system' },
      update: {
        isSystem: true,
        description:
          'System agent — do not edit. Used internally by the MCP server as the execution identity when external AI clients (Claude Desktop, Cursor, etc.) call tools. To expose capabilities to MCP clients, use the MCP Server → Tools page instead of assigning capabilities here.',
        systemInstructions:
          'You are the MCP system agent. You dispatch tool calls on behalf of external MCP clients. This agent never participates in LLM conversations — it exists solely as the execution identity for capability pipeline dispatch.',
      },
      create: {
        name: 'MCP System',
        slug: 'mcp-system',
        description:
          'System agent — do not edit. Used internally by the MCP server as the execution identity when external AI clients (Claude Desktop, Cursor, etc.) call tools. To expose capabilities to MCP clients, use the MCP Server → Tools page instead of assigning capabilities here.',
        systemInstructions:
          'You are the MCP system agent. You dispatch tool calls on behalf of external MCP clients. This agent never participates in LLM conversations — it exists solely as the execution identity for capability pipeline dispatch.',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        temperature: 0,
        maxTokens: 4096,
        isActive: true,
        isSystem: true,
        createdBy: admin.id,
      },
    });

    // 3. Default resources (disabled by default)
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

    logger.info('✅ Seeded MCP server config, system agent, and 3 default resources');
  },
};

export default unit;
