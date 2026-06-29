/**
 * App agent field registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it after
 * release, so your edits here merge cleanly on upgrade (the stable contract is
 * this file's export, not its body). Treat it like the landing page: a starting
 * point you're expected to modify.
 *
 * When your fork adds a column to the `AiAgent` model, declare its cross-cutting
 * policy here as one descriptor and the platform derives every surface from it
 * (versioning, snapshot, diff). You never edit a platform list, so a field add is
 * one edit on your side and conflicts with upstream on zero files.
 *
 *   import type { AgentFieldDescriptor } from '@/lib/orchestration/agents/agent-field-registry';
 *
 *   export const appAgentFields: AgentFieldDescriptor[] = [
 *     {
 *       name: 'interviewerStyle',           // your AiAgent column
 *       kind: 'scalar',
 *       versioned: true,
 *       ui: { label: 'Interviewer style', tab: 'Instructions', order: 500 },
 *     },
 *   ];
 *
 * Tip: for the same compile-time exhaustiveness the platform gets, you can
 * `satisfies Record<YourConfigField, …>` against your fork's
 * `Prisma.AiAgentScalarFieldEnum` keys — see `CORE_SCALAR_FIELDS` in
 * `lib/orchestration/agents/agent-field-registry.ts`.
 *
 * Boundary-clean: type-only import, so this stays within the `lib/app/**`
 * framework-agnostic boundary.
 *
 * Full guide: .context/orchestration/agent-fields.md
 */
import type { AgentFieldDescriptor } from '@/lib/orchestration/agents/agent-field-registry';

/** Fork-owned agent field descriptors. Empty by default. */
export const appAgentFields: AgentFieldDescriptor[] = [];
