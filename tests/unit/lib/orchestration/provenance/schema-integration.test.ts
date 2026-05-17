/**
 * Integration of ProvenanceItem with executionTraceEntrySchema.
 *
 * The engine lifts a step's `output.sources` onto its trace entry's
 * `provenance` field. The persistence path round-trips that entry
 * through `executionTraceEntrySchema` (on resume + on read). These tests
 * pin the schema contract so a future change to either schema doesn't
 * silently drop the field from persisted traces.
 */

import { describe, expect, it } from 'vitest';
import { executionTraceEntrySchema } from '@/lib/validations/orchestration';
import type { ProvenanceItem } from '@/lib/orchestration/provenance/types';

const baseEntry = {
  stepId: 'analyse_chat',
  stepType: 'llm_call',
  label: 'Analyse chat/completion models',
  status: 'completed' as const,
  output: { models: [] },
  tokensUsed: 0,
  costUsd: 0,
  startedAt: '2026-05-16T10:00:00.000Z',
  durationMs: 100,
};

describe('executionTraceEntrySchema — provenance field', () => {
  it('parses an entry with no provenance (back-compat)', () => {
    const result = executionTraceEntrySchema.safeParse(baseEntry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provenance).toBeUndefined();
    }
  });

  it('parses an entry with a valid provenance array', () => {
    const provenance: ProvenanceItem[] = [
      { source: 'web_search', confidence: 'high', reference: 'https://example.com' },
      { source: 'training_knowledge', confidence: 'low', note: 'inferred' },
    ];
    const entry = { ...baseEntry, provenance };

    const result = executionTraceEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provenance).toEqual(provenance);
    }
  });

  it('drops a malformed provenance array gracefully (catch → undefined)', () => {
    const entry = {
      ...baseEntry,
      provenance: [{ source: 'bogus_kind', confidence: 'high' }],
    };

    const result = executionTraceEntrySchema.safeParse(entry);
    // Same posture as `turns`: a malformed sub-field must NOT fail the
    // whole entry parse, otherwise the visited-set seeding on resume
    // drops the row and the engine re-runs an already-completed step.
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provenance).toBeUndefined();
    }
  });

  it('preserves provenance through passthrough on unknown sibling fields', () => {
    const provenance: ProvenanceItem[] = [
      { source: 'web_search', confidence: 'high', reference: 'https://example.com' },
    ];
    const entry = {
      ...baseEntry,
      provenance,
      // A hypothetical future field the engine may add; passthrough must
      // preserve it alongside provenance so older code reading newer
      // traces doesn't silently strip data on re-checkpoint.
      futureField: { something: 'new' },
    };

    const result = executionTraceEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provenance).toEqual(provenance);
      expect((result.data as Record<string, unknown>).futureField).toEqual({ something: 'new' });
    }
  });
});
