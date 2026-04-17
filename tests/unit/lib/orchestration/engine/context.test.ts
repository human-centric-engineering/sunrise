/**
 * Tests for the execution context helpers.
 */

import { describe, expect, it } from 'vitest';

import {
  createContext,
  mergeStepResult,
  snapshotContext,
} from '@/lib/orchestration/engine/context';
import { logger } from '@/lib/logging';

function makeCtx() {
  return createContext({
    executionId: 'exec1',
    workflowId: 'wf1',
    userId: 'user1',
    inputData: { query: 'hello' },
    logger,
  });
}

describe('context helpers', () => {
  it('createContext starts with zeroed totals and empty outputs', () => {
    const ctx = makeCtx();
    expect(ctx.stepOutputs).toEqual({});
    expect(ctx.variables).toEqual({});
    expect(ctx.totalTokensUsed).toBe(0);
    expect(ctx.totalCostUsd).toBe(0);
  });

  it('createContext defaults defaultErrorStrategy to "fail" when not provided', () => {
    const ctx = makeCtx();
    expect(ctx.defaultErrorStrategy).toBe('fail');
  });

  it('createContext sets defaultErrorStrategy from the param when provided', () => {
    const ctx = createContext({
      executionId: 'exec-x',
      workflowId: 'wf-x',
      userId: 'user-x',
      inputData: {},
      defaultErrorStrategy: 'skip',
      logger,
    });
    expect(ctx.defaultErrorStrategy).toBe('skip');
  });

  it('createContext accepts all valid defaultErrorStrategy values', () => {
    const strategies = ['retry', 'fallback', 'skip', 'fail'] as const;
    for (const strategy of strategies) {
      const ctx = createContext({
        executionId: 'exec-x',
        workflowId: 'wf-x',
        userId: 'user-x',
        inputData: {},
        defaultErrorStrategy: strategy,
        logger,
      });
      expect(ctx.defaultErrorStrategy).toBe(strategy);
    }
  });

  it('mergeStepResult accumulates tokens + cost and records outputs keyed by step id', () => {
    const ctx = makeCtx();
    mergeStepResult(ctx, 'step1', { output: 'hi', tokensUsed: 10, costUsd: 0.01 });
    mergeStepResult(ctx, 'step2', { output: { x: 1 }, tokensUsed: 5, costUsd: 0.005 });

    expect(ctx.stepOutputs).toEqual({ step1: 'hi', step2: { x: 1 } });
    expect(ctx.totalTokensUsed).toBe(15);
    expect(ctx.totalCostUsd).toBeCloseTo(0.015);
  });

  it('snapshotContext returns a frozen view whose stepOutputs cannot be mutated', () => {
    const ctx = makeCtx();
    mergeStepResult(ctx, 'step1', { output: 'hi', tokensUsed: 0, costUsd: 0 });
    const snap = snapshotContext(ctx);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.stepOutputs)).toBe(true);
    expect(() => {
      (snap.stepOutputs as { step2?: unknown }).step2 = 'bleed';
    }).toThrow();
  });

  it('snapshots are disjoint from the live context', () => {
    const ctx = makeCtx();
    const snap = snapshotContext(ctx);
    mergeStepResult(ctx, 'step1', { output: 'hi', tokensUsed: 1, costUsd: 0.1 });
    // Snapshot totals should still reflect pre-merge state.
    expect(snap.totalTokensUsed).toBe(0);
    expect(snap.totalCostUsd).toBe(0);
  });
});
