/**
 * Seed: backfill an explicit "Initial configuration" version for every agent
 * that has none.
 *
 * The agent version timeline is point-in-time: each `AiAgentVersion.snapshot`
 * holds the config as of that version, and "restore to vN" reproduces the agent
 * as it was at vN. The create route now writes a `v1` ("Initial configuration")
 * for every new agent, but agents that already existed — the seeded system
 * agents above, plus anything created before create-time versioning — have no
 * such row, so their factory config isn't a first-class, restorable entry.
 *
 * This unit closes that gap idempotently: it finds every agent with zero version
 * rows and captures its CURRENT config (the best available proxy for "original")
 * as `v1`. Agents that already have history are skipped, so re-running is a
 * no-op. Runs after the agent-seeding units (005, 006, 010, 016–018) so the
 * agents exist by the time it scans.
 */

import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import {
  INITIAL_VERSION_SUMMARY,
  asSnapshotJson,
  buildAgentSnapshot,
} from '@/lib/orchestration/agents/agent-versioning';

const unit: SeedUnit = {
  name: '020-agent-initial-versions',
  async run({ prisma, logger }) {
    logger.info('🕰️  Backfilling initial agent versions...');

    // Fallback creator for any agent whose own `createdBy` is null (the version
    // column is nullable, but a non-null service-account id keeps the audit
    // join populated).
    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });

    const agents = await prisma.aiAgent.findMany({
      where: { versions: { none: {} } },
      include: {
        grantedTags: { select: { tagId: true } },
        grantedDocuments: { select: { documentId: true } },
      },
    });

    if (agents.length === 0) {
      logger.info('  ✓ every agent already has version history');
      return;
    }

    for (const agent of agents) {
      const { grantedTags, grantedDocuments, ...row } = agent;
      await prisma.aiAgentVersion.create({
        data: {
          agentId: agent.id,
          version: 1,
          snapshot: asSnapshotJson(
            buildAgentSnapshot(row, {
              grantedTagIds: grantedTags.map((g) => g.tagId),
              grantedDocumentIds: grantedDocuments.map((g) => g.documentId),
            })
          ),
          changeSummary: INITIAL_VERSION_SUMMARY,
          createdBy: agent.createdBy ?? admin?.id ?? null,
        },
      });
    }

    logger.info(`  ✓ backfilled v1 for ${agents.length} agent(s)`);
  },
};

export default unit;
