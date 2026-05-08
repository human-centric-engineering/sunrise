import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/**
 * One-off data migration — 2026-05-07
 * ===================================
 *
 * Removes the 3 pre-seeded provider rows from existing dev databases.
 *
 * Background
 * ----------
 * Phase 3 of the provider-agnostic refactor deleted
 * `prisma/seeds/003-default-providers.ts`, which had been seeding three
 * placeholder rows (Anthropic, OpenAI, Ollama) on every fresh install
 * regardless of whether the operator wanted them. Fresh `db:reset`
 * runs will no longer create them — but existing dev DBs still have
 * the rows from previous seed runs, so the providers admin page still
 * shows three "configured" cards before the operator has chosen
 * anything.
 *
 * `db:reset` would clean these up but it's destructive (wipes users,
 * conversations, knowledge). This script is the targeted alternative:
 * it removes only the 3 specific slug-matched rows, and only when
 * they look untouched.
 *
 * What this script does
 * ---------------------
 * For each of the 3 slugs below:
 *   - Read the row.
 *   - Confirm it matches its seed shape exactly (`providerType`,
 *     `baseUrl`, `apiKeyEnvVar`). If the operator has edited any of
 *     those fields, the row is treated as customised and SKIPPED.
 *   - Confirm no agent has `provider = <slug>`. If any agent still
 *     references the slug, the row is SKIPPED so we don't break that
 *     agent's chat binding.
 *   - DELETE the row.
 *
 * Reports per-row outcome (deleted / skipped + reason) so the operator
 * can see what happened.
 *
 * What it explicitly does NOT do
 * ------------------------------
 * - Touch agents, conversations, settings, or anything else.
 * - Force-delete rows that fail the safety checks. If a row is
 *   customised or referenced, it stays. The operator can delete it
 *   manually from the providers page once they're sure.
 *
 * Idempotency
 * -----------
 * If a row is already gone, the loop logs "not found" and moves on.
 * Safe to re-run.
 *
 * Usage
 * -----
 *   tsx --env-file=.env.local scripts/migrations/2026-05-07-remove-pre-seeded-providers.ts
 *
 * Safe to delete this file once every active dev DB has run it.
 */

/**
 * The 3 slugs Phase 3 dropped from `prisma/seeds/003-default-providers.ts`.
 * The seed defaults below are used as a safety check — if the row's
 * current values don't match exactly, we treat it as customised and
 * skip the delete.
 */
const PRE_SEEDED_PROVIDERS = [
  {
    slug: 'anthropic',
    expectedProviderType: 'anthropic',
    expectedBaseUrl: null as string | null,
    expectedApiKeyEnvVar: 'ANTHROPIC_API_KEY' as string | null,
  },
  {
    slug: 'openai',
    expectedProviderType: 'openai-compatible',
    expectedBaseUrl: 'https://api.openai.com/v1' as string | null,
    expectedApiKeyEnvVar: 'OPENAI_API_KEY' as string | null,
  },
  {
    slug: 'ollama-local',
    expectedProviderType: 'openai-compatible',
    expectedBaseUrl: 'http://localhost:11434/v1' as string | null,
    expectedApiKeyEnvVar: null as string | null,
  },
];

async function main(): Promise<void> {
  logger.info('🧹 Removing pre-seeded provider rows from dev DB');

  for (const seed of PRE_SEEDED_PROVIDERS) {
    // ── Step 1: read row ─────────────────────────────────────────────
    const row = await prisma.aiProviderConfig.findUnique({
      where: { slug: seed.slug },
    });

    if (!row) {
      logger.info('  ℹ️  not present, skipping', { slug: seed.slug });
      continue;
    }

    // ── Step 2: customisation check ──────────────────────────────────
    // The original seed used a fixed (providerType, baseUrl, apiKeyEnvVar)
    // triple per slug. If any of those have drifted, the operator has
    // been editing, and we don't touch their work.
    const customised =
      row.providerType !== seed.expectedProviderType ||
      row.baseUrl !== seed.expectedBaseUrl ||
      row.apiKeyEnvVar !== seed.expectedApiKeyEnvVar;

    if (customised) {
      logger.warn('  ⚠️  skipped — row has been customised', {
        slug: seed.slug,
        providerType: row.providerType,
        baseUrl: row.baseUrl,
        apiKeyEnvVar: row.apiKeyEnvVar,
      });
      continue;
    }

    // ── Step 3: reference check ──────────────────────────────────────
    // If any agent still has provider = <slug>, deleting would break
    // that agent's chat binding at runtime. Skip and let the operator
    // resolve.
    const referencingCount = await prisma.aiAgent.count({
      where: { provider: seed.slug },
    });
    if (referencingCount > 0) {
      logger.warn('  ⚠️  skipped — agents still reference this provider', {
        slug: seed.slug,
        agentCount: referencingCount,
      });
      continue;
    }

    // ── Step 4: delete ───────────────────────────────────────────────
    await prisma.aiProviderConfig.delete({ where: { slug: seed.slug } });
    logger.info('  ✅ deleted', { slug: seed.slug, name: row.name });
  }

  // Final summary
  const remaining = await prisma.aiProviderConfig.findMany({
    select: { slug: true, name: true, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  logger.info('Final provider rows', {
    count: remaining.length,
    rows: remaining.map((r) => `${r.slug} (${r.isActive ? 'active' : 'inactive'})`),
  });

  logger.info('🎉 Migration complete');
}

main()
  .catch((err) => {
    logger.error('❌ Migration failed', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
