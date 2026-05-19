import { describe, it, expect } from 'vitest';

import { mergeDescriptionsIntoSnapshot } from '@/prisma/seeds/005-backfill-step-descriptions';
import type { WorkflowDefinition, WorkflowStep } from '@/types/orchestration';

/**
 * Tests for the pure merge helper that backs the
 * `005-backfill-step-descriptions` seed. The seed itself reads from
 * `AiWorkflow` and writes a new `AiWorkflowVersion`; we don't unit-test
 * the DB round-trip here (covered by `db:seed` itself once run) — these
 * tests pin the merge contract: additive only, never overwriting
 * existing descriptions, never touching other step fields, and
 * preserving steps the snapshot has that the source doesn't.
 */

const step = (overrides: Partial<WorkflowStep>): WorkflowStep => ({
  id: overrides.id ?? 'step-1',
  name: overrides.name ?? 'A step',
  type: overrides.type ?? 'llm_call',
  config: overrides.config ?? {},
  nextSteps: overrides.nextSteps ?? [],
  ...(overrides.description !== undefined ? { description: overrides.description } : {}),
});

const def = (steps: WorkflowStep[]): WorkflowDefinition => ({
  steps,
  entryStepId: steps[0]?.id ?? 'step-1',
  errorStrategy: 'fail',
});

describe('mergeDescriptionsIntoSnapshot', () => {
  it('fills a missing description from the source step with the same id', () => {
    const existing = def([step({ id: 's1' })]);
    const source = def([step({ id: 's1', description: 'From source.' })]);
    const result = mergeDescriptionsIntoSnapshot(existing, source);
    expect(result.filledCount).toBe(1);
    expect(result.snapshot.steps[0].description).toBe('From source.');
  });

  it('does NOT overwrite a description the snapshot already has — admin/operator wins', () => {
    const existing = def([step({ id: 's1', description: 'Operator wrote this.' })]);
    const source = def([step({ id: 's1', description: 'From source.' })]);
    const result = mergeDescriptionsIntoSnapshot(existing, source);
    expect(result.filledCount).toBe(0);
    expect(result.snapshot.steps[0].description).toBe('Operator wrote this.');
  });

  it('treats an empty-string description as missing so a previous bug fill does not block backfill', () => {
    const existing = def([step({ id: 's1', description: '   ' })]);
    const source = def([step({ id: 's1', description: 'From source.' })]);
    const result = mergeDescriptionsIntoSnapshot(existing, source);
    expect(result.filledCount).toBe(1);
    expect(result.snapshot.steps[0].description).toBe('From source.');
  });

  it('leaves the step untouched when the source has no description either', () => {
    const existing = def([step({ id: 's1' })]);
    const source = def([step({ id: 's1' })]);
    const result = mergeDescriptionsIntoSnapshot(existing, source);
    expect(result.filledCount).toBe(0);
    expect(result.snapshot.steps[0].description).toBeUndefined();
  });

  it('skips a snapshot step that has no matching id in the source — preserves admin-added steps', () => {
    const adminAdded = step({ id: 'admin-added', name: 'Custom step' });
    const existing = def([step({ id: 's1' }), adminAdded]);
    // Source only knows about s1.
    const source = def([step({ id: 's1', description: 'From source.' })]);
    const result = mergeDescriptionsIntoSnapshot(existing, source);
    expect(result.filledCount).toBe(1);
    // Admin's step is still there.
    const adminStep = result.snapshot.steps.find((s) => s.id === 'admin-added');
    expect(adminStep).toEqual(adminAdded);
  });

  it('does not change step order or count', () => {
    const existing = def([step({ id: 's1' }), step({ id: 's2' }), step({ id: 's3' })]);
    const source = def([
      step({ id: 's1', description: 'one' }),
      step({ id: 's2', description: 'two' }),
      step({ id: 's3', description: 'three' }),
    ]);
    const result = mergeDescriptionsIntoSnapshot(existing, source);
    expect(result.snapshot.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('does not touch fields other than description on a filled step', () => {
    const existing = def([
      step({
        id: 's1',
        name: 'Operator-renamed step',
        config: { prompt: 'Operator edited this prompt' },
        nextSteps: [{ targetStepId: 's2' }],
      }),
    ]);
    const source = def([
      step({
        id: 's1',
        name: 'Original name',
        config: { prompt: 'Original prompt' },
        nextSteps: [],
        description: 'From source.',
      }),
    ]);
    const result = mergeDescriptionsIntoSnapshot(existing, source);
    expect(result.filledCount).toBe(1);
    const merged = result.snapshot.steps[0];
    // The fill MUST be surgical: description added, every other field
    // exactly as the operator left it.
    expect(merged.description).toBe('From source.');
    expect(merged.name).toBe('Operator-renamed step');
    expect(merged.config).toEqual({ prompt: 'Operator edited this prompt' });
    expect(merged.nextSteps).toEqual([{ targetStepId: 's2' }]);
  });

  it('preserves the entryStepId and errorStrategy when no steps change', () => {
    const existing: WorkflowDefinition = {
      steps: [step({ id: 's1', description: 'already there' })],
      entryStepId: 's1',
      errorStrategy: 'retry',
    };
    const source: WorkflowDefinition = {
      steps: [step({ id: 's1', description: 'newer copy' })],
      entryStepId: 's1',
      errorStrategy: 'retry',
    };
    const result = mergeDescriptionsIntoSnapshot(existing, source);
    expect(result.filledCount).toBe(0);
    expect(result.snapshot.entryStepId).toBe('s1');
    expect(result.snapshot.errorStrategy).toBe('retry');
  });

  it('returns filledCount: 0 when called twice in a row — idempotent on re-runs', () => {
    const existing = def([step({ id: 's1' }), step({ id: 's2' })]);
    const source = def([
      step({ id: 's1', description: 'one' }),
      step({ id: 's2', description: 'two' }),
    ]);
    const first = mergeDescriptionsIntoSnapshot(existing, source);
    expect(first.filledCount).toBe(2);
    const second = mergeDescriptionsIntoSnapshot(first.snapshot, source);
    expect(second.filledCount).toBe(0);
  });
});
