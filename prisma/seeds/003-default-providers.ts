import type { SeedUnit } from '@/prisma/runner';

/**
 * Upsert the three default providers (anthropic, openai, ollama-local).
 *
 * - Anthropic — first-party Claude; active iff `ANTHROPIC_API_KEY` is set.
 * - OpenAI — OpenAI-compatible w/ canonical base URL; active iff
 *   `OPENAI_API_KEY` is set.
 * - Ollama — local/loopback; inactive by default (admins toggle on after
 *   they install Ollama).
 *
 * Keyed by slug. The `update` branch is empty so re-seeding never
 * overwrites admin edits.
 */
const unit: SeedUnit = {
  name: '003-default-providers',
  async run({ prisma, logger }) {
    logger.info('🔌 Seeding default providers...');

    const admin = await prisma.user.findFirst({
      where: { role: 'ADMIN' },
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-test-users runs first.');
    }
    const createdBy = admin.id;

    const defaults = [
      {
        slug: 'anthropic',
        name: 'Anthropic',
        providerType: 'anthropic',
        baseUrl: null as string | null,
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
        isLocal: false,
        isActive: Boolean(process.env.ANTHROPIC_API_KEY),
      },
      {
        slug: 'openai',
        name: 'OpenAI',
        providerType: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnvVar: 'OPENAI_API_KEY',
        isLocal: false,
        isActive: Boolean(process.env.OPENAI_API_KEY),
      },
      {
        slug: 'ollama-local',
        name: 'Ollama (Local)',
        providerType: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        apiKeyEnvVar: null as string | null,
        isLocal: true,
        isActive: false,
      },
    ];

    for (const p of defaults) {
      await prisma.aiProviderConfig.upsert({
        where: { slug: p.slug },
        update: {},
        create: {
          slug: p.slug,
          name: p.name,
          providerType: p.providerType,
          baseUrl: p.baseUrl,
          apiKeyEnvVar: p.apiKeyEnvVar,
          isLocal: p.isLocal,
          isActive: p.isActive,
          createdBy,
        },
      });
    }

    logger.info(`✅ Upserted ${defaults.length} default providers`);
  },
};

export default unit;
