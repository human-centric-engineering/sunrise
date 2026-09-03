/**
 * App provider-eligibility registration.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body).
 *
 * Auto-wired: `lib/orchestration/llm/agent-resolver.ts` calls this once, before
 * it resolves any binding, so a fork registers without wiring anything.
 *
 * Register a rule constraining which providers an agent may **fall back to**.
 * By default Sunrise attaches up to three other configured providers as
 * automatic fallbacks whenever an agent has no explicit list — convenient on a
 * single-tenant install, and a leak on a shared one, because the prompt can
 * reach a provider nobody approved.
 *
 * Example — an org may only fall back within the providers it has approved:
 *
 *   import { registerProviderEligibility } from '@/lib/orchestration/llm/provider-eligibility';
 *   import { approvedProviderSlugs } from '@/lib/app/billing';
 *
 *   export function registerAppProviderEligibility(): void {
 *     registerProviderEligibility(async (candidates, ctx) => {
 *       const approved = await approvedProviderSlugs();
 *       // Filter EVERY source by default. A rule that answers for only some of
 *       // them is fail-open for the rest — and `'primary'` is the one that
 *       // matters most, because a provider-less agent (the system-seeded
 *       // pattern-advisor, quiz-master, mcp-system and model-auditor all ship
 *       // that way) would otherwise send its prompts to whichever provider
 *       // happens to sort first, while the policy looks enforced.
 *       return candidates.filter((slug) => approved.has(slug));
 *     });
 *
 * Relax deliberately, never by omission — e.g. to honour an operator's own
 * fallback list while still constraining what Sunrise picks:
 *
 *     registerProviderEligibility(async (candidates, ctx) => {
 *       if (ctx.source === 'explicit') return candidates;
 *       const approved = await approvedProviderSlugs();
 *       return candidates.filter((slug) => approved.has(slug));
 *     });
 *   }
 *
 * Before you write one:
 *
 *  - **It runs on the request hot path**, up to TWICE per binding resolution —
 *    once for the auto-picked primary and once for the fallback list. Cache
 *    whatever you look up; do not query per call.
 *  - **If you load policy before registering, RETURN the promise.** This
 *    function may be `async` and its caller awaits it. What must not happen is
 *    a floated promise —
 *    `void loadPolicy().then((p) => registerProviderEligibility(...))` —
 *    because resolution continues before the rule exists, and the first
 *    requests after every cold start run UNFILTERED. Register synchronously,
 *    or make this `async` and `await` your loading.
 *  - **Throwing denies, it never permits**, and is logged loudly — a
 *    restriction that cannot be evaluated must not be read as permission.
 *  - **It filters what Sunrise chooses, not what an operator chose.** The
 *    auto-picked primary and both fallback lists go through your rule; an
 *    explicit `agent.provider` does not. Enforce that one at write time — do
 *    not offer a provider the org has not approved.
 *  - **The primary is fail-closed.** If your rule permits nothing for
 *    `source: 'primary'`, the request raises `NoEligibleProviderError` rather
 *    than using a provider you did not approve. A rule that throws therefore
 *    costs provider-less agents an outage, not a silent bypass — deliberate,
 *    but know it before putting a network call in here.
 *
 * Full guide: `.context/orchestration/llm-providers.md`
 */
export function registerAppProviderEligibility(): void | Promise<void> {
  // No app provider-eligibility rule by default: every configured provider is
  // an eligible fallback, which is Sunrise's single-tenant behaviour.
}
