/**
 * App provider-eligibility registration.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body).
 *
 * Auto-wired: `ensureWired()` in `lib/orchestration/llm/provider-eligibility.ts`
 * calls this once, lazily, on the first provider resolution — so a fork
 * registers without wiring anything, and it applies to EVERY consumer rather
 * than only whichever module happened to import the resolver.
 *
 * Register a rule constraining which providers **Sunrise may pick on a
 * caller's behalf**. By default it attaches up to three other configured
 * providers as automatic fallbacks whenever an agent has no explicit list,
 * picks the primary itself whenever an agent leaves that field blank, takes the
 * `chat` task default (and inherits whatever provider that model names) for a
 * workflow step with no `modelOverride`, a keyword-enrichment run and an
 * unpinned retroactive review, and walks the audio matrix in order when no
 * speech-to-text default is pinned. Convenient on a single-tenant install, and
 * a leak on a shared one, because the prompt — or the document, or the voice
 * recording — can reach a provider nobody approved.
 *
 * Example — an org may only use the providers it has approved:
 *
 *   import { registerProviderEligibility } from '@/lib/orchestration/llm/provider-eligibility';
 *   import { approvedProviderSlugs } from '@/lib/app/billing';
 *
 *   export function registerAppProviderEligibility(): void {
 *     registerProviderEligibility(async (candidates) => {
 *       const approved = await approvedProviderSlugs();
 *       return candidates.filter((slug) => approved.has(slug));
 *     });
 *   }
 *
 * Filter EVERY source by default, as above. A rule that answers for only some
 * of them is fail-open for the rest, and `'primary'` is the one that matters
 * most: a provider-less agent (the system-seeded pattern-advisor, quiz-master,
 * mcp-system and model-auditor all ship that way) would otherwise reach
 * whichever provider sorts first while the policy looks enforced.
 *
 * To relax a source, do it deliberately — and note this is an ALTERNATIVE body
 * for the same function, not a second call. Registering twice throws, and
 * because the failure is cached, every later provider resolution fails with it:
 *
 *   export function registerAppProviderEligibility(): void {
 *     registerProviderEligibility(async (candidates, ctx) => {
 *       // Honour an operator's own fallback list, still constrain what
 *       // Sunrise picks on its own.
 *       if (ctx.source === 'explicit') return candidates;
 *       const approved = await approvedProviderSlugs();
 *       return candidates.filter((slug) => approved.has(slug));
 *     });
 *   }
 *
 * Before you write one:
 *
 *  - **It runs on the request hot path**, up to TWICE per binding resolution —
 *    once for the auto-picked primary and once for the fallback list — once
 *    more per workflow step, per keyword-enrichment run and per retroactive
 *    review, and once per audio matrix row walked. Cache whatever you look up;
 *    do not query per call.
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
 *    auto-picked primary, both fallback lists, the task-default model's
 *    provider on the three paths that resolve one directly, and an audio matrix
 *    row reached by order all go through your rule. An explicit
 *    `agent.provider`, an explicit step or review `modelOverride`, a pinned
 *    audio default and the `EVALUATION_*` env vars do not. Enforce those at
 *    write time — do not offer a provider the org has not approved.
 *  - **`source: 'primary'` means every path where Sunrise chose**, not only the
 *    agent one: a blank `agent.provider`, a workflow step with no
 *    `modelOverride`, a keyword-enrichment run, an unpinned retroactive review
 *    and an audio matrix row all arrive under it. So a rule you already wrote
 *    reaches every one of them without an edit — which is why they reuse the
 *    value rather than adding a fourth your rule would not answer for. Use
 *    `ctx.task` to tell them apart: audio arrives as `'audio'`, the rest as
 *    `'chat'`.
 *  - **Everything Sunrise chooses is fail-closed.** If your rule permits
 *    nothing for `source: 'primary'`, the request raises
 *    `NoEligibleProviderError`, a workflow step fails with a non-retriable
 *    `provider_not_permitted`, an enrichment run and a retroactive review are
 *    refused with a 403, and speech-to-text reports itself unavailable — rather
 *    than any of them using a provider you did not approve. A rule that throws
 *    therefore costs provider-less agents an outage, stops workflow steps and
 *    turns off voice input, not a silent bypass — deliberate, but know it
 *    before putting a network call in here.
 *
 * Full guide: `.context/orchestration/llm-providers.md`
 */
export function registerAppProviderEligibility(): void | Promise<void> {
  // No app provider-eligibility rule by default: every configured provider is
  // eligible everywhere, which is Sunrise's single-tenant behaviour.
}
