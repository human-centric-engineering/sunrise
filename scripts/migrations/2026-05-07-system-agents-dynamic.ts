import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/**
 * One-off data migration — 2026-05-07
 * ===================================
 *
 * Aligns existing dev databases with the provider-agnostic refactor on
 * branch `feat/provider-agnostic-orchestration`.
 *
 * Background
 * ----------
 * Phases 0-2 of that refactor changed the seed files so fresh installs
 * ship the 5 system-seeded agents with empty `provider`/`model`
 * strings. The runtime resolver (`lib/orchestration/llm/agent-resolver.ts`)
 * fills the binding from:
 *
 *   1. The first active `AiProviderConfig` whose `apiKeyEnvVar` is set
 *      in `process.env` (or whose row is `isLocal`).
 *   2. `AiOrchestrationSettings.defaultModels.chat` (written by the
 *      setup wizard when the operator picks a provider), falling back
 *      through `getDefaultModelForTask('chat')` to the registry's
 *      static defaults.
 *
 * Existing dev DBs predate the seed change and still hold the old
 * hardcoded values:
 *
 *   provider: 'anthropic', model: 'claude-sonnet-4-6'
 *
 * `npm run db:reset` would normalise them but it's destructive — wipes
 * users, conversations, knowledge, and everything else. This script is
 * the non-destructive equivalent: it touches only the 5 system-agent rows.
 *
 * What this script does
 * ---------------------
 * - SELECT the 5 rows below by `slug` and log their current state.
 * - UPDATE both columns to `''` for any row where they're still non-empty.
 * - SELECT again and log the new state.
 *
 * What it explicitly does NOT do
 * ------------------------------
 * - Touch `AiOrchestrationSettings.defaultModels.*`. The wizard writes
 *   that based on the provider the operator actually chooses, so we
 *   don't pre-populate it here. No hardcoded model preservation.
 * - Touch any non-system agents. The `WHERE slug IN (...)` clause is
 *   the entire scope.
 * - Migrate users, conversations, capabilities, or anything else.
 *
 * Idempotency
 * -----------
 * The UPDATE is gated on `provider <> '' OR model <> ''`, so a second
 * run is a no-op (count = 0, before/after states match).
 *
 * Usage
 * -----
 *   tsx --env-file=.env.local scripts/migrations/2026-05-07-system-agents-dynamic.ts
 *
 * Safe to delete this file once every active dev DB has run it.
 */

/**
 * Slugs of the 5 system-seeded agents the refactor touches. These mirror
 * the seed files at `prisma/seeds/{005,006,008,010}-*.ts`. Adding a new
 * system agent? It probably belongs on this list — but only if its seed
 * sets `provider: ''` and `model: ''`.
 */
const SYSTEM_AGENT_SLUGS = [
  'pattern-advisor', // prisma/seeds/005-pattern-advisor.ts
  'quiz-master', // prisma/seeds/006-quiz-master.ts
  'mcp-system', // prisma/seeds/008-mcp-server.ts
  'provider-model-auditor', // prisma/seeds/010-model-auditor.ts (1 of 2)
  'audit-report-writer', // prisma/seeds/010-model-auditor.ts (2 of 2)
];

async function main(): Promise<void> {
  logger.info('🔄 Migrating system agents to dynamic provider/model resolution');

  // ── Step 1: snapshot ───────────────────────────────────────────────
  // Read the 5 rows by slug and log their current state. If none match,
  // the DB doesn't have these system agents (e.g. a brand-new install
  // that already seeded with empty strings) — exit cleanly.
  const before = await prisma.aiAgent.findMany({
    where: { slug: { in: SYSTEM_AGENT_SLUGS } },
    select: { slug: true, provider: true, model: true, isSystem: true },
  });

  if (before.length === 0) {
    logger.warn('No system agents matched — nothing to update');
    return;
  }

  for (const agent of before) {
    logger.info('  before', {
      slug: agent.slug,
      provider: agent.provider || '(empty)',
      model: agent.model || '(empty)',
      isSystem: agent.isSystem,
    });
  }

  // ── Step 2: clear ──────────────────────────────────────────────────
  // Set provider='' and model='' on any matching row that isn't already
  // empty. The OR-clause makes the UPDATE a no-op on subsequent runs:
  // re-running this script reports `count: 0` instead of bumping
  // `updatedAt` on rows that are already correct.
  const updateResult = await prisma.aiAgent.updateMany({
    where: {
      slug: { in: SYSTEM_AGENT_SLUGS },
      OR: [{ provider: { not: '' } }, { model: { not: '' } }],
    },
    data: { provider: '', model: '' },
  });
  logger.info('✅ Cleared provider/model on system agents', { count: updateResult.count });

  // ── Step 3: verify ─────────────────────────────────────────────────
  // Re-read and log so the operator can confirm in the console output.
  // No assertion — Prisma already threw if the UPDATE failed.
  const after = await prisma.aiAgent.findMany({
    where: { slug: { in: SYSTEM_AGENT_SLUGS } },
    select: { slug: true, provider: true, model: true },
  });
  for (const agent of after) {
    logger.info('  after', {
      slug: agent.slug,
      provider: agent.provider || '(empty)',
      model: agent.model || '(empty)',
    });
  }

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
