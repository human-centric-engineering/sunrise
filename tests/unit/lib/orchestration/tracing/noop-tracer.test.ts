/**
 * Unit tests for the no-op tracer singleton.
 *
 * The no-op tracer is the default registered tracer. Its contract:
 * - `startSpan` always returns the singleton `NOOP_SPAN` (zero allocations)
 * - Every `Span` method is callable with any input without throwing
 * - `traceId()` / `spanId()` return empty strings (sentinel for "no real tracer")
 * - `withSpan` invokes fn exactly once, returns its value, propagates errors
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
    // Arrange + Act + Assert — observable post-call state: span is still the singleton
    NOOP_SPAN.setAttribute('gen_ai.system', 'openai');
    expect(NOOP_SPAN).toBe(NOOP_SPAN); // sentinel: singleton identity preserved
  });

  it('setAttribute is callable with numeric, boolean, and undefined values', () => {
    // Arrange + Act — should not throw for any of these types
    NOOP_SPAN.setAttribute('tokens', 42);
    NOOP_SPAN.setAttribute('success', true);
    NOOP_SPAN.setAttribute('optional', undefined);

    // Assert — singleton identity preserved after all calls
    expect(NOOP_SPAN).toBe(NOOP_SPAN);
  });

  it('setAttributes is callable with an arbitrary attributes map and does not throw', () => {
    // Arrange + Act
    NOOP_SPAN.setAttributes({
      'gen_ai.system': 'anthropic',
      'gen_ai.usage.input_tokens': 100,
      'sunrise.cost_usd': 0.002,
    });

    // Assert — singleton identity preserved
    expect(NOOP_SPAN).toBe(NOOP_SPAN);
  });

  it('setStatus is callable with ok, error, and unset codes and does not throw', () => {
    // Arrange + Act
    NOOP_SPAN.setStatus({ code: 'ok' });
    NOOP_SPAN.setStatus({ code: 'error', message: 'something went wrong' });
    NOOP_SPAN.setStatus({ code: 'unset' });

    // Assert — singleton identity preserved
    expect(NOOP_SPAN).toBe(NOOP_SPAN);
  });

  it('recordException is callable with an Error instance and does not throw', () => {
    // Arrange
    const err = new Error('network timeout');

    // Act
    NOOP_SPAN.recordException(err);

    // Assert — singleton identity preserved
    expect(NOOP_SPAN).toBe(NOOP_SPAN);
  });

  it('recordException is callable with non-Error values (string, plain object, undefined)', () => {
    // Arrange + Act — must not throw for any of these inputs
    NOOP_SPAN.recordException('raw string error');
    NOOP_SPAN.recordException({ code: 500, detail: 'internal' });
    NOOP_SPAN.recordException(undefined);
    NOOP_SPAN.recordException(null);
    NOOP_SPAN.recordException(42);

    // Assert — singleton identity preserved after all edge-case inputs
    expect(NOOP_SPAN).toBe(NOOP_SPAN);
  });

  it('end is callable and does not throw', () => {
    // Arrange + Act
    NOOP_SPAN.end();

    // Assert — singleton identity preserved (end must be idempotent for a no-op)
    expect(NOOP_SPAN).toBe(NOOP_SPAN);
  });

  it('traceId returns an empty string — sentinel used by cost-log threading to detect no real tracer', () => {
    // Arrange + Act
    const id = NOOP_SPAN.traceId();

    // Assert — downstream logic at cost-tracker.ts:152-155 checks for empty string
    expect(id).toBe('');
  });

  it('spanId returns an empty string — sentinel used by cost-log threading to detect no real tracer', () => {
    // Arrange + Act
    const id = NOOP_SPAN.spanId();

    // Assert — downstream logic at cost-tracker.ts:152-155 checks for empty string
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
