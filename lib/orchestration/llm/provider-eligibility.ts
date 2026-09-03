/**
 * Provider eligibility seam.
 *
 * Constrains which providers an agent's request may **fall back to**. It exists
 * because the resolver's convenience is, at `multi`, a leak: when an agent has
 * no explicit fallback list, `resolveAgentProviderAndModel` attaches up to three
 * other configured providers automatically, and nobody asked for any of them. On
 * a single-tenant install that is a helpful default. On a shared one it means an
 * org's prompts can reach a provider that org never approved — which is the
 * multi-tenancy design record's Q15
 * (`.context/architecture/multi-tenancy-design.md`): *fallback only within
 * `resolveEligibleProviders(ctx)`; default = today's behaviour at `single`,
 * deny-by-default at `multi`.*
 *
 * **Inert until a fork registers something.** With no resolver registered,
 * `resolveEligibleProviders` returns its input unchanged, so a single-tenant
 * install behaves byte-for-byte as it did before this file existed — the
 * programme's "inert at `single`, literally" principle. There is no dormant
 * second code path: the same call runs either way, and by default it is
 * identity.
 *
 * ## What it does and does not constrain
 *
 * It filters **fallbacks** — both the system-attached ones and an agent's own
 * explicit `fallbackProviders` list. It deliberately does NOT filter the
 * **primary** provider, and that boundary is worth stating because it is not
 * obviously right:
 *
 *  - An explicit `agent.provider` is an operator's recorded decision. Silently
 *    rerouting it would make an agent answer from a provider its configuration
 *    does not name, which is harder to diagnose than a refusal.
 *  - The auto-picked primary (`candidates[0]`, when the agent leaves the field
 *    empty) is arguably as unrequested as a system fallback, and a per-org deny
 *    policy will eventually have to say something about it.
 *
 * Q15 is scoped to auto-*fallback*, so that is what this ships. Deciding the
 * primary's policy belongs with the work that introduces per-org rules, where
 * there is an org to reason about — it is recorded there rather than settled
 * quietly here.
 *
 * ## Failure behaviour: a broken resolver denies, it does not permit
 *
 * A registered resolver that throws is logged as an error and treated as
 * "nothing is eligible", so the request keeps its primary provider and loses
 * its fallbacks. The alternative — treating a failure as "everything is
 * eligible" — would turn a fork's bug into a silent policy bypass, which is the
 * one outcome a restriction seam must never produce. Losing fallbacks degrades
 * a request; ignoring the policy defeats it.
 *
 * @see lib/app/providers.ts — the fork-owned registration point
 * @see lib/orchestration/llm/agent-resolver.ts — the only consumer
 */

import { logger } from '@/lib/logging';
import type { TaskType } from '@/types/orchestration';

/**
 * What the resolver knows about the request whose fallbacks are being filtered.
 *
 * Deliberately no agent id. `ResolvableAgent` is `Pick<AiAgent, 'provider' |
 * 'model' | 'fallbackProviders'>` and one caller
 * (`evaluations/complete-session.ts`) resolves a synthetic binding with no
 * agent row behind it at all — so an id is not available to pass, and widening
 * that input type to carry a diagnostic field would be the wrong trade. The
 * per-org policy this seam is built for keys on the org in context, not on the
 * agent, so nothing here needs it.
 */
export interface ProviderEligibilityContext {
  /** The task the binding is being resolved for. */
  task: TaskType;
  /**
   * Whether these candidates are the agent's own `fallbackProviders` or the
   * system's automatic fill. A fork may reasonably treat them differently: an
   * explicit list is a recorded operator choice, the system fill is not.
   */
  source: 'explicit' | 'system';
  /** The provider chosen as primary — never itself a candidate here. */
  primarySlug: string;
}

/**
 * Returns the subset of `candidates` that may be used as fallbacks.
 *
 * Return the input to allow everything. Return `[]` to deny fallbacks entirely.
 * Anything not in `candidates` is ignored — a resolver widens nothing.
 */
export type ProviderEligibilityResolver = (
  candidates: readonly string[],
  context: ProviderEligibilityContext
) => readonly string[] | Promise<readonly string[]>;

let appResolver: ProviderEligibilityResolver | null = null;

/**
 * Register the app's eligibility rule. One resolver, registered once.
 *
 * Re-registering the same function reference is a no-op; a different one throws
 * rather than silently replacing, because two rules in a tree means one of them
 * is not running and there is no way to tell which from the outside. Same
 * bargain as the other registry seams: changing your registration means
 * restarting the dev server.
 *
 * @throws if a different resolver is already registered.
 */
export function registerProviderEligibility(resolver: ProviderEligibilityResolver): void {
  if (appResolver && appResolver !== resolver) {
    throw new Error(
      'registerProviderEligibility: a different resolver is already registered. ' +
        'Provider eligibility is a single rule — compose your conditions inside one ' +
        'function rather than registering twice.'
    );
  }
  appResolver = resolver;
}

/** Test-only: drop the registered resolver. */
export function __resetProviderEligibility(): void {
  appResolver = null;
}

/** Whether an app resolver is registered. Exposed for tests and diagnostics. */
export function hasProviderEligibilityResolver(): boolean {
  return appResolver !== null;
}

/**
 * Filter `candidates` to those eligible as fallbacks.
 *
 * With no registered resolver this returns `candidates` unchanged — the
 * identity default that keeps single-tenant behaviour byte-identical.
 */
export async function resolveEligibleProviders(
  candidates: readonly string[],
  context: ProviderEligibilityContext
): Promise<readonly string[]> {
  if (!appResolver) return candidates;

  try {
    const eligible = await appResolver(candidates, context);
    const allowed = new Set(eligible);
    // Intersect rather than trust: a resolver cannot introduce a provider the
    // resolver never considered, nor reorder them. Order is load-bearing —
    // fallbacks are tried in sequence — so it comes from `candidates`.
    return candidates.filter((slug) => allowed.has(slug));
  } catch (error) {
    logger.error('provider eligibility resolver threw; denying all fallbacks', {
      task: context.task,
      primarySlug: context.primarySlug,
      source: context.source,
      candidateCount: candidates.length,
      error: error instanceof Error ? error.message : String(error),
      fix: 'A restriction that cannot be evaluated must not be treated as permission. The request keeps its primary provider and runs without fallbacks until this is fixed.',
    });
    return [];
  }
}
