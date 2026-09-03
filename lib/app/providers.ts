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
 *       // An explicit list is a recorded operator choice; the system fill is
 *       // not. A fork may reasonably be stricter about the latter.
 *       return ctx.source === 'system'
 *         ? candidates.filter((slug) => approved.has(slug))
 *         : candidates;
 *     });
 *   }
 *
 * Before you write one:
 *
 *  - **It runs on the request hot path**, once per binding resolution. Cache
 *    whatever you look up; do not query per call.
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
export function registerAppProviderEligibility(): void {
  // No app provider-eligibility rule by default: every configured provider is
  // an eligible fallback, which is Sunrise's single-tenant behaviour.
}
