import { describe, it, expect } from 'vitest';

import {
  collectAgentSlugsFromSnapshot,
  overlayAgentInfo,
  type AgentMeta,
} from '@/lib/orchestration/trace/overlay-agents';
import type { ExecutionTraceEntry } from '@/types/orchestration';

/**
 * Unit tests for the agent-info trace overlay. Two exported helpers:
 *   - `collectAgentSlugsFromSnapshot` — extracts agentSlugs from
 *     agent_call steps for batched DB lookup
 *   - `overlayAgentInfo` — attaches `{ id, slug, name }` to matching
 *     trace entries
 *
 * Together they let the execution-detail loader render the agent
 * chip without storing the name on the trace at execution time.
 */

function makeEntry(
  overrides: Partial<ExecutionTraceEntry> & { stepId: string; stepType: string }
): ExecutionTraceEntry {
  return {
    stepId: overrides.stepId,
    stepType: overrides.stepType,
    label: overrides.label ?? overrides.stepId,
    status: overrides.status ?? 'completed',
    output: overrides.output ?? null,
    tokensUsed: overrides.tokensUsed ?? 0,
    costUsd: overrides.costUsd ?? 0,
    startedAt: overrides.startedAt ?? '2026-05-19T00:00:00.000Z',
    completedAt: overrides.completedAt ?? '2026-05-19T00:00:01.000Z',
    durationMs: overrides.durationMs ?? 1000,
    ...(overrides.agent ? { agent: overrides.agent } : {}),
  };
}

const AGENT_ONE: AgentMeta = { id: 'a1', slug: 'researcher', name: 'Researcher' };
const AGENT_TWO: AgentMeta = { id: 'a2', slug: 'reporter', name: 'Report Writer' };

describe('collectAgentSlugsFromSnapshot', () => {
  it('returns the slugs from agent_call steps, deduplicated and sorted', () => {
    const slugs = collectAgentSlugsFromSnapshot({
      steps: [
        { id: 's1', type: 'agent_call', config: { agentSlug: 'reporter' } },
        { id: 's2', type: 'llm_call', config: {} },
        { id: 's3', type: 'agent_call', config: { agentSlug: 'researcher' } },
        // Duplicate slug — second agent_call binding the same agent
        // (legit pattern in some templates). Should be deduplicated.
        { id: 's4', type: 'agent_call', config: { agentSlug: 'researcher' } },
      ],
    });
    expect(slugs).toEqual(['reporter', 'researcher']);
  });

  it('returns an empty array on a malformed snapshot', () => {
    expect(collectAgentSlugsFromSnapshot(null)).toEqual([]);
    expect(collectAgentSlugsFromSnapshot({ steps: 'not-an-array' })).toEqual([]);
    expect(collectAgentSlugsFromSnapshot({ steps: [{ type: 'agent_call' }] })).toEqual([]);
    expect(
      collectAgentSlugsFromSnapshot({ steps: [{ id: 's1', type: 'agent_call', config: null }] })
    ).toEqual([]);
  });

  it('skips agent_call steps whose agentSlug is empty or non-string', () => {
    const slugs = collectAgentSlugsFromSnapshot({
      steps: [
        { id: 's1', type: 'agent_call', config: { agentSlug: '' } },
        { id: 's2', type: 'agent_call', config: { agentSlug: 42 } },
        { id: 's3', type: 'agent_call', config: { agentSlug: 'real-slug' } },
      ],
    });
    expect(slugs).toEqual(['real-slug']);
  });
});

describe('overlayAgentInfo', () => {
  it('attaches agent metadata to matching agent_call entries', () => {
    const result = overlayAgentInfo({
      trace: [
        makeEntry({ stepId: 's1', stepType: 'agent_call' }),
        makeEntry({ stepId: 's2', stepType: 'llm_call' }),
      ],
      snapshot: {
        steps: [
          { id: 's1', type: 'agent_call', config: { agentSlug: 'researcher' } },
          { id: 's2', type: 'llm_call', config: {} },
        ],
      },
      agentsBySlug: new Map([['researcher', AGENT_ONE]]),
    });
    expect(result[0].agent).toEqual(AGENT_ONE);
    expect(result[1].agent).toBeUndefined();
  });

  it('does NOT attach to non-agent_call entries even if a slug somehow matches', () => {
    const result = overlayAgentInfo({
      trace: [makeEntry({ stepId: 's1', stepType: 'llm_call' })],
      // Snapshot also has s1 as llm_call — the helper only walks
      // agent_call steps, so the slug never enters the map.
      snapshot: { steps: [{ id: 's1', type: 'llm_call', config: {} }] },
      agentsBySlug: new Map([['anything', AGENT_ONE]]),
    });
    expect(result[0].agent).toBeUndefined();
  });

  it('leaves the entry alone when the slug does not resolve in the agent map', () => {
    // Slug references an agent that has since been deleted / archived.
    // Better to leave the entry alone than render a broken chip.
    const result = overlayAgentInfo({
      trace: [makeEntry({ stepId: 's1', stepType: 'agent_call' })],
      snapshot: {
        steps: [{ id: 's1', type: 'agent_call', config: { agentSlug: 'deleted-agent' } }],
      },
      agentsBySlug: new Map(),
    });
    expect(result[0].agent).toBeUndefined();
  });

  it('preserves an existing agent field on the entry (idempotent)', () => {
    const result = overlayAgentInfo({
      trace: [makeEntry({ stepId: 's1', stepType: 'agent_call', agent: AGENT_TWO })],
      snapshot: {
        steps: [{ id: 's1', type: 'agent_call', config: { agentSlug: 'researcher' } }],
      },
      agentsBySlug: new Map([['researcher', AGENT_ONE]]),
    });
    // Already enriched — the helper doesn't overwrite. (Live execution
    // panels could pre-fill the field; the overlay should be idempotent.)
    expect(result[0].agent).toEqual(AGENT_TWO);
  });

  it('returns trace unchanged when the agent map is empty', () => {
    const trace = [makeEntry({ stepId: 's1', stepType: 'agent_call' })];
    const result = overlayAgentInfo({
      trace,
      snapshot: {
        steps: [{ id: 's1', type: 'agent_call', config: { agentSlug: 'anything' } }],
      },
      agentsBySlug: new Map(),
    });
    expect(result[0].agent).toBeUndefined();
  });

  it('returns trace unchanged on a malformed snapshot', () => {
    const result = overlayAgentInfo({
      trace: [makeEntry({ stepId: 's1', stepType: 'agent_call' })],
      snapshot: null,
      agentsBySlug: new Map([['x', AGENT_ONE]]),
    });
    expect(result[0].agent).toBeUndefined();
  });

  it('does not mutate the input trace', () => {
    const trace = [makeEntry({ stepId: 's1', stepType: 'agent_call' })];
    const result = overlayAgentInfo({
      trace,
      snapshot: {
        steps: [{ id: 's1', type: 'agent_call', config: { agentSlug: 'researcher' } }],
      },
      agentsBySlug: new Map([['researcher', AGENT_ONE]]),
    });
    expect(result).not.toBe(trace);
    expect(trace[0].agent).toBeUndefined();
  });
});
