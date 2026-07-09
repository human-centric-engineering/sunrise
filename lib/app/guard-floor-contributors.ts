/**
 * App guard-floor contributor registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: the chat handler calls this once before it first collects guard
 * floors (server route-handler runtime). Add
 * `registerGuardFloorContributor(key, contributor)` calls to enforce a per-turn
 * **minimum** mode for the three inline guards (input / output / citation),
 * keyed on the turn's `(contextType, contextId, agentId)` — e.g. a governance
 * policy that says "this surface must at least warn on output".
 *
 * Raise-only: a floor can only make a guard STRICTER for the turn, never looser
 * (`none` < `log_only` < `warn_and_continue` < `block`). A contributor that
 * throws is logged and ignored. Empty registry = today's guard-mode resolution,
 * byte-for-byte.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/orchestration/chat.md
 */
export function initAppGuardFloorContributors(): void {
  // No app guard-floor contributors by default.
}
