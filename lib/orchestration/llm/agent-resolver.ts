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
import {
  resolveEligibleProviders,
  hasProviderEligibilityResolver,
} from '@/lib/orchestration/llm/provider-eligibility';
import { registerAppProviderEligibility } from '@/lib/app/providers';
import type { TaskType } from '@/types/orchestration';

// Auto-wire the fork's eligibility rule at module load — the same arrangement
// every other `lib/app/*` seam uses, so a fork registers without touching core.
//
// Guarded on "is anything already registered?", which is the only shape that
// satisfies all three requirements at once:
//
//  - A re-evaluation of THIS module (Next dev HMR) must not wedge the app.
//    `registerProviderEligibility` rejects a second, different resolver and the
//    documented style is an inline arrow — a fresh reference every call — so an
//    unguarded re-run would abort the module and kill every chat turn until a
//    full restart.
//  - A registration made ELSEWHERE must never be discarded. This module is not
//    loaded at boot; it is first evaluated by a request. A fork registering
//    from `initApp()` (awaited in `instrumentation.ts` at process start, and
//    the natural home for one-time startup work) would have its rule wiped by
//    the first chat request — silently turning a restriction seam into the
//    identity function with every provider permitted again.
//  - Two registrations inside ONE wiring pass must still throw, because that is
//    a fork genuinely registering twice and one of the rules would not run.
//
// An earlier version called `resetProviderEligibility()` unconditionally here.
// It fixed the first requirement by breaking the second — a fail-open on a
// restriction control, which is the worse of the two by a distance. It also
// cited `resetAppDriftProbes()` as precedent, which does not hold:
// `scripts/db/check-drift.ts` registers without resetting.
if (!hasProviderEligibilityResolver()) {
  registerAppProviderEligibility();
}

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
      // Deliberately covers BOTH ways of getting here. A rule that denies
      // everything and a rule that THREW are indistinguishable at this point —
      // `resolveEligibleProviders` fails closed to `[]` either way — so telling
      // the operator to "widen the rule" would be wrong advice half the time,
      // to someone whose rule is correct and whose policy backend is down. The
      // logger.error emitted at the failure carries which one it was.
      throw new NoEligibleProviderError(
        `No configured provider is permitted for this request. ${candidates.length} ` +
          `provider(s) are active and reachable (${candidates.map((c) => c.slug).join(', ')}), ` +
          'but the rule registered via registerProviderEligibility() in lib/app/providers.ts ' +
          'permitted none of them — either by policy, or because it threw and a rule that ' +
          'cannot be evaluated denies. Check the logs for a rule failure first; if there is ' +
          'none, widen the rule or give the agent an explicit provider.'
      );
    }
  }

  const providerSlug = providerSet ? agent.provider : eligibleCandidates[0].slug;
  const model = modelSet ? agent.model : await getDefaultModelForTask(task);

  // System fallbacks: every other reachable candidate, capped. Skipped
  // if the agent already has an explicit fallback list.
  const explicitFallbacks = agent.fallbackProviders ?? [];
  const usingExplicit = explicitFallbacks.length > 0;
  // Drawn from the FULL candidate list, not from `eligibleCandidates`. The two
  // are filtered independently and with different `source` values, so a rule
  // stricter about the silent fill than about the primary keeps working —
  // narrowing this by the primary's answer would silently conflate them.
  const proposed = usingExplicit
    ? explicitFallbacks
    : candidates.map((c) => c.slug).filter((slug) => slug !== providerSlug);

  const permitted = await resolveEligibleProviders(proposed, {
    task,
    source: usingExplicit ? 'explicit' : 'system',
    primarySlug: providerSlug,
  });

  // Cap AFTER filtering, and only the system fill — an explicit list is the
  // operator's and is not truncated.
  //
  // Order is the whole point: capping first would let ineligible providers
  // occupy slots and silently shrink the list. With five providers and a rule
  // permitting only the fourth and fifth, cap-then-filter yields ONE fallback
  // where two were permitted, reachable and within budget. The three slots
  // must count providers that can actually be used.
  const fallbacks = usingExplicit ? [...permitted] : permitted.slice(0, SYSTEM_FALLBACK_LIMIT);

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
