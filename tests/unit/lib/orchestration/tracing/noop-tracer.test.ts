/**
 * Unit tests for the no-op tracer singleton.
 *
 * The no-op tracer is the default registered tracer. Its contract:
 * - `startSpan` always returns the singleton `NOOP_SPAN` (zero allocations)
 * - Every `Span` method is callable with any input without throwing
 * - `traceId()` / `spanId()` return empty strings (sentinel for "no real tracer")
 * - `withSpan` invokes fn exactly once, returns its value, propagates errors
 * - `withActiveContext` invokes fn and returns its value (transparent passthrough)
 *
 * No mocking required — this module is purely synchronous with no dependencies.
 */

import { describe, expect, it } from 'vitest';

import { NOOP_SPAN, NOOP_TRACER } from '@/lib/orchestration/tracing/noop-tracer';

describe('NOOP_TRACER.startSpan', () => {
  it('returns the singleton NOOP_SPAN for a plain name', () => {
    // Arrange + Act
    const span = NOOP_TRACER.startSpan('some.operation');

    // Assert — must be the exact singleton, not a new allocation
    expect(span).toBe(NOOP_SPAN);
  });

  it('returns the singleton NOOP_SPAN when options are provided', () => {
    // Arrange + Act
    const span = NOOP_TRACER.startSpan('llm.call', {
      kind: 'CLIENT',
      attributes: { 'gen_ai.system': 'openai', 'gen_ai.request.model': 'gpt-4o' },
    });

    // Assert — same singleton regardless of options
    expect(span).toBe(NOOP_SPAN);
  });
});

describe('NOOP_SPAN methods', () => {
  it('setAttribute is callable with string value and does not throw', () => {
    // Arrange + Act + Assert — the lambda exercises the real call, so .not.toThrow() is valid
    expect(() => NOOP_SPAN.setAttribute('gen_ai.system', 'openai')).not.toThrow();
  });

  it('setAttribute is callable with numeric, boolean, and undefined values', () => {
    // Arrange + Act — should not throw for any of these types
    expect(() => NOOP_SPAN.setAttribute('tokens', 42)).not.toThrow();
    expect(() => NOOP_SPAN.setAttribute('success', true)).not.toThrow();
    expect(() => NOOP_SPAN.setAttribute('optional', undefined)).not.toThrow();
  });

  it('setAttributes is callable with an arbitrary attributes map and does not throw', () => {
    // Arrange + Act + Assert
    expect(() =>
      NOOP_SPAN.setAttributes({
        'gen_ai.system': 'anthropic',
        'gen_ai.usage.input_tokens': 100,
        'sunrise.cost_usd': 0.002,
      })
    ).not.toThrow();
  });

  it('setStatus is callable with ok, error, and unset codes and does not throw', () => {
    // Arrange + Act + Assert
    expect(() => NOOP_SPAN.setStatus({ code: 'ok' })).not.toThrow();
    expect(() =>
      NOOP_SPAN.setStatus({ code: 'error', message: 'something went wrong' })
    ).not.toThrow();
    expect(() => NOOP_SPAN.setStatus({ code: 'unset' })).not.toThrow();
  });

  it('recordException is callable with an Error instance and does not throw', () => {
    // Arrange
    const err = new Error('network timeout');

    // Act + Assert — the lambda exercises the real call
    expect(() => NOOP_SPAN.recordException(err)).not.toThrow();
  });

  it('recordException is callable with non-Error values (string, plain object, undefined)', () => {
    // Arrange + Act + Assert — must not throw for any of these inputs
    expect(() => NOOP_SPAN.recordException('raw string error')).not.toThrow();
    expect(() => NOOP_SPAN.recordException({ code: 500, detail: 'internal' })).not.toThrow();
    expect(() => NOOP_SPAN.recordException(undefined)).not.toThrow();
    expect(() => NOOP_SPAN.recordException(null)).not.toThrow();
    expect(() => NOOP_SPAN.recordException(42)).not.toThrow();
  });

  it('end is callable and does not throw', () => {
    // Arrange + Act + Assert — end must be idempotent for a no-op
    expect(() => NOOP_SPAN.end()).not.toThrow();
  });

  it('traceId returns an empty string — sentinel used by cost-log threading to detect no real tracer', () => {
    // Arrange + Act
    const id = NOOP_SPAN.traceId();

    // Assert — downstream logic at cost-tracker.ts:148-149 checks for empty string
    expect(id).toBe('');
  });

  it('spanId returns an empty string — sentinel used by cost-log threading to detect no real tracer', () => {
    // Arrange + Act
    const id = NOOP_SPAN.spanId();

    // Assert — downstream logic at cost-tracker.ts:148-149 checks for empty string
    expect(id).toBe('');
  });
});

describe('NOOP_TRACER.withSpan', () => {
  it('invokes the function exactly once and returns its value', async () => {
    // Arrange
    let callCount = 0;
    const expectedValue = { result: 'hello' };

    // Act
    const result = await NOOP_TRACER.withSpan('op', {}, async (_span) => {
      callCount += 1;
      return expectedValue;
    });

    // Assert — fn called exactly once, return value forwarded
    expect(callCount).toBe(1);
    expect(result).toBe(expectedValue);
  });

  it('passes the singleton NOOP_SPAN to the callback function', async () => {
    // Arrange
    let capturedSpan: unknown;

    // Act
    await NOOP_TRACER.withSpan('op', {}, async (span) => {
      capturedSpan = span;
    });

    // Assert — fn receives the actual singleton (not a copy)
    expect(capturedSpan).toBe(NOOP_SPAN);
  });

  it('propagates downstream exceptions — a rejecting fn causes withSpan to reject with the same error', async () => {
    // Arrange
    const downstreamError = new Error('downstream failure');

    // Act + Assert — the error must propagate, not be swallowed
    await expect(
      NOOP_TRACER.withSpan('op', {}, async () => {
        throw downstreamError;
      })
    ).rejects.toThrow(downstreamError);
  });
});

describe('NOOP_TRACER.withActiveContext', () => {
  it('invokes fn and returns its value (transparent passthrough)', async () => {
    // Arrange — fn returns a sentinel value; span arg is NOOP_SPAN
    const expectedValue = { result: 'context-result' };

    // Act — withActiveContext must not wrap, transform, or intercept the return value
    const result = await NOOP_TRACER.withActiveContext(NOOP_SPAN, async () => expectedValue);

    // Assert — return value forwarded unchanged; no throw, no wrapping
    expect(result).toBe(expectedValue);
  });
});
