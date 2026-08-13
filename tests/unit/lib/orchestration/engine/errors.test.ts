/**
 * Tests for engine-internal error classes.
 */

import { describe, expect, it } from 'vitest';
import {
  BudgetExceeded,
  ExecutorError,
  PausedForApproval,
  retriabilityOfCause,
} from '@/lib/orchestration/engine/errors';
import { ProviderError } from '@/lib/orchestration/llm/provider';

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

  describe('retriabilityOfCause', () => {
    it('adopts a non-retriable verdict the cause already made', () => {
      // The case that matters: a `truncated_no_output` ProviderError is the
      // same cap, the same prompt, every time. Wrapping it at the default
      // `retriable: true` let a step's retry strategy re-issue it for the
      // whole retryCount, each attempt billing a full cap of output to hit
      // the identical wall (#587).
      expect(
        retriabilityOfCause(new ProviderError('cut off', { code: 'truncated_no_output' }))
      ).toBe(false);
    });

    it('keeps a retriable cause retriable', () => {
      expect(
        retriabilityOfCause(
          new ProviderError('upstream 503', { code: 'http_503', retriable: true })
        )
      ).toBe(true);
    });

    it('defaults to retriable for a cause that expresses no verdict', () => {
      // A bare Error, a string, null, undefined — nothing has claimed the
      // failure is deterministic, so the optimistic default stands.
      for (const cause of [new Error('network'), 'boom', null, undefined, {}]) {
        expect(retriabilityOfCause(cause)).toBe(true);
      }
    });

    it('ignores a non-boolean `retriable` rather than coercing it', () => {
      // Guards against a truthy string flipping the verdict silently.
      expect(retriabilityOfCause({ retriable: 'false' })).toBe(true);
      expect(retriabilityOfCause({ retriable: 0 })).toBe(true);
    });
  });
});
