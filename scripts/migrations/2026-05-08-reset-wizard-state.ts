import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { KNOWN_PROVIDERS } from '@/lib/orchestration/llm/known-providers';

/**
 * One-off dev-only reset — 2026-05-08
 * ===================================
 *
 * Wipes only the state that the setup wizard's "Configure" flow
 * touches, so the operator can re-test the wizard from a clean slate
 * without running `db:reset` (which would also blow away their user,
 * conversations, knowledge, etc.).
 *
 * What this script does
 * ---------------------
 * 1. For every provider row whose `slug` matches a `KNOWN_PROVIDERS`
 *    entry AND whose shape (providerType / baseUrl / apiKeyEnvVar)
 *    matches the registry exactly:
 *      - Skip if any agent has `provider = <slug>` (deleting would
 *        break that agent's runtime binding).
 *      - Otherwise delete the row.
 *    Customised provider rows are left alone — operator edits never
 *    get clobbered.
 *
 * 2. Reset `AiOrchestrationSettings.defaultModels` to `{}` so the
 *    wizard sees an empty map on next open and re-writes its
 *    suggestions.
 *
 * What it explicitly does NOT do
 * ------------------------------
 * - Delete users, conversations, capabilities, agents, knowledge,
 *   workflows, executions, audit log, etc.
 * - Touch any provider row whose shape doesn't match `KNOWN_PROVIDERS`
 *   (could be a manual config or a custom endpoint).
 * - Touch other singleton fields — guard modes, retention, budget cap,
 *   approvals, search config all stay intact.
 *
 * Usage
 * -----
 *   tsx --env-file=.env.local scripts/migrations/2026-05-08-reset-wizard-state.ts
 *
 * Idempotent — re-running with no changes produces "nothing to do".
 * Safe to delete this file once the dev no longer needs to re-test
 * the wizard fresh.
 */

async function main(): Promise<void> {
  logger.info('🧹 Resetting wizard-touched state (dev-only)');

  // ── Step 1: delete provider rows that look wizard-configured ─────
  const providers = await prisma.aiProviderConfig.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      providerType: true,
      baseUrl: true,
      apiKeyEnvVar: true,
    },
  });

  if (providers.length === 0) {
    logger.info('  ℹ️  No provider rows present — nothing to delete.');
  }

  for (const p of providers) {
    const known = KNOWN_PROVIDERS.find((k) => k.slug === p.slug);
    if (!known) {
      logger.info('  ⏭   skipping (slug not in KNOWN_PROVIDERS)', { slug: p.slug });
      continue;
    }

    // Same safety triple used by `2026-05-07-remove-pre-seeded-providers.ts`.
    // If any of these drift the operator has been editing — leave alone.
    const matchesShape =
      p.providerType === known.providerType &&
      p.baseUrl === known.defaultBaseUrl &&
      p.apiKeyEnvVar === (known.apiKeyEnvVars[0] ?? null);

    if (!matchesShape) {
      logger.warn('  ⚠️  skipped — row has been customised', {
        slug: p.slug,
        providerType: p.providerType,
        baseUrl: p.baseUrl,
        apiKeyEnvVar: p.apiKeyEnvVar,
      });
      continue;
    }

    const referencingCount = await prisma.aiAgent.count({
      where: { provider: p.slug },
    });
    if (referencingCount > 0) {
      logger.warn('  ⚠️  skipped — agents still reference this provider', {
        slug: p.slug,
        agentCount: referencingCount,
      });
      continue;
    }

    await prisma.aiProviderConfig.delete({ where: { id: p.id } });
    logger.info('  ✅ deleted', { slug: p.slug, name: p.name });
  }

  // ── Step 2: clear default-model assignments ──────────────────────
  // Empty map → the wizard's `current.chat` / `.embeddings` checks
  // see undefined and re-write the suggestion. Other singleton
  // fields (budget cap, guard modes, retention, etc.) stay intact.
  const settings = await prisma.aiOrchestrationSettings.findUnique({
    where: { slug: 'global' },
    select: { defaultModels: true },
  });
  if (!settings) {
    logger.info('  ℹ️  No settings singleton row — nothing to clear.');
  } else {
    await prisma.aiOrchestrationSettings.update({
      where: { slug: 'global' },
      data: { defaultModels: {} },
    });
    logger.info('  ✅ cleared AiOrchestrationSettings.defaultModels', {
      previous: settings.defaultModels,
    });
  }

  // ── Step 3: report ───────────────────────────────────────────────
  const remaining = await prisma.aiProviderConfig.findMany({
    select: { slug: true, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  logger.info('Remaining provider rows', {
    count: remaining.length,
    rows: remaining.map((r) => `${r.slug} (${r.isActive ? 'active' : 'inactive'})`),
  });

  logger.info('🎉 Reset complete');
}

main()
  .catch((err) => {
    logger.error('❌ Reset failed', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
