/**
 * App knowledge access-contributor registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: `resolveAgentDocumentAccess()` calls this once before it first
 * consults contributors (server route-handler runtime). Add
 * `registerAgentAccessContributor(key, contributor)` calls to widen a
 * **restricted** agent's searchable document set from a relationship your layer
 * owns (module membership, team ACL, per-tenant grant) — composed **live** at
 * resolve time, without materialising grants onto the per-agent pivot or
 * editing the core resolver.
 *
 * Widen-only: contributors run only in the `restricted` branch (a `full` agent
 * is never touched) and can only ADD documents. A contributor that throws is
 * logged and ignored. When the data your contributor reads changes, call
 * `invalidateAgentAccess(agentId)` for the affected agents (the same contract
 * direct grants follow) so the cached decision is re-composed.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/orchestration/knowledge.md
 */
export function initAppKnowledgeAccessContributors(): void {
  // No app knowledge access contributors by default.
}
