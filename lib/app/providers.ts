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
 * Three things to know before you write one:
 *
 *  - **It runs on the request hot path**, once per binding resolution. Cache
 *    whatever you look up; do not query per call.
 *  - **Throwing denies every fallback**, loudly logged — a restriction that
 *    cannot be evaluated must not be read as permission. The request keeps its
 *    primary provider, so a bug here degrades rather than breaks.
 *  - **It filters fallbacks only, never the primary.** Returning `[]` does not
 *    stop an agent using its configured provider. If you need to constrain the
 *    primary too, that decision is open — see the note in
 *    `provider-eligibility.ts` and raise it rather than assuming this covers it.
 *
 * Full guide: `.context/orchestration/llm-providers.md`
 */
export function registerAppProviderEligibility(): void {
  // No app provider-eligibility rule by default: every configured provider is
  // an eligible fallback, which is Sunrise's single-tenant behaviour.
}
