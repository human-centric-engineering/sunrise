import type { SeedUnit } from '@/prisma/runner';
import { reconcilePlatformAgents } from '@/lib/orchestration/agents/reconcile-platform-agents';
import { listActiveOrgIds } from '@/lib/tenancy/context';

/**
 * Materialise the platform agents in every active org (§116 t-724).
 *
 * Replaces the eight seeds that each wrote one family of Sunrise's agents as
 * install-org rows (005 pattern advisor, 006 quiz master, 008 MCP identity,
 * 010 provider auditors, 016 and 018 judges, 017 case generator, 020 clean-up
 * assistant). The definitions now live in code
 * (`lib/orchestration/agents/platform-agents.ts`) and this unit runs the same
 * reconcile org creation and the maintenance tick run, once per org, so a
 * fresh install and an upgraded one end in the same state.
 *
 * Last among the agent-related units on purpose: the capabilities the agents
 * bind to are seeded by 005, 010, 011–014 and 019. A capability with no row
 * yet is skipped with a warning, not an error. The reconcile also writes the
 * patterns knowledge, and with it the tag the pattern advisor and quiz master
 * are granted, into an org one of whose agents declares that tag (t-726): the
 * install org, in core (t-733).
 *
 * `hashInputs` names every file a definition or the reconcile's behaviour
 * lives in, the patterns knowledge included, so editing one re-runs this unit
 * on the next seed. The
 * maintenance job would catch the change anyway (it compares each org's
 * stored registry digest); this makes a deploy that seeds apply it at once.
 */
const unit: SeedUnit = {
  name: '021-platform-agents',
  hashInputs: [
    '../../lib/orchestration/agents/platform-agents.ts',
    '../../lib/orchestration/agents/reconcile-platform-agents.ts',
    '../../lib/orchestration/agents/agent-field-registry.ts',
    '../../lib/orchestration/agents/platform-agent-definitions/case-generator.ts',
    '../../lib/orchestration/agents/platform-agent-definitions/cleanup-agent.ts',
    '../../lib/orchestration/agents/platform-agent-definitions/evaluation-judges.ts',
    '../../lib/orchestration/agents/platform-agent-definitions/mcp-system.ts',
    '../../lib/orchestration/agents/platform-agent-definitions/model-auditor.ts',
    '../../lib/orchestration/agents/platform-agent-definitions/pattern-advisor.ts',
    '../../lib/orchestration/agents/platform-agent-definitions/quiz-master.ts',
    '../../lib/orchestration/agents/platform-agent-definitions/rag-evaluation-judges.ts',
    '../../lib/app/platform-agents.ts',
    '../../lib/orchestration/knowledge/seeder.ts',
    '../../lib/orchestration/knowledge/patterns-knowledge.ts',
    './data/chunks/chunks.json',
  ],
  async run({ prisma, logger }) {
    logger.info('🤖 Reconciling platform agents in every org...');
    for (const orgId of await listActiveOrgIds(prisma)) {
      // One org's failure does not stop the rest, nor fail the deploy: its
      // marker is left unwritten, so the platformAgents maintenance job
      // reconciles it again — the same answer `createOrg` gives.
      let result: Awaited<ReturnType<typeof reconcilePlatformAgents>>;
      try {
        result = await reconcilePlatformAgents(orgId, { db: prisma, log: logger });
      } catch (err) {
        logger.error(`  ✗ ${orgId}: platform agents not reconciled; the maintenance job retries`, {
          orgId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      logger.info(
        `  ✓ ${orgId}: ${result.created.length} created, ${result.updated.length} updated, ` +
          `${result.unchanged.length} unchanged, ${result.deactivated.length} deactivated` +
          (result.refused.length > 0 ? `, ${result.refused.length} refused` : '') +
          (result.knowledge ? `; patterns knowledge ${result.knowledge}` : '')
      );
    }
  },
};

export default unit;
