import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';

/**
 * Seed the two built-in MCP prompts as DB rows so admins can edit / disable
 * them from the UI. The runtime prompt-registry still has a hardcoded
 * fallback for these names so a fresh install with no seed run keeps
 * working, but once the seed runs the DB row takes precedence.
 *
 * Idempotent — re-running never overwrites admin edits (the update branch
 * is intentionally empty).
 */
const unit: SeedUnit = {
  name: '015-mcp-prompts',
  async run({ prisma, logger }) {
    logger.info('💬 Seeding default MCP prompts...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    const defaultPrompts = [
      {
        name: 'analyze-pattern',
        description:
          'Generate a system prompt for analyzing a specific agentic design pattern from the knowledge base.',
        template:
          'Analyze agentic design pattern #{{pattern_number}} from the knowledge base. Explain its purpose, when to use it, implementation considerations, and how it compares to related patterns. Use the search_knowledge_base tool to retrieve the pattern details first.',
        argumentsSpec: [
          {
            name: 'pattern_number',
            description: 'The pattern number to analyze (1-21)',
            required: true,
          },
        ],
      },
      {
        name: 'search-knowledge',
        description:
          'Generate a structured search prompt for querying the knowledge base with context.',
        template:
          'Search the knowledge base for: "{{query}}". Context: {{context}}. Use the search_knowledge_base tool to find relevant information, then summarize the most relevant results.',
        argumentsSpec: [
          { name: 'query', description: 'The search query', required: true },
          { name: 'context', description: 'Additional context for the search', required: false },
        ],
      },
    ];

    for (const p of defaultPrompts) {
      await prisma.mcpExposedPrompt.upsert({
        where: { name: p.name },
        update: {},
        create: {
          name: p.name,
          description: p.description,
          template: p.template,
          argumentsSpec: p.argumentsSpec,
          isEnabled: true,
          createdBy: admin.id,
        },
      });
    }

    logger.info(`✅ Seeded ${String(defaultPrompts.length)} default MCP prompts`);
  },
};

export default unit;
