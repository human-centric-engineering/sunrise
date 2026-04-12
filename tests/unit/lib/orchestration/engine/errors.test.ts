/**
 * Tests for engine-internal error classes.
 */

import { describe, expect, it } from 'vitest';
import {
  BudgetExceeded,
  ExecutorError,
  PausedForApproval,
} from '@/lib/orchestration/engine/errors';

describe('BudgetExceeded', () => {
  it('sets usedUsd, limitUsd, name, and formatted message', () => {
    const err = new BudgetExceeded(1.2345, 1.0);
    expect(err.name).toBe('BudgetExceeded');
    expect(err.usedUsd).toBe(1.2345);
    expect(err.limitUsd).toBe(1.0);
    expect(err.message).toBe('Budget exceeded: $1.2345 / $1.0000');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('PausedForApproval', () => {
  it('sets stepId, payload, name, and message', () => {
    const err = new PausedForApproval('gate', { prompt: 'ok?' });
    expect(err.name).toBe('PausedForApproval');
    expect(err.stepId).toBe('gate');
    expect(err.payload).toEqual({ prompt: 'ok?' });
    expect(err.message).toContain('gate');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ExecutorError', () => {
  it('sets stepId, code, message, cause, and name', () => {
    const cause = new Error('upstream');
    const err = new ExecutorError('s1', 'llm_failed', 'LLM broke', cause);
    expect(err.name).toBe('ExecutorError');
    expect(err.stepId).toBe('s1');
    expect(err.code).toBe('llm_failed');
    expect(err.message).toBe('LLM broke');
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it('works without cause', () => {
    const err = new ExecutorError('s2', 'missing', 'Missing config');
    expect(err.cause).toBeUndefined();
  });
});
