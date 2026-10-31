/**
 * The saved walk position a crash-resume continues from (t-966): what the
 * parser accepts, and how the bounded-retry context is rebuilt from the trace.
 * The resume behaviour itself is exercised end to end in
 * `orchestration-engine.test.ts` ("crash-resume").
 */

import { describe, expect, it } from 'vitest';

import {
  parseWalkPosition,
  retryContextFromTrace,
  type WalkPosition,
} from '@/lib/orchestration/engine/walk-position';
import type { ExecutionTraceEntry } from '@/types/orchestration';

const position: WalkPosition = {
  v: 1,
  inFlight: ['b'],
  batch: false,
  done: {},
  pending: ['d'],
  visited: ['a', 'b'],
  retryCounts: { 'check→draft': 1 },
  stepCount: 2,
  budgetWarned: false,
};

function entry(stepId: string, retries?: ExecutionTraceEntry['retries']): ExecutionTraceEntry {
  return {
    stepId,
    stepType: 'llm_call',
    label: stepId,
    status: 'completed',
    output: null,
    tokensUsed: 0,
    costUsd: 0,
    startedAt: '2026-10-31T00:00:00.000Z',
    durationMs: 1,
    ...(retries ? { retries } : {}),
  };
}

describe('parseWalkPosition', () => {
  it('reads back a position the engine saved', () => {
    expect(parseWalkPosition(structuredClone(position))).toEqual(position);
  });

  it('answers null for a row with no position, so the resume takes the cursor path', () => {
    expect(parseWalkPosition(null)).toBeNull();
    expect(parseWalkPosition(undefined)).toBeNull();
  });

  it('answers null for a position it cannot read, rather than resuming from a guess', () => {
    expect(parseWalkPosition({ ...position, v: 2 })).toBeNull();
    expect(parseWalkPosition({ ...position, inFlight: 'b' })).toBeNull();
    expect(parseWalkPosition({ ...position, retryCounts: { 'check→draft': -1 } })).toBeNull();
  });
});

describe('retryContextFromTrace', () => {
  const retry = { attempt: 1, maxRetries: 2, reason: 'too short', targetStepId: 'draft' };
  const exhausted = {
    attempt: 3,
    maxRetries: 2,
    reason: 'still short',
    targetStepId: 'fallback',
    exhausted: true,
  };

  it('rebuilds the context from the retry it points at', () => {
    const trace = [entry('draft'), entry('check', [retry, exhausted])];

    expect(retryContextFromTrace(trace, { entry: 1, retry: 0, step: 'check' })).toEqual({
      fromStep: 'check',
      attempt: 1,
      maxRetries: 2,
      failureReason: 'too short',
    });
  });

  it('answers undefined when no retry set the context, or the trace no longer holds it', () => {
    const trace = [entry('draft')];

    expect(retryContextFromTrace(trace, undefined)).toBeUndefined();
    expect(retryContextFromTrace(trace, { entry: 0, retry: 0, step: 'draft' })).toBeUndefined();
    expect(retryContextFromTrace(trace, { entry: 5, retry: 0, step: 'check' })).toBeUndefined();
  });

  it('finds the retry by step when a dropped corrupt entry has shifted the index', () => {
    // Saved as entry 2; the resume dropped an unparseable entry before it.
    const trace = [entry('draft'), entry('check', [retry, exhausted])];

    expect(retryContextFromTrace(trace, { entry: 2, retry: 0, step: 'check' })).toEqual({
      fromStep: 'check',
      attempt: 1,
      maxRetries: 2,
      failureReason: 'too short',
    });
  });
});
