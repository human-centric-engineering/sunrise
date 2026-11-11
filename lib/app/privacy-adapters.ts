/**
 * App privacy adapter registrations (§127).
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Filling it is not a
 * divergence. Treat it like the other `lib/app/*` seams.
 *
 * Auto-wired: the privacy adapter registry runs this once, lazily, before its
 * first read, after Sunrise's own adapters are in. Register from here, not
 * from `initApp()`, which would fill a registry the privacy stage never reads.
 *
 * The privacy layer finds personal data in what Sunrise sends to external LLM
 * providers and replaces it with placeholders. Every stage is an adapter, and
 * Sunrise's local, free implementation is only the default. Add your own — a
 * hosted service your contract requires, a domain rule pack, a stricter
 * policy — without editing a Sunrise file:
 *
 * @example
 * ```ts
 * import {
 *   registerPrivacyDetector,
 *   registerPrivacyPolicyResolver,
 * } from '@/lib/privacy/adapters/registry';
 * import { policyNumberDetector } from '@/lib/app/privacy/policy-numbers';
 * import { presidioDetector } from '@/lib/app/privacy/presidio';
 *
 * export function initAppPrivacyAdapters(): void {
 *   // Runs alongside core's detectors; its spans are merged with theirs.
 *   registerPrivacyDetector(policyNumberDetector());
 *   // A service that must not be skipped, with a tight timeout.
 *   registerPrivacyDetector(presidioDetector(), { required: true, timeoutMs: 400 });
 *   // Resolvers can only make policy stricter.
 *   registerPrivacyPolicyResolver({
 *     id: 'acme.hr-agents',
 *     resolve: ({ agentId }) => (isHrAgent(agentId) ? { mode: 'redact' } : {}),
 *   });
 * }
 * ```
 *
 * Three rules worth knowing before you start:
 *
 * - **Offsets are JavaScript string indices** (UTF-16 code units). A service
 *   written in another language usually counts code points, and the two
 *   disagree after an emoji: convert in your adapter, or it masks the wrong
 *   text and sends the real value.
 * - **Turning a core detector off takes `{ replace: 'core.<id>' }`**, and the
 *   admin page shows it was replaced. There is no other way.
 * - **If this function throws, the layer refuses every LLM call**, even with
 *   the mode `off`, rather than falling back to core alone: a required
 *   detector or a stricter policy you registered would otherwise be missing
 *   without anyone noticing.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/privacy/llm-privacy-layer.md
 */
export function initAppPrivacyAdapters(): void {
  // No app privacy adapters by default.
}
