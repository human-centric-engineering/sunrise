/**
 * Orchestration setup state probe
 *
 * Reads the minimum DB state needed to decide whether the orchestration
 * dashboard should auto-open the setup wizard. On a fresh install with
 * no providers configured, the dashboard banner uses this to surface a
 * "Run setup wizard" call to action.
 *
 * Server-only by virtue of the `@/lib/db/client` import — must not be
 * transitively reachable from a client component.
 */

import { requestPrincipal } from '@/lib/auth/admin-page-viewer';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { parseStoredDefaults } from '@/lib/orchestration/settings';
import { isMultiTenant, runAsOrg } from '@/lib/tenancy/context';

export interface SetupState {
  /** True if at least one `AiProviderConfig` row exists. */
  hasProvider: boolean;
  /**
   * True if at least one user-created (`isSystem: false`) agent exists.
   * Excludes system seeds (pattern-advisor, quiz-master, mcp-system,
   * model-auditor) because they're present on every install and don't
   * reflect operator setup progress.
   */
  hasAgent: boolean;
  /** True if `AiOrchestrationSettings.defaultModels.chat` is a non-empty string. */
  hasDefaultChatModel: boolean;
}

/**
 * Count the viewer's org's user-created agents, inside the org they entered.
 *
 * `AiAgent` is tenant-owned, and a page renders outside the guards that enter
 * an org for an API route, so at `multi` an unscoped count is refused by the
 * data layer (#1295). With no org entered at `multi` there is no org to ask
 * about: `null`, which the caller reads as "has agents" so the banner stays
 * quiet. At `single` an unscoped count resolves to the install org.
 */
async function countOrgAgents(): Promise<number | null> {
  const count = () => prisma.aiAgent.count({ where: { isSystem: false } });
  const entry = await requestPrincipal();
  const orgId = entry?.principal.orgId;
  if (orgId) {
    return runAsOrg(orgId, count, {
      source: entry.support ? 'support' : 'session',
      ...(entry.support ? { support: entry.support } : {}),
    });
  }
  if (isMultiTenant()) return null;
  return count();
}

/**
 * Build a `SetupState` snapshot for the orchestration dashboard. Failures
 * fall back to the safest "everything-set-up" state so the wizard banner
 * doesn't pop up on a transient DB blip.
 *
 * The provider and settings reads are platform-wide config and need no org;
 * the agent count runs in the org the viewer entered (see `countOrgAgents`).
 */
export async function getSetupState(): Promise<SetupState> {
  try {
    const [providerCount, agentCount, settingsRow] = await Promise.all([
      prisma.aiProviderConfig.count(),
      countOrgAgents(),
      prisma.aiOrchestrationSettings.findUnique({ where: { slug: 'global' } }),
    ]);

    const stored = settingsRow ? parseStoredDefaults(settingsRow.defaultModels) : {};
    const chat = typeof stored.chat === 'string' ? stored.chat : '';

    return {
      hasProvider: providerCount > 0,
      hasAgent: agentCount === null || agentCount > 0,
      hasDefaultChatModel: chat.length > 0,
    };
  } catch (err) {
    logger.warn('getSetupState: probe failed, assuming setup complete', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { hasProvider: true, hasAgent: true, hasDefaultChatModel: true };
  }
}
