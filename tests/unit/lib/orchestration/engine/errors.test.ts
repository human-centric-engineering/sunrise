/**
 * Tests for engine-internal error classes.
 */

import { describe, expect, it } from 'vitest';
import {
  BudgetExceeded,
  ExecutorError,
  PausedForApproval,
} from '@/lib/orchestration/engine/errors';
import { ProviderCallRefusedError } from '@/lib/orchestration/llm/provider-eligibility';

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

  it('defaults retriable to true for backward compatibility', () => {
    const err = new ExecutorError('s1', 'llm_failed', 'LLM broke');
    // test-review:accept tobe_true — structural assertion on retriable boolean field of ExecutorError
    expect(err.retriable).toBe(true);
  });

  it('accepts explicit retriable=false', () => {
    const err = new ExecutorError('s1', 'http_error', 'HTTP 404', undefined, false);
    expect(err.retriable).toBe(false);
  });

  it('accepts explicit retriable=true', () => {
    const err = new ExecutorError('s1', 'http_error_retriable', 'HTTP 503', undefined, true);
    // test-review:accept tobe_true — structural assertion on retriable boolean field of ExecutorError
    expect(err.retriable).toBe(true);
  });
});

// §120 t-741: a provider-policy refusal anywhere in the cause chain decides the
// code and the retry verdict, whichever executor wraps it.
describe('ExecutorError — a provider-policy refusal in the cause chain', () => {
  it('codes a wrapped ProviderCallRefusedError provider_not_permitted, non-retriable', () => {
    const err = new ExecutorError(
      's1',
      'search_failed',
      'x',
      new ProviderCallRefusedError('barred'),
      true
    );
    expect(err.code).toBe('provider_not_permitted');
    expect(err.retriable).toBe(false);
  });

  it('finds the refusal through an intermediate wrapper', () => {
    const inner = new ExecutorError(
      's1',
      'llm_call_failed',
      'x',
      new ProviderCallRefusedError('b')
    );
    const outer = new ExecutorError('s1', 'planner_call_failed', 'y', inner, true);
    expect(outer.code).toBe('provider_not_permitted');
    expect(outer.retriable).toBe(false);
  });

  it('finds it under a plain Error cause too', () => {
    const wrapped = new Error('search failed', { cause: new ProviderCallRefusedError('b') });
    expect(new ExecutorError('s1', 'search_failed', 'x', wrapped).code).toBe(
      'provider_not_permitted'
    );
  });

  it("keeps the engine's executor_threw code, whose raw message is never shown, but stops the retry", () => {
    const thrown = new Error('embedding failed for http://internal/doc-1', {
      cause: new ProviderCallRefusedError('b'),
    });
    const err = new ExecutorError('s1', 'executor_threw', thrown.message, thrown, true);
    expect(err.code).toBe('executor_threw');
    expect(err.retriable).toBe(false);
  });

  it('leaves any other cause alone', () => {
    const err = new ExecutorError('s1', 'search_failed', 'x', new Error('pgvector error'), true);
    expect(err.code).toBe('search_failed');
    expect(err.retriable).toBe(true);
  });

  it('stops walking a cause chain after a bounded depth', () => {
    // A cycle must not hang the constructor.
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(new ExecutorError('s1', 'x_failed', 'x', a).code).toBe('x_failed');
  });
});
