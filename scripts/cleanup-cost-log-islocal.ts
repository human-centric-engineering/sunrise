/**
 * One-off cleanup: flip `AiCostLog.isLocal` back to `false` for rows
 * that got the flag stamped by mistake.
 *
 * Background
 * ----------
 * Two bugs in the cost tracker caused non-local model calls to be
 * persisted with `isLocal: true` and `totalCostUsd: 0`:
 *
 *   1. `calculateCost` returned `isLocal: true` for unknown model ids
 *      (every model not in the in-memory registry — which on a server
 *      with a failed OpenRouter refresh meant nearly everything outside
 *      the static fallback map).
 *   2. `classifyTier` collapsed any model with `inputCostPerMillion <= 0`
 *      into `tier: 'local'`, including `:free` variants on OpenRouter,
 *      which then took the `model.tier === 'local'` branch in
 *      `calculateCost` and got `isLocal: true`.
 *
 * Both source bugs are fixed; new rows write `isLocal: false` for the
 * affected cases. This script back-fills the existing rows so the
 * `Local vs. cloud` panel stops reporting phantom savings for the
 * current month.
 *
 * Cleanup criterion
 * -----------------
 * For every row with `isLocal: true`, check whether the row's
 * `provider` slug matches a provider that is genuinely local:
 *
 *   - Hardcoded local set: { 'ollama-local' } (see `known-providers.ts`)
 *   - DB-configured providers: rows in `AiProviderConfig` with `isLocal: true`
 *
 * Rows whose provider is NOT in that set get flipped to `isLocal: false`.
 * Per-row `totalCostUsd` is left at $0 — we cannot reconstruct the
 * historical price after the fact. The next monthly rollover will age
 * these rows out of the savings window naturally; the flip just stops
 * them inflating the panel in the meantime.
 *
 * SCOPE — touches one table: `ai_cost_log` (UPDATE only, no DELETE).
 *
 * Run via:  npx tsx --env-file=.env.local scripts/cleanup-cost-log-islocal.ts
 *           add `--yes` to skip the confirmation prompt
 *           add `--dry-run` to only report counts without writing
 */
import dotenv from 'dotenv';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'node:process';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { KNOWN_PROVIDERS } from '@/lib/orchestration/llm/known-providers';

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function resolveLocalProviderSlugs(): Promise<Set<string>> {
  const slugs = new Set<string>();
  for (const p of KNOWN_PROVIDERS) {
    if (p.isLocal) slugs.add(p.slug);
  }
  const dbLocal = await prisma.aiProviderConfig.findMany({
    where: { isLocal: true },
    select: { slug: true },
  });
  for (const row of dbLocal) slugs.add(row.slug);
  return slugs;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const skipConfirm = args.has('--yes');
  const dryRun = args.has('--dry-run');

  const localSlugs = await resolveLocalProviderSlugs();
  const localSlugList = Array.from(localSlugs);

  logger.info(
    `Genuinely-local provider slugs: ${localSlugList.length === 0 ? '(none)' : localSlugList.join(', ')}`
  );

  const wronglyFlaggedRows = await prisma.aiCostLog.findMany({
    where: {
      isLocal: true,
      ...(localSlugList.length > 0 ? { provider: { notIn: localSlugList } } : {}),
    },
    select: { id: true, provider: true, model: true },
  });

  if (wronglyFlaggedRows.length === 0) {
    logger.info('No rows to clean up. AiCostLog is consistent.');
    return;
  }

  const byProvider = new Map<string, number>();
  for (const row of wronglyFlaggedRows) {
    byProvider.set(row.provider, (byProvider.get(row.provider) ?? 0) + 1);
  }
  logger.info(
    `Found ${wronglyFlaggedRows.length} row(s) with isLocal=true whose provider is not in the local set.`
  );
  logger.info('Breakdown by provider:');
  for (const [provider, count] of Array.from(byProvider.entries()).sort((a, b) => b[1] - a[1])) {
    logger.info(`  ${provider.padEnd(24)} ${count}`);
  }

  if (dryRun) {
    logger.info('--dry-run set: not writing.');
    return;
  }

  if (!skipConfirm) {
    const ok = await confirm(`Flip isLocal=false on ${wronglyFlaggedRows.length} row(s)? [y/N] `);
    if (!ok) {
      logger.info('Aborted.');
      return;
    }
  }

  const result = await prisma.aiCostLog.updateMany({
    where: {
      isLocal: true,
      ...(localSlugList.length > 0 ? { provider: { notIn: localSlugList } } : {}),
    },
    data: { isLocal: false },
  });
  logger.info(`Updated ${result.count} row(s).`);
}

main()
  .catch((err) => {
    logger.error('cleanup-cost-log-islocal failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
