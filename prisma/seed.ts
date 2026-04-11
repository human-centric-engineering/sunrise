import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { logger } from '../lib/logging';
import { DEFAULT_FLAGS } from '../lib/feature-flags/config';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

async function main() {
  logger.info('🌱 Seeding database...');

  // Clear existing data (in development only)
  if (process.env.NODE_ENV === 'development') {
    logger.info('🗑️  Clearing existing data...');
    await prisma.verification.deleteMany();
    await prisma.session.deleteMany();
    await prisma.account.deleteMany();
    // Clear orchestration rows that FK to User before deleting users, or
    // the deleteMany below fails with a foreign-key error.
    await prisma.aiProviderConfig.deleteMany();
    await prisma.user.deleteMany();
    await prisma.featureFlag.deleteMany();
  }

  // Create test users
  logger.info('👤 Creating test users...');

  const testUser = await prisma.user.create({
    data: {
      email: 'test@example.com',
      name: 'Test User',
      emailVerified: true,
      role: 'USER',
    },
  });

  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@example.com',
      name: 'Admin User',
      emailVerified: true,
      role: 'ADMIN',
    },
  });

  logger.info('✅ Created test user', { email: testUser.email });
  logger.info('✅ Created admin user', { email: adminUser.email });

  // Seed default feature flags
  logger.info('🚩 Seeding feature flags...');

  const { count } = await prisma.featureFlag.createMany({
    data: DEFAULT_FLAGS.map((flag) => ({
      name: flag.name,
      description: flag.description,
      enabled: flag.enabled,
      metadata: flag.metadata,
    })),
  });
  logger.info(`✅ Created ${count} feature flags`);

  // Seed default LLM providers (Anthropic / OpenAI / Ollama).
  // Idempotent on every run: `upsert({ update: {} })` never overwrites
  // rows the admin may have edited in the UI. `isActive` is driven by
  // env-var presence at seed time so a fresh install with
  // `ANTHROPIC_API_KEY` set lights up the provider immediately.
  await seedDefaultProviders(adminUser.id);

  logger.info('🎉 Seeding complete!');
}

/**
 * Upsert the three default providers (anthropic, openai, ollama-local).
 *
 * - Anthropic — first-party Claude; active iff `ANTHROPIC_API_KEY` is set.
 * - OpenAI — OpenAI-compatible w/ canonical base URL; active iff
 *   `OPENAI_API_KEY` is set.
 * - Ollama — local/loopback; inactive by default (admins toggle on after
 *   they install Ollama).
 *
 * Keyed by slug. The `create` branch is the only branch that writes, so
 * re-running the seeder against an admin-edited row is a no-op.
 */
async function seedDefaultProviders(createdBy: string): Promise<void> {
  logger.info('🔌 Seeding default providers...');

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
      // Empty update — re-seeding never overwrites admin edits.
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
}

main()
  .catch((e) => {
    logger.error('❌ Seeding failed', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
