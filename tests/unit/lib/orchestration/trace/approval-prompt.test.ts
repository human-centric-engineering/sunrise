import { describe, expect, it } from 'vitest';

import { getApprovalPrompt } from '@/lib/orchestration/trace/approval-prompt';
import type { ExecutionTraceEntry } from '@/types/orchestration';

function entry(overrides: Partial<ExecutionTraceEntry> = {}): ExecutionTraceEntry {
  return {
    stepId: 's1',
    stepType: 'llm_call',
    label: 'Step',
    status: 'completed',
    output: null,
    tokensUsed: 0,
    costUsd: 0,
    startedAt: '2026-05-05T00:00:00.000Z',
    completedAt: '2026-05-05T00:00:01.000Z',
    durationMs: 100,
    ...overrides,
  };
}

describe('getApprovalPrompt', () => {
  it('returns the prompt string from the awaiting step', () => {
    const trace: ExecutionTraceEntry[] = [
      entry({ stepId: 'a', status: 'completed' }),
      entry({
        stepId: 'b',
        stepType: 'human_approval',
        status: 'awaiting_approval',
        output: { prompt: 'Approve the proposed changes?' },
      }),
    ];
    expect(getApprovalPrompt(trace)).toBe('Approve the proposed changes?');
  });

  it('returns null when no step is awaiting approval', () => {
    const trace: ExecutionTraceEntry[] = [
      entry({ status: 'completed' }),
      entry({ status: 'failed', error: 'boom' }),
    ];
    expect(getApprovalPrompt(trace)).toBeNull();
  });

  it('returns null when the awaiting step has no output', () => {
    const trace: ExecutionTraceEntry[] = [
      entry({
        stepType: 'human_approval',
        status: 'awaiting_approval',
        output: null,
      }),
    ];
    expect(getApprovalPrompt(trace)).toBeNull();
  });

  it('returns null when the awaiting step output is malformed', () => {
    // Output present but not shaped as { prompt: string } — the safeParse
    // branch must short-circuit to null instead of returning garbage.
    const trace: ExecutionTraceEntry[] = [
      entry({
        stepType: 'human_approval',
        status: 'awaiting_approval',
        output: { somethingElse: 42 },
      }),
    ];
    expect(getApprovalPrompt(trace)).toBeNull();
  });

  it('returns null on an empty trace', () => {
    expect(getApprovalPrompt([])).toBeNull();
  });
});
