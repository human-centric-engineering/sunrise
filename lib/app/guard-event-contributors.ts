/**
 * App guard-event contributor registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: the chat handler calls this once before it first emits a guard
 * event (server route-handler runtime). Add
 * `registerGuardEventContributor(key, contributor)` calls to OBSERVE an inline
 * guard (input / output / citation) firing and react — notify, log, escalate —
 * keyed on the turn's `(contextType, contextId, agentId, userId,
 * conversationId)`.
 *
 * Fire-and-forget: a contributor runs after the guard acts and never delays or
 * breaks the turn; a throwing or rejecting contributor is logged and ignored.
 * Empty registry = inert / no-op. Observation only — it cannot change detection
 * or the guard's action (use the guard-floor seam to raise a guard's strictness).
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/orchestration/chat.md
 */
export function initAppGuardEventContributors(): void {
  // No app guard-event contributors by default.
}
