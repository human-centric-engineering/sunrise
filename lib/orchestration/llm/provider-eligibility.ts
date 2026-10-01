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
 * **Inert at `single` until a fork registers something.** At `single`, with no
 * resolver registered, `resolveEligibleProviders` returns its input unchanged,
 * so a single-tenant install behaves byte-for-byte as it did before this file
 * existed — the programme's "inert at `single`, literally" principle. There is
 * no dormant second code path: the same call runs either way, and by default
 * it is identity.
 *
 * **At `multi`, core has a rule of its own** (§120 t-742,
 * `lib/orchestration/llm/org-provider-policy.ts`): the install org may use
 * every provider, and every other org only those a platform admin approved it
 * for — none until one is granted — within the jurisdictions it is held to.
 * It runs first, and a fork's rule is handed only what it permitted, so a fork
 * rule can narrow core's answer and never widen it. The org is read from tenant
 * context; `ProviderEligibilityContext` deliberately does not carry it.
 *
 * ## What it does and does not constrain
 *
 * Wherever it is consulted it filters every
 * choice Sunrise makes ON THE CALLER'S BEHALF, and nothing an operator chose.
 * That line — *whose decision was it* — is the whole rule; the list below is
 * only where the rule has been applied so far.
 *
 * **That list is hand-derived and was short on all three occasions it was
 * checked**, which is why it is not the boundary. The boundary is
 * {@link assertProviderCallPermitted}, the call-time gate at the bottom of this
 * file: the provider manager's Proxy runs it before every vendor call, so a
 * site missing from this list chooses less well but cannot send a call the rule
 * refuses (§120 t-741). `.context/orchestration/llm-providers.md` carries the
 * per-path table and the gate. Note the limit on all of it, recorded 2026-09-07
 * and written down in that file: the guarantee binds Sunrise core, not a fork's
 * own code, which can construct a provider directly. The eight choices
 * selection covers:
 *
 *  - the **auto-picked primary**, when the agent leaves `provider` blank and
 *    the resolver chooses `candidates[0]`;
 *  - the **system fallback fill**, the up-to-three providers nobody asked for;
 *  - the agent's own **explicit `fallbackProviders`** list;
 *  - a **workflow step with no `modelOverride`** (`llm-runner.ts`), which falls
 *    back to the `chat` task default and then to whatever provider that model
 *    names;
 *  - **knowledge keyword enrichment** (`keyword-enricher.ts`), same shape and
 *    no override to begin with;
 *  - the **retroactive-review judge** (`executions/[id]/review/route.ts`) when
 *    neither a request `modelOverride` nor `EVALUATION_JUDGE_MODEL` answered;
 *  - **audio transcription's matrix fallback** (`tryAudioRow`), the row chosen
 *    by matrix order when no operator default is pinned or the pinned one is
 *    unreachable;
 *  - the **embedding fallback chain** (`knowledge/embedder.ts`), walked whenever
 *    the operator's `activeEmbeddingModelId` pin is absent or no longer
 *    resolves. Every arm is a provider row with a real slug: the bare
 *    `OPENAI_API_KEY` arm and its reserved `env:openai` slug were retired in
 *    t-740, so a rule naming `env:openai` now matches nothing.
 *
 * The last five are a SECOND chokepoint. They do not pass through
 * `resolveAgentProviderAndModel` at all — they read the model registry, or the
 * audio matrix, directly — so they consult this module themselves via
 * `isProviderEligible`, and each refuses in its own vocabulary: an
 * `ExecutorError` (`provider_not_permitted`), a `ProviderNotPermittedError`, a
 * 403, and — in the audio loop and the embedding chain — a skip that tries the
 * next candidate, which is what every other guard in those functions already
 * does.
 *
 * At selection it does NOT filter an **explicit `agent.provider`**, an explicit step
 * `modelOverride`, a review request's own `modelOverride`, or the
 * `EVALUATION_DEFAULT_PROVIDER` / `_MODEL` / `EVALUATION_JUDGE_MODEL`
 * environment variables. Each is an operator's
 * recorded decision, and silently rerouting one would make a request answer
 * from a provider its own configuration does not name — harder to diagnose than
 * a refusal, and a worse failure than the one being prevented. The call-time
 * gate refuses them instead, as `source: 'explicit'`, when the rule says no.
 * The one operator choice asked at selection is the pinned AUDIO default, as
 * `'explicit'`: that pin is documented to fall through to the matrix when it is
 * unusable, and a refused pin is unusable, so asking first lets a permitted row
 * serve the request instead of the gate failing it.
 * `.context/orchestration/llm-providers.md` carries the per-path coverage
 * table, which says where Sunrise chooses rather than where data can go.
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
 * @see lib/orchestration/engine/llm-runner.ts — the workflow-step chokepoint
 * @see lib/orchestration/knowledge/keyword-enricher.ts — the ingestion chokepoint
 * @see lib/orchestration/llm/provider-manager.ts — `tryAudioRow`, the audio chokepoint
 * @see lib/orchestration/knowledge/embedder.ts — `resolveProvider`, the embedding chokepoint
 */

import { logger } from '@/lib/logging';
import { applyOrgProviderPolicy } from '@/lib/orchestration/llm/org-provider-policy';
import { PROVIDER_NOT_PERMITTED, ProviderError } from '@/lib/orchestration/llm/provider';
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';
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
   *  - `'primary'` — Sunrise is CHOOSING the provider, because no explicit
   *    choice was recorded anywhere: an agent with a blank `provider`, a
   *    workflow step with no `modelOverride`, keyword enrichment (which has no
   *    override to give), an unpinned retroactive-review judge, or an audio
   *    matrix row reached by order rather than by an operator's pin. Nobody's intent is being overridden, so this is the
   *    strictest case to constrain and the safest.
   *
   *    The four non-resolver paths deliberately REUSE this value rather than
   *    introducing a fourth. An unanswered `source` fails open (see
   *    `ProviderEligibilityResolver` below), so a new value would mean every
   *    rule already written in a fork silently does not cover the paths it was
   *    added for — the opposite of what widening coverage is supposed to do.
   *    Reusing `'primary'` extends an existing rule to them for free, and it is
   *    honest: the category is the same one.
   *  - `'explicit'` — a recorded operator choice. At selection that is the
   *    agent's own `fallbackProviders`. At the call-time gate
   *    ({@link assertProviderCallPermitted}) it is also the operator's choice of
   *    PRIMARY: an explicit `agent.provider`, a step's `modelOverride`, a pinned
   *    audio or embedding default, an `EVALUATION_*` env var, an admin testing a
   *    named provider. Selection never filters those, because rerouting a
   *    recorded choice is worse than refusing it; the gate refuses them when the
   *    rule says no, which is the difference.
   *  - `'system'` — the automatic fill nobody asked for.
   */
  source: 'primary' | 'explicit' | 'system';
  /**
   * The provider already chosen as primary. `null` exactly when `source` is
   * `'primary'`, because that is the choice being made; for `'explicit'` and
   * `'system'` it is always set. At the call-time gate, a call to the primary
   * itself under one of those sources (an explicit `agent.provider`, or an
   * unrecorded primary-position call asked as `'explicit'`) carries its own
   * slug here; an unrecorded fallback carries the real primary's.
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
 * `lib/app/*` registrar has one consumer and never met this; this seam has six
 * (the resolver, the form's preview, `llm-runner.ts`, `keyword-enricher.ts`,
 * the retroactive-review route and `provider-manager.ts`), which is what made
 * the old shape untenable.
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
 * Filter `candidates` to those the caller may use: core's org policy first
 * (identity at `single`), then the fork's rule, if one is registered, over
 * what survived.
 *
 * At `single` with no registered resolver this returns `candidates` unchanged
 * — the identity default that keeps single-tenant behaviour byte-identical.
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

  // Nothing to decide, and both rules may be a policy lookup. Every chat turn
  // of a fully-configured agent with no fallback list reaches here with an
  // empty list, so without this the rules run — and a throwing one logs — for
  // an answer that can only be `[]`.
  if (candidates.length === 0) return candidates;

  // Core's own rule first (§120 t-742): identity at `single`; at `multi` the
  // install org is open and every other org is held to its approved set. The
  // fork's rule is handed only what survived, so it can narrow and never widen.
  let permitted: readonly string[];
  try {
    permitted = await applyOrgProviderPolicy(candidates);
  } catch (error) {
    logger.error('org provider policy could not be read; denying every candidate', {
      task: context.task,
      source: context.source,
      orgId: getTenantContext()?.orgId ?? null,
      error: error instanceof Error ? error.message : String(error),
      fix: "The org's provider policy (Org.settings.providers) could not be loaded. Until it can, no provider is eligible for the org — a policy that cannot be read must not be read as permission.",
    });
    return [];
  }

  if (!appResolver || permitted.length === 0) return permitted;

  try {
    const eligible = await appResolver(permitted, context);
    const allowed = new Set(eligible);
    // Intersect rather than trust: a resolver cannot introduce a provider the
    // resolver never considered, nor reorder them. Order is load-bearing —
    // fallbacks are tried in sequence — so it comes from `candidates`.
    return permitted.filter((slug) => allowed.has(slug));
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

/**
 * Whether one already-chosen provider may be used.
 *
 * The single-candidate form of `resolveEligibleProviders`, for the callers that
 * have no list to filter: the model registry named exactly one provider and
 * there is no second choice to fall back to. It answers a yes/no question with
 * the same rule, the same fail-closed semantics, and the same logging — a
 * throwing or failed-to-register rule denies here too.
 *
 * Deliberately does NOT throw. Each caller refuses in its own vocabulary — an
 * `ExecutorError` for a workflow step, `ProviderNotPermittedError` for an
 * ingestion run, a 403 for the retroactive-review route, and a plain `null` in
 * the audio loop, where every other guard already denies that way and the
 * caller is written to try the next row. Those failures are caught, reported
 * and remedied in different places; a shared throw here would force all of them
 * through one error type that fits none.
 *
 * Call this where SUNRISE chose the provider. A provider reached through an
 * operator's recorded choice — an explicit `agent.provider`, a step's
 * `modelOverride`, an `EVALUATION_*` env var — is left to the call-time gate,
 * which refuses rather than reroutes. The exception is a choice whose own
 * contract is to fall through when unusable (the pinned audio default, asked
 * as `'explicit'` in `tryAudioRow`).
 */
export async function isProviderEligible(
  slug: string,
  context: ProviderEligibilityContext
): Promise<boolean> {
  const eligible = await resolveEligibleProviders([slug], context);
  return eligible.length > 0;
}

// ---------------------------------------------------------------------------
// The call-time gate (§120 t-741)
// ---------------------------------------------------------------------------

/**
 * Where the provider for a resolved binding came from, carried from the
 * resolver to the call so the gate can tell the rule.
 *
 * Two answers because a binding holds two kinds of provider: its primary
 * (auto-picked, or the operator's explicit `agent.provider`) and its fallbacks
 * (the agent's own list, or the system fill). Hand it to
 * `getProviderWithFallbacks`, or turn it into one call's context with
 * {@link primaryCallContext} / {@link fallbackCallContext}.
 */
export interface BindingProvenance {
  task: TaskType;
  primary: 'primary' | 'explicit';
  fallbacks: 'explicit' | 'system';
}

/** The gate context for a call to a binding's primary. */
export function primaryCallContext(
  provenance: BindingProvenance | undefined
): ProviderEligibilityContext | undefined {
  if (!provenance) return undefined;
  return { task: provenance.task, source: provenance.primary, primarySlug: null };
}

/** The gate context for a call to one of a binding's fallbacks. */
export function fallbackCallContext(
  provenance: BindingProvenance | undefined,
  primarySlug: string
): ProviderEligibilityContext | undefined {
  if (!provenance) return undefined;
  return { task: provenance.task, source: provenance.fallbacks, primarySlug };
}

/**
 * Thrown by the call-time gate when the eligibility rule refuses a vendor call.
 *
 * A `ProviderError` with code `provider_not_permitted`, which `isRequestFault`
 * counts: a policy answer is the same for every attempt and every provider
 * position, so nothing retries it, fails over from it, or records it against
 * the provider's circuit breaker. Failing over would be the reroute the gate
 * exists not to do, and a breaker failure would let one org's policy take a
 * healthy provider offline for every other org.
 *
 * The message carries no slug, because executors forward `ProviderError`
 * messages to clients. The slug is on `providerSlug`, and in the log line the
 * gate writes before throwing.
 */
export class ProviderCallRefusedError extends ProviderError {
  readonly providerSlug: string;
  /**
   * Why: `'policy'` when the rule refused the provider, `'no_org_scope'` when
   * at `multi` there was no org to ask it for. A caller that tells someone what
   * to change needs the difference — choosing another provider fixes the
   * first and never the second.
   */
  readonly reason: 'policy' | 'no_org_scope';
  constructor(providerSlug: string, reason: 'policy' | 'no_org_scope' = 'policy') {
    super(
      reason === 'policy'
        ? 'The provider for this call is not permitted by this deployment’s provider policy'
        : 'This call ran outside any organisation scope, so no provider policy could permit it',
      { code: PROVIDER_NOT_PERMITTED, retriable: false }
    );
    this.name = 'ProviderCallRefusedError';
    this.providerSlug = providerSlug;
    this.reason = reason;
  }
}

/**
 * Keep the context's contract: `primarySlug` is `null` only for `'primary'`.
 * A call-time context for the primary position has no other primary to name,
 * so for `'explicit'` (an operator's named provider) it is the provider itself.
 * A fork rule written against the selection-time contract may dereference it
 * for any non-`'primary'` source, and a `null` there would refuse, or throw and
 * refuse, a call the rule means to allow.
 */
function withPrimarySlug(
  context: ProviderEligibilityContext,
  slug: string
): ProviderEligibilityContext {
  if (context.source === 'primary' || context.primarySlug !== null) return context;
  return { ...context, primarySlug: slug };
}

/**
 * A call whose caller recorded no provenance, made in a FALLBACK position:
 * `getProviderWithFallbacks` without a binding provenance, reaching past the
 * primary. Distinct from `undefined` (an unrecorded call in the primary
 * position) because a fallback is asked as a fallback — as `'explicit'` or
 * `'system'`, with the real primary — which a lone call cannot be.
 */
export interface UnrecordedFallback {
  unrecordedFallbackOf: string;
}

/** Everything the call-time gate can know about where a provider came from. */
export type CallOrigin = ProviderEligibilityContext | UnrecordedFallback | undefined;

/**
 * The sources an unrecorded call is asked under. An unrecorded call is one
 * provider fetched by name, which is a call in the PRIMARY position, and a
 * primary is either Sunrise's pick (`'primary'`) or an operator's (`'explicit'`).
 * `'system'` is not asked: it describes a fill drawn alongside a different
 * primary, and no honest `primarySlug` exists for it here — giving the provider
 * as its own primary contradicts the contract a rule is written to, that the
 * fill excludes the primary.
 */
const PRIMARY_POSITION_SOURCES: readonly ProviderEligibilityContext['source'][] = [
  'primary',
  'explicit',
];

/**
 * The sources an unrecorded FALLBACK is asked under: the two a fallback can
 * be, the agent's own list or the system fill, each with the real primary.
 * Without `'system'` here a rule that refuses a provider only as the silent
 * fill would be skipped whenever a caller left provenance out.
 */
const FALLBACK_POSITION_SOURCES: readonly ProviderEligibilityContext['source'][] = [
  'explicit',
  'system',
];

/**
 * Refuse a vendor call the eligibility rule does not permit.
 *
 * The provider manager's Proxy calls this before every vendor-reaching method
 * (`chat`, `chatStream`, `embed`, `embedMany`, `transcribe`, `transcribeStream`),
 * once per CALL — never once per cached instance, so a rule whose answer changes
 * takes effect on the next call rather than after the 5-minute instance cache
 * expires. The selection sites still filter so that Sunrise chooses well; this
 * is what makes the policy complete for every call core makes through the
 * manager, including the ones no selection site saw. It is not a boundary
 * around a fork's own code, which can construct a provider directly (decided
 * 2026-09-07).
 *
 * `slug` is the BUILT row's slug, never the string a caller asked
 * `getProvider` for: a lookup that resolved a different row than the caller
 * checked is refused for that row, not waved through on the caller's check.
 *
 * **No provenance is not permission.** A call whose caller recorded no
 * `context` is permitted only if the rule permits it both as Sunrise's pick
 * (`'primary'`) and as an operator's (`'explicit'`) — the two things a lone
 * provider fetched by name can be. Whichever way a fork's rule treats those
 * two, an unrecorded call gets the stricter answer, and recording provenance
 * can only ever relax a refusal. (`'system'` is the fill drawn beside some
 * other primary, which an unrecorded call is not; see
 * `PRIMARY_POSITION_SOURCES`.)
 *
 * **The org.** The rule runs in the caller's async context, so a rule reads
 * `getTenantContext()` itself. A call with no org to answer for is decided
 * here, before the rule: at `single` it is the install org, as
 * `requireTenantContext` answers. At `multi`, a call stack that entered no org
 * scope, or entered `runAsSystem` (which bypasses row isolation and names no
 * org), is refused — there is no org whose policy could permit it. At `multi`
 * the request paths, jobs and `scripts/seed-embeddings.ts` all enter an org
 * before they reach a vendor; a path that does not is already a tenancy bug.
 *
 * Not called for `listModels` and `testConnection`. They send no prompt or
 * document text, and providers are platform-admin configuration: gating them
 * by the admin's active org would stop a platform admin testing a provider
 * before granting it to anyone.
 *
 * @throws ProviderCallRefusedError when the rule refuses, or when at `multi`
 *   there is no org to evaluate it for.
 */
export async function assertProviderCallPermitted(
  slug: string,
  origin: CallOrigin,
  task: TaskType
): Promise<void> {
  const context = origin && 'source' in origin ? origin : undefined;
  const fallbackOf =
    origin && 'unrecordedFallbackOf' in origin ? origin.unrecordedFallbackOf : null;
  const tenant = getTenantContext();
  if (isMultiTenant() && (tenant === null || tenant.orgId === null)) {
    logger.error('Refusing a provider call made outside any org scope', {
      providerSlug: slug,
      task,
      tenantSource: tenant?.source ?? null,
      fix: 'At TENANCY_MODE=multi every vendor call must run inside runAsOrg / forEachOrg, so the provider policy of the org it acts for can be applied. runAsSystem names no org.',
    });
    throw new ProviderCallRefusedError(slug, 'no_org_scope');
  }

  // The contexts the rule is asked, exactly as it sees them: one for a recorded
  // call and, for an unrecorded one, every source its position can have.
  const asked = context
    ? [withPrimarySlug(context, slug)]
    : fallbackOf !== null
      ? FALLBACK_POSITION_SOURCES.map((source) => ({ task, source, primarySlug: fallbackOf }))
      : PRIMARY_POSITION_SOURCES.map((source) =>
          withPrimarySlug({ task, source, primarySlug: null }, slug)
        );
  for (const askedContext of asked) {
    if (await isProviderEligible(slug, askedContext)) continue;
    logger.error('Refusing a provider call the eligibility rule does not permit', {
      providerSlug: slug,
      recorded: context !== undefined,
      // What the rule was given, so the refusal can be reproduced from the log.
      task: askedContext.task,
      source: askedContext.source,
      primarySlug: askedContext.primarySlug,
      orgId: tenant?.orgId ?? null,
      fix: 'The rule registered via registerProviderEligibility() in lib/app/llm-providers.ts did not permit this provider for this call — by policy, or because it threw. A call with no recorded provenance must be permitted as both an auto-picked and an operator-chosen primary.',
    });
    throw new ProviderCallRefusedError(slug);
  }
}
