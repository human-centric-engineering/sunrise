/**
 * Agent provider/model resolver
 *
 * Lets `AiAgent.provider` / `AiAgent.model` be empty strings, in which
 * case the values are looked up dynamically from the system defaults
 * (`AiOrchestrationSettings.defaultModels`) and the first active
 * `AiProviderConfig` row whose `apiKeyEnvVar` is set in `process.env`
 * (or whose row is `isLocal`).
 *
 * This is the seam that lets system-seeded agents (pattern-advisor,
 * quiz-master, mcp-system, model-auditor) start life provider-agnostic
 * — they ship with empty strings and inherit whatever the operator
 * configures via the setup wizard.
 *
 * Explicit values always win: a user-created agent that picked a
 * specific provider/model in the agent form keeps its choice. The
 * fallback only kicks in when both fields are empty strings.
 */

import type { AiAgent, AiProviderConfig } from '@/types/prisma';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { isApiKeyEnvVarSet } from '@/lib/orchestration/llm/provider-manager';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import { resolveEligibleProviders } from '@/lib/orchestration/llm/provider-eligibility';
import { registerAppProviderEligibility } from '@/lib/app/providers';
import type { TaskType } from '@/types/orchestration';

// Auto-wire the fork's eligibility rule, once, at module load — the same
// arrangement every other `lib/app/*` seam uses, so a fork registers without
// touching core. A throw here aborts the module rather than resolving bindings
// against a rule that did not finish registering.
registerAppProviderEligibility();

/** Number of system fallbacks to attach when an agent has no explicit provider. */
const SYSTEM_FALLBACK_LIMIT = 3;

export interface ResolvedAgentBinding {
  providerSlug: string;
  model: string;
  fallbacks: string[];
}

/** Pick of the AiAgent fields the resolver actually reads. */
export type ResolvableAgent = Pick<AiAgent, 'provider' | 'model' | 'fallbackProviders'>;

/**
 * Thrown when an agent has no explicit provider/model and no active
 * provider in `AiProviderConfig` is reachable (no env key set, no
 * loopback row). The setup wizard's first-run gate should prevent
 * this in normal usage.
 */
export class NoProviderConfiguredError extends ProviderError {
  constructor(message = 'No provider is configured') {
    super(message, { code: 'no_provider_configured', retriable: false });
    this.name = 'NoProviderConfiguredError';
  }
}

/**
 * Thrown when providers ARE configured and reachable, but the app's
 * eligibility rule permits none of them for this request.
 *
 * Deliberately distinct from {@link NoProviderConfiguredError}. That one means
 * "nothing is set up" and sends an operator to the setup wizard; this one means
 * "everything is set up and your policy allows none of it", which is a
 * different fix in a different place. Reporting the first for the second would
 * send someone to re-add providers that are already there.
 */
export class NoEligibleProviderError extends ProviderError {
  constructor(message = 'No configured provider is eligible for this request') {
    super(message, { code: 'no_eligible_provider', retriable: false });
    this.name = 'NoEligibleProviderError';
  }
}

/**
 * Resolve the provider slug, model id, and fallback list to use for a
 * chat turn or workflow step. Empty `agent.provider`/`agent.model` are
 * filled from system defaults; explicit values pass through unchanged.
 */
export async function resolveAgentProviderAndModel(
  agent: ResolvableAgent,
  task: TaskType = 'chat'
): Promise<ResolvedAgentBinding> {
  const providerSet = typeof agent.provider === 'string' && agent.provider.length > 0;
  const modelSet = typeof agent.model === 'string' && agent.model.length > 0;

  if (providerSet && modelSet) {
    // This early return is a second exit, not a shortcut through the one
    // below — a fully-configured agent never reaches the candidates block. Its
    // explicit fallback list has to be filtered HERE or the seam would cover
    // only agents that left a field blank, which is the minority.
    return {
      providerSlug: agent.provider,
      model: agent.model,
      fallbacks: [
        ...(await resolveEligibleProviders(agent.fallbackProviders ?? [], {
          task,
          source: 'explicit',
          primarySlug: agent.provider,
        })),
      ],
    };
  }

  const candidates = await pickActiveProviderCandidates();
  if (candidates.length === 0) {
    throw new NoProviderConfiguredError(
      'No active LLM provider is configured. Run the setup wizard to add one.'
    );
  }

  // The auto-picked primary goes through the eligibility rule; an EXPLICIT
  // `agent.provider` does not. The difference is whose decision it is: here
  // Sunrise is choosing on the caller's behalf, so choosing something their
  // policy forbids is our error, not theirs. An explicit choice is enforced at
  // write time instead — see provider-eligibility.ts for why.
  let eligibleCandidates = candidates;
  if (!providerSet) {
    const permitted = await resolveEligibleProviders(
      candidates.map((c) => c.slug),
      { task, source: 'primary', primarySlug: null }
    );
    const permittedSet = new Set(permitted);
    eligibleCandidates = candidates.filter((c) => permittedSet.has(c.slug));
    if (eligibleCandidates.length === 0) {
      // Fails loudly rather than falling back to an ineligible provider. The
      // message names the fix, because the state it describes ("configured but
      // not permitted") is invisible from the provider list alone.
      throw new NoEligibleProviderError(
        `No configured provider is permitted for this request. ${candidates.length} ` +
          `provider(s) are active and reachable (${candidates.map((c) => c.slug).join(', ')}), ` +
          'but the rule registered via registerProviderEligibility() in lib/app/providers.ts ' +
          'allows none of them. Widen that rule, or give the agent an explicit provider.'
      );
    }
  }

  const providerSlug = providerSet ? agent.provider : eligibleCandidates[0].slug;
  const model = modelSet ? agent.model : await getDefaultModelForTask(task);

  // System fallbacks: every other reachable candidate, capped. Skipped
  // if the agent already has an explicit fallback list.
  const explicitFallbacks = agent.fallbackProviders ?? [];
  const proposed =
    explicitFallbacks.length > 0
      ? explicitFallbacks
      : // Drawn from the full candidate list, not from `eligibleCandidates`.
        // The two are filtered independently and with different `source`
        // values, so a rule that is stricter about the silent fill than about
        // the primary keeps working — narrowing this by the primary's answer
        // would silently conflate them.
        candidates
          .map((c) => c.slug)
          .filter((slug) => slug !== providerSlug)
          .slice(0, SYSTEM_FALLBACK_LIMIT);
  // Filter AFTER the cap, not before. Capping first then filtering would let an
  // ineligible provider consume one of the three slots and silently shrink the
  // list; this way the cap counts only providers that can actually be used.
  const fallbacks = [
    ...(await resolveEligibleProviders(proposed, {
      task,
      source: explicitFallbacks.length > 0 ? 'explicit' : 'system',
      primarySlug: providerSlug,
    })),
  ];

  logger.debug('resolveAgentProviderAndModel: filled empty agent binding', {
    agentProvider: agent.provider,
    agentModel: agent.model,
    resolvedProvider: providerSlug,
    resolvedModel: model,
    fallbackCount: fallbacks.length,
  });

  return { providerSlug, model, fallbacks };
}

/**
 * Find every active provider whose `apiKeyEnvVar` is set in
 * `process.env` (or whose row is `isLocal` and therefore needs no
 * key). Ordered by `createdAt` so the first user-configured provider
 * wins on ties.
 */
async function pickActiveProviderCandidates(): Promise<AiProviderConfig[]> {
  const rows = await prisma.aiProviderConfig.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.filter((row) => row.isLocal || isApiKeyEnvVarSet(row.apiKeyEnvVar));
}
