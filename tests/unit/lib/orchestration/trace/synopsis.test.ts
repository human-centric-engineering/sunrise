/**
 * Tests for `lib/orchestration/trace/synopsis.ts`.
 *
 * Pure-function coverage of every branch in `analyzeExecution`, plus
 * each helper in isolation. The synopsis component is a thin shell over
 * these — the diagnostic value lives here.
 */

import { describe, expect, it } from 'vitest';

import {
  analyzeExecution,
  findExhaustedRetry,
  findFailedStep,
  findPredecessorContext,
  tallySkips,
  type SynopsisExecution,
} from '@/lib/orchestration/trace/synopsis';
import type { ExecutionTraceEntry } from '@/types/orchestration';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<ExecutionTraceEntry> = {}): ExecutionTraceEntry {
  return {
    stepId: 's',
    stepType: 'llm_call',
    label: 'Step',
    status: 'completed',
    output: { ok: true },
    tokensUsed: 0,
    costUsd: 0,
    startedAt: '2026-05-16T10:00:00.000Z',
    durationMs: 10,
    ...overrides,
  };
}

const COMPLETED_RUN: SynopsisExecution = {
  status: 'completed',
  errorMessage: null,
  currentStep: null,
};

// ─── analyzeExecution ──────────────────────────────────────────────────────

describe('analyzeExecution', () => {
  it('returns kind: none for a clean completion', () => {
    const trace = [makeEntry({ stepId: 'a' }), makeEntry({ stepId: 'b' })];
    expect(analyzeExecution(COMPLETED_RUN, trace).kind).toBe('none');
  });

  it('returns kind: none for a completion with only expected skips', () => {
    // Expected skips are the workflow author's deliberate opt-in
    // (errorStrategy: 'skip' + expectedSkip: true, like the audit's
    // optional Brave search step). They're not synopsis-worthy.
    const trace = [
      makeEntry({ stepId: 'a' }),
      makeEntry({ stepId: 'b', status: 'skipped', expectedSkip: true, error: 'no api key' }),
    ];
    expect(analyzeExecution(COMPLETED_RUN, trace).kind).toBe('none');
  });

  it('returns kind: skips_only when a completion contains an unexpected skip', () => {
    const trace = [
      makeEntry({ stepId: 'a' }),
      makeEntry({
        stepId: 'send-1',
        status: 'skipped',
        error: 'SMTP unreachable',
        expectedSkip: undefined,
      }),
      makeEntry({ stepId: 'c' }),
    ];
    const result = analyzeExecution(COMPLETED_RUN, trace);
    if (result.kind !== 'skips_only') throw new Error('expected skips_only');
    expect(result.skips.unexpected).toHaveLength(1);
    expect(result.skips.unexpected[0].stepId).toBe('send-1');
    expect(result.skips.expected).toHaveLength(0);
  });

  it('returns kind: failure for an executor-throw with the failed entry as headline', () => {
    const trace = [
      makeEntry({ stepId: 'a', output: { value: 42 } }),
      makeEntry({
        stepId: 'b',
        status: 'failed',
        error: 'Network timeout',
        output: null,
      }),
    ];
    const exec: SynopsisExecution = {
      status: 'failed',
      errorMessage: 'Network timeout',
      currentStep: 'b',
    };

    const result = analyzeExecution(exec, trace);
    if (result.kind !== 'failure') throw new Error('expected failure');
    expect(result.reason).toBe('Network timeout');
    expect(result.headlineStep?.stepId).toBe('b');
    expect(result.terminalAuthor).toBeNull();
    expect(result.predecessor?.stepId).toBe('a');
  });

  it('returns kind: failure for retry-exhaustion + terminalStatus path (failWorkflow)', () => {
    // The provider-audit failure mode after the recent fix:
    //   validate_proposals exhausts retries → engine routes to
    //   report_validation_failure (send_notification with
    //   terminalStatus: 'failed') → workflow finalised as FAILED, but
    //   NO trace row has status === 'failed' because the
    //   send_notification ran cleanly.
    //
    // The synopsis must spotlight the exhausted step as the headline
    // (the actual culprit) AND surface the terminalStatus author so
    // the cause-and-effect chain is explicit.
    const trace: ExecutionTraceEntry[] = [
      makeEntry({ stepId: 'audit_models', output: { models: [] } }),
      makeEntry({
        stepId: 'validate_proposals',
        label: 'Validate proposals',
        stepType: 'guard',
        status: 'completed',
        output: { passed: false, reason: 'capabilities not in spec' },
        retries: [
          { attempt: 1, maxRetries: 2, reason: 'first try failed', targetStepId: 'audit_models' },
          { attempt: 2, maxRetries: 2, reason: 'second try failed', targetStepId: 'audit_models' },
          {
            attempt: 3,
            maxRetries: 2,
            reason: 'capabilities not in spec',
            targetStepId: 'report_validation_failure',
            exhausted: true,
          },
        ],
      }),
      makeEntry({
        stepId: 'report_validation_failure',
        label: 'Notify admin: validation exhausted',
        stepType: 'send_notification',
        status: 'completed',
      }),
    ];
    const exec: SynopsisExecution = {
      status: 'failed',
      errorMessage: 'capabilities not in spec',
      currentStep: 'report_validation_failure',
    };

    const result = analyzeExecution(exec, trace);
    if (result.kind !== 'failure') throw new Error('expected failure');
    expect(result.headlineStep?.stepId).toBe('validate_proposals');
    expect(result.terminalAuthor?.stepId).toBe('report_validation_failure');
    expect(result.reason).toBe('capabilities not in spec');
    expect(result.retries.length).toBe(3);
    expect(result.retries[result.retries.length - 1].exhausted).toBe(true);
  });

  it('returns kind: failure with no headline step for engine-level failures', () => {
    // Engine-level failures (budget exceeded, deadlock, abort) have no
    // associated trace row. The synopsis falls back to errorMessage
    // alone — `headlineStep` is null, `predecessor` is best-effort.
    const trace = [makeEntry({ stepId: 'a' })];
    const exec: SynopsisExecution = {
      status: 'failed',
      errorMessage: 'Budget exceeded',
      currentStep: null,
    };

    const result = analyzeExecution(exec, trace);
    if (result.kind !== 'failure') throw new Error('expected failure');
    expect(result.headlineStep).toBeNull();
    expect(result.reason).toBe('Budget exceeded');
    expect(result.retries).toEqual([]);
  });

  it('returns kind: failure with a usable reason even when both errorMessage and entry.error are missing', () => {
    // Defensive: if the engine somehow finalised as FAILED with no
    // reason on either the row or the failing entry, the synopsis
    // still renders something coherent rather than an empty string.
    const trace = [makeEntry({ stepId: 'a', status: 'failed', error: undefined, output: null })];
    const exec: SynopsisExecution = {
      status: 'failed',
      errorMessage: null,
      currentStep: 'a',
    };

    const result = analyzeExecution(exec, trace);
    if (result.kind !== 'failure') throw new Error('expected failure');
    expect(result.reason).toBe('Step failed');
  });

  it('returns kind: cancellation with reason from errorMessage', () => {
    const trace = [makeEntry({ stepId: 'a' }), makeEntry({ stepId: 'b' })];
    const exec: SynopsisExecution = {
      status: 'cancelled',
      errorMessage: 'Rejected: payload looked wrong',
      currentStep: 'b',
    };

    const result = analyzeExecution(exec, trace);
    if (result.kind !== 'cancellation') throw new Error('expected cancellation');
    expect(result.reason).toBe('Rejected: payload looked wrong');
    expect(result.atStep?.stepId).toBe('b');
  });

  it('handles "canceled" (American spelling) the same as "cancelled"', () => {
    const exec: SynopsisExecution = {
      status: 'canceled',
      errorMessage: 'stopped',
      currentStep: null,
    };
    expect(analyzeExecution(exec, []).kind).toBe('cancellation');
  });

  it('returns kind: failure even when status casing differs (case-insensitive match)', () => {
    // The engine writes lowercase status strings but the row could
    // come back uppercased through some path. analyzeExecution
    // normalises before branching.
    const exec: SynopsisExecution = {
      status: 'FAILED',
      errorMessage: 'boom',
      currentStep: null,
    };
    expect(analyzeExecution(exec, []).kind).toBe('failure');
  });
});

// ─── findFailedStep ────────────────────────────────────────────────────────

describe('findFailedStep', () => {
  it('returns the first entry with status: failed', () => {
    const trace = [
      makeEntry({ stepId: 'a' }),
      makeEntry({ stepId: 'b', status: 'failed', error: 'boom' }),
      makeEntry({ stepId: 'c' }),
    ];
    expect(findFailedStep(trace)?.stepId).toBe('b');
  });

  it('returns null when no entry has status: failed', () => {
    expect(findFailedStep([makeEntry({ stepId: 'a' })])).toBeNull();
  });
});

// ─── findExhaustedRetry ────────────────────────────────────────────────────

describe('findExhaustedRetry', () => {
  it('returns the exhaustion event when retries[].last.exhausted is true', () => {
    const trace: ExecutionTraceEntry[] = [
      makeEntry({
        stepId: 'guard-1',
        retries: [
          { attempt: 1, maxRetries: 2, reason: 'r1', targetStepId: 'producer' },
          { attempt: 2, maxRetries: 2, reason: 'r2', targetStepId: 'producer' },
          {
            attempt: 3,
            maxRetries: 2,
            reason: 'final',
            targetStepId: 'failure-handler',
            exhausted: true,
          },
        ],
      }),
    ];
    const result = findExhaustedRetry(trace);
    expect(result?.step.stepId).toBe('guard-1');
    expect(result?.attempts).toBe(3);
    expect(result?.maxRetries).toBe(2);
    expect(result?.reason).toBe('final');
    expect(result?.targetStepId).toBe('failure-handler');
  });

  it('returns null when no entry has an exhausted retry', () => {
    const trace = [
      makeEntry({
        stepId: 'a',
        retries: [
          // Non-exhausted retry — workflow continued.
          { attempt: 1, maxRetries: 2, reason: 'r1', targetStepId: 'producer' },
        ],
      }),
    ];
    expect(findExhaustedRetry(trace)).toBeNull();
  });

  it('returns null when retries array is missing entirely', () => {
    expect(findExhaustedRetry([makeEntry({ stepId: 'a' })])).toBeNull();
  });

  it('returns the LAST exhaustion when multiple steps exhausted in the same run', () => {
    // Edge case: two retry loops both exhausted (very rare — would
    // typically require a complex DAG with nested retry sources).
    const trace: ExecutionTraceEntry[] = [
      makeEntry({
        stepId: 'guard-1',
        retries: [
          { attempt: 2, maxRetries: 1, reason: 'first', targetStepId: 'h1', exhausted: true },
        ],
      }),
      makeEntry({
        stepId: 'guard-2',
        retries: [
          { attempt: 3, maxRetries: 2, reason: 'second', targetStepId: 'h2', exhausted: true },
        ],
      }),
    ];
    expect(findExhaustedRetry(trace)?.step.stepId).toBe('guard-2');
  });
});

// ─── findPredecessorContext ────────────────────────────────────────────────

describe('findPredecessorContext', () => {
  it('returns the most recent completed step before the failing one', () => {
    const trace = [
      makeEntry({ stepId: 'a', label: 'Load data', output: { rows: 10 } }),
      makeEntry({ stepId: 'b', label: 'Classify', output: 'embedding' }),
      makeEntry({ stepId: 'c', status: 'failed', error: 'boom' }),
    ];
    const ctx = findPredecessorContext(trace, 'c');
    expect(ctx?.stepId).toBe('b');
    expect(ctx?.stepName).toBe('Classify');
    expect(ctx?.output).toBe('embedding');
  });

  it('skips over skipped steps when looking for predecessor output', () => {
    const trace = [
      makeEntry({ stepId: 'a', output: { value: 1 } }),
      makeEntry({ stepId: 'b', status: 'skipped', output: null, expectedSkip: true }),
      makeEntry({ stepId: 'c', status: 'failed' }),
    ];
    expect(findPredecessorContext(trace, 'c')?.stepId).toBe('a');
  });

  it('skips over entries whose output is null/undefined', () => {
    const trace = [
      makeEntry({ stepId: 'a', output: 'real output' }),
      makeEntry({ stepId: 'b', output: null }),
      makeEntry({ stepId: 'c', status: 'failed' }),
    ];
    expect(findPredecessorContext(trace, 'c')?.stepId).toBe('a');
  });

  it('returns null when the failing step is the first in the trace', () => {
    const trace = [makeEntry({ stepId: 'a', status: 'failed' })];
    expect(findPredecessorContext(trace, 'a')).toBeNull();
  });

  it('returns null when no predecessor has usable output', () => {
    const trace = [
      makeEntry({ stepId: 'a', output: null }),
      makeEntry({ stepId: 'b', status: 'failed' }),
    ];
    expect(findPredecessorContext(trace, 'b')).toBeNull();
  });

  it('falls back to end-of-trace when failingStepId is not in the trace', () => {
    // Engine-level failures may pass a currentStep that didn't make
    // it into the trace. The helper falls back to "most recent
    // completed at the end" — still useful context.
    const trace = [
      makeEntry({ stepId: 'a', output: 'a-out' }),
      makeEntry({ stepId: 'b', output: 'b-out' }),
    ];
    expect(findPredecessorContext(trace, 'unknown-step')?.stepId).toBe('b');
  });

  it('returns null when failingStepId is null and trace is empty', () => {
    expect(findPredecessorContext([], null)).toBeNull();
  });
});

// ─── tallySkips ────────────────────────────────────────────────────────────

describe('tallySkips', () => {
  it('separates expected from unexpected skips', () => {
    const trace = [
      makeEntry({ stepId: 'a' }),
      makeEntry({ stepId: 'b', status: 'skipped', expectedSkip: true, error: 'no api key' }),
      makeEntry({ stepId: 'c', status: 'skipped', error: 'SMTP unreachable' }),
      makeEntry({ stepId: 'd', status: 'skipped', expectedSkip: true }),
    ];
    const tally = tallySkips(trace);
    expect(tally.total).toBe(3);
    expect(tally.expected).toHaveLength(2);
    expect(tally.unexpected).toHaveLength(1);
    expect(tally.unexpected[0].stepId).toBe('c');
  });

  it('returns empty breakdown when no steps were skipped', () => {
    const tally = tallySkips([makeEntry({ stepId: 'a' })]);
    expect(tally.total).toBe(0);
    expect(tally.expected).toEqual([]);
    expect(tally.unexpected).toEqual([]);
  });

  it('treats `expectedSkip: false` as unexpected (back-compat: explicit false)', () => {
    const trace = [makeEntry({ stepId: 'a', status: 'skipped', expectedSkip: false })];
    expect(tallySkips(trace).unexpected).toHaveLength(1);
  });

  it('ignores non-skipped statuses entirely', () => {
    const trace = [
      makeEntry({ stepId: 'a', status: 'failed' }),
      makeEntry({ stepId: 'b', status: 'awaiting_approval' }),
      makeEntry({ stepId: 'c', status: 'rejected' }),
    ];
    expect(tallySkips(trace).total).toBe(0);
  });
});
