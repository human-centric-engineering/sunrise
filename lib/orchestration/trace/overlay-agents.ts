/**
 * Overlay agent metadata onto `agent_call` trace entries.
 *
 * Pure view-time enrichment: walks the trace and, for every entry
 * whose step type is `agent_call`, looks up the step's `agentSlug`
 * in the workflow snapshot, then resolves that slug to an `{ id,
 * name }` via the caller-supplied agent map. The resolved record is
 * attached to the entry as `entry.agent` so the trace viewer can
 * render a chip with a link to the agent edit page.
 *
 * Why view-time (not engine-time):
 *   - The agent's display name can change after a workflow has run.
 *     Looking it up at render time means the trace stays readable
 *     even when an admin renames the agent.
 *   - It also covers historical traces written before this field
 *     existed — no migration / re-engine required.
 *
 * Rules:
 *   - Only `stepType === 'agent_call'` entries are eligible.
 *   - Snapshot is treated as `unknown` and shape-checked defensively
 *     (mirrors `overlay-descriptions.ts`).
 *   - Snapshot steps with no `config.agentSlug` are skipped.
 *   - Slugs that don't resolve in the agent map are skipped — better
 *     to leave the entry alone than to inject a broken chip.
 *
 * Pure function — no DB, no I/O. The route does the batched lookup
 * once per execution-detail load and passes the map in.
 */

import type { ExecutionTraceEntry } from '@/types/orchestration';

export interface AgentMeta {
  id: string;
  slug: string;
  name: string;
}

export interface OverlayAgentsInput {
  trace: readonly ExecutionTraceEntry[];
  /** Workflow snapshot from `AiWorkflowVersion.snapshot`. */
  snapshot: unknown;
  /** Map keyed by agentSlug → resolved agent record. */
  agentsBySlug: ReadonlyMap<string, AgentMeta>;
}

export function overlayAgentInfo(input: OverlayAgentsInput): ExecutionTraceEntry[] {
  const { trace, snapshot, agentsBySlug } = input;
  const traceArray = [...trace];
  if (agentsBySlug.size === 0) return traceArray;
  if (!snapshot || typeof snapshot !== 'object') return traceArray;

  const steps = (snapshot as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return traceArray;

  // Build `stepId → agentSlug` once per call. Only includes
  // `agent_call` steps that carry a non-empty string slug — anything
  // else can't resolve to an agent anyway.
  const slugByStepId = new Map<string, string>();
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    if ((step as { type?: unknown }).type !== 'agent_call') continue;
    const id = (step as { id?: unknown }).id;
    const config = (step as { config?: unknown }).config;
    if (typeof id !== 'string' || !config || typeof config !== 'object') continue;
    const slug = (config as { agentSlug?: unknown }).agentSlug;
    if (typeof slug === 'string' && slug.length > 0) {
      slugByStepId.set(id, slug);
    }
  }
  if (slugByStepId.size === 0) return traceArray;

  return traceArray.map((entry) => {
    if (entry.stepType !== 'agent_call') return entry;
    if (entry.agent) return entry; // already enriched
    const slug = slugByStepId.get(entry.stepId);
    if (!slug) return entry;
    const meta = agentsBySlug.get(slug);
    if (!meta) return entry;
    return { ...entry, agent: meta };
  });
}

/**
 * Collect every `agentSlug` referenced by `agent_call` steps in a
 * workflow snapshot. Used by the API loader to build the IN clause
 * for the batched agent lookup.
 *
 * Returns a sorted, deduplicated array — sorted because callers
 * cache by the resulting array shape and stable order keeps the
 * cache hot.
 */
export function collectAgentSlugsFromSnapshot(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const steps = (snapshot as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const set = new Set<string>();
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    if ((step as { type?: unknown }).type !== 'agent_call') continue;
    const config = (step as { config?: unknown }).config;
    if (!config || typeof config !== 'object') continue;
    const slug = (config as { agentSlug?: unknown }).agentSlug;
    if (typeof slug === 'string' && slug.length > 0) {
      set.add(slug);
    }
  }
  return [...set].sort();
}
