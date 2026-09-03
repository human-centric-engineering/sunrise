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
 * It filters every provider choice Sunrise makes ON THE CALLER'S BEHALF:
 *
 *  - the **auto-picked primary**, when the agent leaves `provider` blank and
 *    the resolver chooses `candidates[0]`;
 *  - the **system fallback fill**, the up-to-three providers nobody asked for;
 *  - the agent's own **explicit `fallbackProviders`** list.
 *
 * It does NOT filter an **explicit `agent.provider`**. That is an operator's
 * recorded decision, and silently rerouting it would make an agent answer from
 * a provider its own configuration does not name — harder to diagnose than a
 * refusal, and a worse failure than the one being prevented.
 *
 * The intended enforcement for that case is at the point of CHOOSING: a
 * per-org install should not offer a provider the org has not approved, so the
 * value never reaches the row. That is a write-time concern with a UX question
 * attached (hide it, or show it disabled with a reason?), so it belongs with
 * the per-org work rather than here. This seam is the runtime backstop, which
 * is the layer that still holds when a policy changes UNDER agents that were
 * configured while it was permitted — the case write-time validation cannot
 * reach.
 *
 * ## Failure behaviour: a broken resolver denies, it does not permit
 *
 * A registered resolver that throws is logged as an error and treated as
 * "nothing is eligible". The alternative — treating a failure as "everything is
 * eligible" — would turn a fork's bug into a silent policy bypass, which is the
 * one outcome a restriction seam must never produce.
 *
 * What that costs depends on what was being filtered, and the difference is
 * worth knowing before putting a network call in a rule:
 *
 *  - An agent that NAMES its provider keeps working and loses only its
 *    fallbacks. Degraded.
 *  - An agent that does not is left with nothing the policy approved, so the
 *    request raises `NoEligibleProviderError`. Broken, deliberately: there is
 *    no safe default to fall back to when every remaining option is one the
 *    policy did not permit.
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
   * What is being filtered. A fork may reasonably answer differently for each:
   *
   *  - `'primary'` — Sunrise is CHOOSING the provider, because the agent left
   *    the field blank. Nobody's intent is being overridden, so this is the
   *    strictest case to constrain and the safest.
   *  - `'explicit'` — the agent's own `fallbackProviders`, a recorded operator
   *    choice.
   *  - `'system'` — the automatic fill nobody asked for.
   */
  source: 'primary' | 'explicit' | 'system';
  /**
   * The provider already chosen as primary — never itself a candidate here.
   * `null` when `source` is `'primary'`, because that is the choice being made.
   */
  primarySlug: string | null;
}

/**
 * Returns the subset of `candidates` that may be used.
 *
 * Return the input to allow everything. Return `[]` to deny them all — which
 * for `source: 'primary'` means the request fails with
 * `NoEligibleProviderError` rather than silently using a disallowed provider.
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
 * Filter `candidates` to those the caller may use.
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
    logger.error('provider eligibility resolver threw; denying every candidate', {
      task: context.task,
      primarySlug: context.primarySlug,
      source: context.source,
      candidateCount: candidates.length,
      error: error instanceof Error ? error.message : String(error),
      fix: "A restriction that cannot be evaluated must not be treated as permission. With source 'primary' this fails the request (NoEligibleProviderError); otherwise the request keeps its provider and runs without fallbacks.",
    });
    return [];
  }
}
