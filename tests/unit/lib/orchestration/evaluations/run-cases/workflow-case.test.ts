/**
 * Unit tests for runWorkflowCase — Phase 1 stub.
 *
 * Verifies the stub returns the documented not-supported error code so
 * the worker's per-case dispatch records a typed error instead of throwing.
 */

import { describe, it, expect } from 'vitest';

import { runWorkflowCase } from '@/lib/orchestration/evaluations/run-cases/workflow-case';

describe('runWorkflowCase (Phase 1 stub)', () => {
  it('returns errorCode "workflow_subject_not_supported_in_phase_1" with the canonical shape', async () => {
    const result = await runWorkflowCase({
      workflowId: 'wf-1',
      userId: 'user-1',
      input: { foo: 'bar' },
      subjectOutputSelector: { path: 'final.text' },
    });

    expect(result.errorCode).toBe('workflow_subject_not_supported_in_phase_1');
    expect(result.errorMessage).toMatch(/Workflow-as-subject/);
    expect(result.assistantText).toBe('');
    expect(result.citations).toEqual([]);
    expect(result.toolCalls).toEqual([]);
    expect(result.tokenUsage).toEqual({ input: 0, output: 0 });
    expect(result.costUsd).toBe(0);
    expect(result.latencyMs).toBe(0);
  });

  it('returns the same shape regardless of input — stub is shape-stable', async () => {
    const result = await runWorkflowCase({
      workflowId: '',
      userId: 'user-2',
      input: {},
      subjectOutputSelector: null,
    });

    expect(result.errorCode).toBe('workflow_subject_not_supported_in_phase_1');
    expect(result.assistantText).toBe('');
    expect(result.tokenUsage).toEqual({ input: 0, output: 0 });
  });

  it('returns a Promise (async signature kept stable for Phase 3)', () => {
    const promise = runWorkflowCase({
      workflowId: 'w',
      userId: 'u',
      input: {},
      subjectOutputSelector: null,
    });
    expect(promise).toBeInstanceOf(Promise);
  });
});
