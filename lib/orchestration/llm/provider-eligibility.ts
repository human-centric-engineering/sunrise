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
 * Wherever it is consulted it filters every
 * choice Sunrise makes ON THE CALLER'S BEHALF. That scope is the whole story
 * and is smaller than it sounds: a provider resolved by any other route is
 * unfiltered — a workflow step's model resolution in `llm-runner.ts`, knowledge
 * keyword enrichment, the retroactive-review judge, audio transcription's
 * matrix fallback, and the embedding provider chain in `knowledge/embedder.ts`,
 * which does not go through the provider manager at all.
 *
 * **That list is hand-derived and has been short on all three occasions it has
 * been checked**, so treat it as illustrative, not exhaustive.
 * `.context/orchestration/llm-providers.md` carries the current version, plus
 * the Proxy every manager-built provider passes through and the four routes
 * that bypass it. Do not read this seam as a whole-tree guarantee. The three
 * choices it does cover:
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
 * @see lib/app/llm-providers.ts — the fork-owned registration point
 * @see lib/orchestration/llm/agent-resolver.ts — the runtime consumer
 * @see lib/orchestration/prefetch-helpers.ts — the agent form's preview
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
   * The provider already chosen as primary. `null` when `source` is
   * `'primary'`, because that is the choice being made.
   *
   * NOT guaranteed absent from `candidates`. The system fill excludes it, but
   * an agent's own `fallbackProviders` list is passed through as the operator
   * wrote it — so on `source: 'explicit'` a caller may legitimately see its own
   * primary in the list. A rule that appends `primarySlug` on the assumption it
   * is missing would produce a duplicate, and a failover straight back to the
   * provider that just failed.
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
 *
 * **Answer for every `source`, or the denial is partial.** The three are
 * filtered independently, and the fallback lists are drawn from the full
 * candidate set rather than from what survived the primary filter — so a rule
 * that denies a provider for `'primary'` and waves everything through for
 * `'system'` still lets that provider serve the request the moment the primary
 * errors and failover runs. That independence is deliberate (a fork may want to
 * be stricter about the silent fill than about an operator's own list), and it
 * makes an unanswered source fail OPEN. Filter every source unless you are
 * relaxing one on purpose.
 */
export type ProviderEligibilityResolver = (
  candidates: readonly string[],
  context: ProviderEligibilityContext
) => readonly string[] | Promise<readonly string[]>;

let appResolver: ProviderEligibilityResolver | null = null;

/**
 * The in-flight or completed auto-wire. Also the latch: non-null means wiring
 * has been attempted, so the scaffold runs exactly once per module instance.
 */
let wiring: Promise<void> | null = null;

/**
 * Run the fork's registration once, lazily, from the module that owns the state.
 *
 * **Why here and not at a consumer's module scope.** It used to be a
 * module-load side effect of `agent-resolver.ts`. That made registration depend
 * on WHO IMPORTED WHAT: `prefetch-helpers.ts` calls
 * `resolveEligibleProviders` and never imports the resolver, so the agent
 * form's preview ran the filter with nothing registered and silently returned
 * everything — the exact drift the filter was added to close. Every other
 * `lib/app/*` registrar has one consumer and never met this; this seam already
 * has two, and t-658 adds a third.
 *
 * Putting the wiring beside the state removes the question entirely: any
 * caller of `resolveEligibleProviders` gets the rule, whatever imported it.
 *
 * **Why a dynamic import.** A fork's `lib/app/llm-providers.ts` imports
 * `registerProviderEligibility` from this module, so a static import back would
 * be a cycle. `instrumentation.ts` uses the same `await import()` shape for the
 * boot seam, and the fork-init guard's import detection recognises it.
 *
 * **A throwing scaffold rejects every call.** The rejection is cached with the
 * promise, so a fork whose registration is broken fails loudly and repeatedly
 * rather than quietly running unfiltered — a restriction that cannot be
 * established must not be read as permission.
 */
function ensureWired(): Promise<void> {
  wiring ??= (async () => {
    const { registerAppProviderEligibility } = await import('@/lib/app/llm-providers');
    // AWAITED. Dropping this promise was a fail-open: a fork whose registrar
    // loads its policy first (`const approved = await approvedProviderSlugs()`
    // — which is exactly what this seam's own "cache whatever you look up"
    // guidance steers them toward) resolves `ensureWired` at that first inner
    // `await`, before `registerProviderEligibility` has run. Every resolve in
    // that window then saw `appResolver === null` and returned the candidates
    // UNFILTERED, silently, on the first request after every cold start.
    //
    // `instrumentation.ts` awaits `initApp()` for the same reason; this was the
    // only registrar call site in the family that dropped the promise.
    await registerAppProviderEligibility();
  })();
  return wiring;
}

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

/**
 * Clear the registered resolver.
 *
 * Clears the registered rule AND the auto-wire latch, so the next call to
 * `resolveEligibleProviders` re-runs `lib/app/llm-providers.ts` from scratch.
 *
 * For tests, and available for a dev-server hot-reload hook — a fork editing
 * its rule needs the edit picked up, which a latch alone would prevent. Same
 * reason `lib/db/drift-probes.ts` ships `resetAppDriftProbes()`.
 *
 * **Nothing in core calls this at runtime today**, and that fact is load-bearing
 * for what is deliberately NOT guarded here: a reset landing while an async
 * registrar is mid-flight could let the superseded wire register afterwards.
 * A generation counter closes that, and was written and then removed — the
 * scenario needs a runtime reset, no runtime reset exists, and no failing test
 * could be constructed for it. Unfalsifiable concurrency logic inside a
 * restriction control is a worse trade than the race it prevents.
 *
 * If anything ever calls this outside a test — a real hot-reload hook, an
 * admin "reload policy" action — the race becomes reachable and the counter
 * should come back WITH a test that fails without it.
 */
export function resetProviderEligibility(): void {
  appResolver = null;
  // The latch as well. Without this a reset would leave `wiring` resolved, so
  // the scaffold would never re-run and a test (or a dev-server edit) would
  // silently keep resolving with no rule at all.
  wiring = null;
}

/**
 * Whether an app resolver is registered. **Tests only.**
 *
 * Deliberately synchronous, so it cannot trigger the lazy auto-wire — which
 * means before the first `resolveEligibleProviders` it answers `false` on an
 * install that DOES have a rule. Fine for a test asserting the shipped default;
 * actively misleading as a health check, which would report "no policy" on a
 * correctly configured fork.
 */
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
  // Before the null check, not after: the whole point is that the rule is
  // registered no matter which module reached us.
  //
  // A throwing REGISTRAR is caught here rather than propagating raw. It still
  // fails closed — deny everything — but as `[]` it reaches the same reporting
  // the rest of this seam uses. Left to propagate, it surfaced as generic
  // "Something Went Wrong" on the chat path and as "No provider configured"
  // from the agent_call executor: the very message this branch calls actively
  // wrong for a policy failure. And because `wiring` latches the rejection,
  // every later resolution in the process repeated it.
  try {
    await ensureWired();
  } catch (error) {
    logger.error('provider eligibility scaffold failed to register; denying every candidate', {
      task: context.task,
      source: context.source,
      error: error instanceof Error ? error.message : String(error),
      fix: 'lib/app/llm-providers.ts threw while registering. Until it is fixed, no provider is eligible — a restriction that cannot be ESTABLISHED must not be read as permission either.',
    });
    return [];
  }

  if (!appResolver) return candidates;
  // Nothing to decide, and a fork's rule may be a policy lookup. Every chat
  // turn of a fully-configured agent with no fallback list reaches here with an
  // empty list, so without this the rule runs — and a throwing one logs — for
  // an answer that can only be `[]`.
  if (candidates.length === 0) return candidates;

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
