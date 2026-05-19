import { describe, it, expect } from 'vitest';

import { overlayStepDescriptions } from '@/lib/orchestration/trace/overlay-descriptions';
import type { ExecutionTraceEntry } from '@/types/orchestration';

/**
 * Unit tests for the trace-entry description overlay.
 *
 * The overlay backfills `description` onto historical trace entries
 * (those written before the field existed) from the workflow snapshot
 * the execution ran against. These tests pin the four contract rules:
 *
 *   1. Trace-entry value wins when present (audit-honest).
 *   2. Missing description is filled from snapshot.steps[stepId].
 *   3. Malformed snapshot returns the trace unchanged (no throw).
 *   4. Empty / non-string snapshot description is treated as absent.
 */

function makeEntry(
  overrides: Partial<ExecutionTraceEntry> & { stepId: string }
): ExecutionTraceEntry {
  return {
    stepId: overrides.stepId,
    stepType: overrides.stepType ?? 'llm_call',
    label: overrides.label ?? overrides.stepId,
    status: overrides.status ?? 'completed',
    output: overrides.output ?? null,
    tokensUsed: overrides.tokensUsed ?? 0,
    costUsd: overrides.costUsd ?? 0,
    startedAt: overrides.startedAt ?? '2026-05-19T00:00:00.000Z',
    completedAt: overrides.completedAt ?? '2026-05-19T00:00:01.000Z',
    durationMs: overrides.durationMs ?? 1000,
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
  };
}

describe('overlayStepDescriptions', () => {
  it('fills a missing description from the snapshot step with the same id', () => {
    const result = overlayStepDescriptions({
      trace: [makeEntry({ stepId: 's1' })],
      snapshot: { steps: [{ id: 's1', description: 'From snapshot' }] },
    });
    expect(result[0].description).toBe('From snapshot');
  });

  it('keeps an existing description on the trace entry (audit-honest pinned value)', () => {
    const result = overlayStepDescriptions({
      trace: [makeEntry({ stepId: 's1', description: 'Pinned at run time' })],
      snapshot: { steps: [{ id: 's1', description: 'Newer snapshot copy' }] },
    });
    // Trace entry wins — we never rewrite history.
    expect(result[0].description).toBe('Pinned at run time');
  });

  it('leaves trace unchanged when the snapshot is null', () => {
    const trace = [makeEntry({ stepId: 's1' })];
    const result = overlayStepDescriptions({ trace, snapshot: null });
    expect(result[0].description).toBeUndefined();
  });

  it('leaves trace unchanged when the snapshot is malformed (no steps array)', () => {
    const result = overlayStepDescriptions({
      trace: [makeEntry({ stepId: 's1' })],
      snapshot: { steps: 'not-an-array' },
    });
    expect(result[0].description).toBeUndefined();
  });

  it('skips snapshot steps whose description is an empty string', () => {
    const result = overlayStepDescriptions({
      trace: [makeEntry({ stepId: 's1' })],
      snapshot: { steps: [{ id: 's1', description: '' }] },
    });
    // Empty descriptions are treated as absent — we don't want to fill
    // the trace entry with another "no description".
    expect(result[0].description).toBeUndefined();
  });

  it('skips snapshot steps whose description is non-string', () => {
    const result = overlayStepDescriptions({
      trace: [makeEntry({ stepId: 's1' })],
      snapshot: { steps: [{ id: 's1', description: 42 }] },
    });
    expect(result[0].description).toBeUndefined();
  });

  it('preserves trace entries whose stepId is not in the snapshot', () => {
    const result = overlayStepDescriptions({
      trace: [makeEntry({ stepId: 's-orphan' })],
      snapshot: { steps: [{ id: 's1', description: 'unrelated' }] },
    });
    // Step was renamed / removed between runs — no overlay.
    expect(result[0].description).toBeUndefined();
  });

  it('overlays each entry independently across a multi-step trace', () => {
    const result = overlayStepDescriptions({
      trace: [
        makeEntry({ stepId: 's1' }),
        makeEntry({ stepId: 's2', description: 'already set' }),
        makeEntry({ stepId: 's3' }),
      ],
      snapshot: {
        steps: [
          { id: 's1', description: 'one' },
          { id: 's2', description: 'overlaid copy' },
          { id: 's3', description: 'three' },
        ],
      },
    });
    expect(result[0].description).toBe('one');
    expect(result[1].description).toBe('already set'); // wins over snapshot
    expect(result[2].description).toBe('three');
  });

  it('returns a new array — does not mutate the input', () => {
    const trace = [makeEntry({ stepId: 's1' })];
    const result = overlayStepDescriptions({
      trace,
      snapshot: { steps: [{ id: 's1', description: 'fill' }] },
    });
    expect(result).not.toBe(trace);
    expect(trace[0].description).toBeUndefined();
  });
});
