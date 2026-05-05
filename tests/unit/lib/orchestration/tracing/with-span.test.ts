/**
 * Tests for lib/orchestration/tracing/with-span.ts
 *
 * This is the single point of exception safety for all orchestration tracing.
 * The structural guarantee: a tracer error cannot abort orchestration — every
 * startSpan failure falls back to NOOP_SPAN and fn still runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logging';
import { MAX_ATTRIBUTE_STRING_LENGTH } from '@/lib/orchestration/tracing/attributes';
import { NOOP_SPAN } from '@/lib/orchestration/tracing/noop-tracer';
import { resetTracer, registerTracer } from '@/lib/orchestration/tracing/registry';
import type {
  Span,
  SpanAttributes,
  SpanStatus,
  StartSpanOptions,
  Tracer,
} from '@/lib/orchestration/tracing/tracer';
import {
  truncateAttribute,
  withSpan,
  startManualSpan,
  setSpanAttributes,
} from '@/lib/orchestration/tracing/with-span';

// ---------------------------------------------------------------------------
// Test-double tracer classes — not exported, test fixtures only
// ---------------------------------------------------------------------------

/** Records every span created for assertion in happy-path tests. */
class RecordingSpan implements Span {
  attributes: Record<string, unknown> = {};
  status: SpanStatus | null = null;
  exceptions: unknown[] = [];
  ended = false;

  setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }
  setAttributes(attrs: SpanAttributes): void {
    Object.assign(this.attributes, attrs);
  }
  setStatus(status: SpanStatus): void {
    this.status = status;
  }
  recordException(error: unknown): void {
    this.exceptions.push(error);
  }
  end(): void {
    this.ended = true;
  }
  traceId(): string {
    return 'test-trace-id';
  }
  spanId(): string {
    return 'test-span-id';
  }
}

type SpanRecord = {
  name: string;
  span: RecordingSpan;
  initialAttributes: SpanAttributes | undefined;
};

class RecordingTracer implements Tracer {
  spans: SpanRecord[] = [];

  startSpan(name: string, options?: StartSpanOptions): Span {
    const span = new RecordingSpan();
    // Record the attributes at startSpan time (before any later setAttribute calls)
    if (options?.attributes) {
      Object.assign(span.attributes, options.attributes);
    }
    this.spans.push({ name, span, initialAttributes: options?.attributes });
    return span;
  }

  async withSpan<T>(
    _name: string,
    _options: StartSpanOptions,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    return fn(NOOP_SPAN);
  }
}

/** Tracer whose startSpan always throws — simulates a broken OTEL provider. */
class ThrowingTracer implements Tracer {
  startSpan(_name: string, _options?: StartSpanOptions): Span {
    throw new Error('tracer broken');
  }

  async withSpan<T>(
    _name: string,
    _options: StartSpanOptions,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    return fn(NOOP_SPAN);
  }
}

/** Span whose setStatus / recordException / end all throw — simulates a partially broken exporter. */
class FlakeySpan implements Span {
  attributes: Record<string, unknown> = {};

  setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }
  setAttributes(attrs: SpanAttributes): void {
    Object.assign(this.attributes, attrs);
  }
  setStatus(_status: SpanStatus): void {
    throw new Error('setStatus failed');
  }
  recordException(_error: unknown): void {
    throw new Error('recordException failed');
  }
  end(): void {
    throw new Error('end failed');
  }
  traceId(): string {
    return 'flakey-trace-id';
  }
  spanId(): string {
    return 'flakey-span-id';
  }
}

/** Tracer that returns a FlakeySpan. */
class FlakySpanTracer implements Tracer {
  startSpan(_name: string, _options?: StartSpanOptions): Span {
    return new FlakeySpan();
  }

  async withSpan<T>(
    _name: string,
    _options: StartSpanOptions,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    return fn(NOOP_SPAN);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LONG_STRING = 'x'.repeat(MAX_ATTRIBUTE_STRING_LENGTH + 100);
const EXACT_STRING = 'y'.repeat(MAX_ATTRIBUTE_STRING_LENGTH);
const SHORT_STRING = 'hello';

// ---------------------------------------------------------------------------
// truncateAttribute
// ---------------------------------------------------------------------------

describe('truncateAttribute', () => {
  it('returns non-string values unchanged', () => {
    // Arrange / Act / Assert
    expect(truncateAttribute(42)).toBe(42);
    expect(truncateAttribute(true)).toBe(true);
    expect(truncateAttribute(undefined)).toBe(undefined);
  });

  it('returns strings at or under MAX_ATTRIBUTE_STRING_LENGTH unchanged', () => {
    // Arrange
    const underLimit = 'x'.repeat(MAX_ATTRIBUTE_STRING_LENGTH - 1);
    const atLimit = 'x'.repeat(MAX_ATTRIBUTE_STRING_LENGTH);

    // Act / Assert
    expect(truncateAttribute(underLimit)).toBe(underLimit);
    expect(truncateAttribute(atLimit)).toBe(atLimit);
    expect((truncateAttribute(atLimit) as string).length).toBe(MAX_ATTRIBUTE_STRING_LENGTH);
  });

  it('truncates strings longer than MAX_ATTRIBUTE_STRING_LENGTH to exactly the cap', () => {
    // Arrange
    const overLimit = 'x'.repeat(MAX_ATTRIBUTE_STRING_LENGTH + 500);

    // Act
    const result = truncateAttribute(overLimit);

    // Assert
    expect(typeof result).toBe('string');
    expect((result as string).length).toBe(MAX_ATTRIBUTE_STRING_LENGTH);
    expect(result).toBe(overLimit.slice(0, MAX_ATTRIBUTE_STRING_LENGTH));
  });
});

// ---------------------------------------------------------------------------
// withSpan — happy path
// ---------------------------------------------------------------------------

describe('withSpan — happy path', () => {
  let tracer: RecordingTracer;

  beforeEach(() => {
    tracer = new RecordingTracer();
    registerTracer(tracer);
  });

  afterEach(() => {
    resetTracer();
    vi.restoreAllMocks();
  });

  it('sets ok status, ends the span, records no exceptions, and returns fn value', async () => {
    // Arrange
    const attrs: SpanAttributes = { 'test.key': 'value', 'test.num': 99 };
    const expectedReturn = { done: true };

    // Act
    const result = await withSpan('test-span', attrs, async (span) => {
      expect(span).toBeInstanceOf(RecordingSpan);
      return expectedReturn;
    });

    // Assert
    expect(result).toBe(expectedReturn);
    expect(tracer.spans).toHaveLength(1);
    const { span } = tracer.spans[0];
    expect(span.status).toEqual({ code: 'ok' });
    expect(span.ended).toBe(true);
    expect(span.exceptions).toHaveLength(0);
  });

  it('truncates long string attributes at startSpan time before passing to the tracer', async () => {
    // Arrange — mixed attributes: one over-limit string, one short string, one number
    const attrs: SpanAttributes = {
      'long.attr': LONG_STRING,
      'short.attr': SHORT_STRING,
      'num.attr': 123,
    };

    // Act
    await withSpan('truncation-test', attrs, async () => 'done');

    // Assert — inspect initialAttributes recorded at startSpan time
    const { initialAttributes } = tracer.spans[0];
    expect(initialAttributes).toBeDefined();
    expect((initialAttributes!['long.attr'] as string).length).toBe(MAX_ATTRIBUTE_STRING_LENGTH);
    expect(initialAttributes!['long.attr']).toBe(LONG_STRING.slice(0, MAX_ATTRIBUTE_STRING_LENGTH));
    expect(initialAttributes!['short.attr']).toBe(SHORT_STRING); // unchanged
    expect(initialAttributes!['num.attr']).toBe(123); // unchanged
  });
});

// ---------------------------------------------------------------------------
// withSpan — error path
// ---------------------------------------------------------------------------

describe('withSpan — error path', () => {
  let tracer: RecordingTracer;

  beforeEach(() => {
    tracer = new RecordingTracer();
    registerTracer(tracer);
  });

  afterEach(() => {
    resetTracer();
    vi.restoreAllMocks();
  });

  it('rethrows the original error, sets error status with message, and records the exception', async () => {
    // Arrange
    const originalError = new Error('something went wrong');

    // Act
    await expect(
      withSpan('error-span', {}, async () => {
        throw originalError;
      })
    ).rejects.toThrow('something went wrong');

    // Assert — original error object is rethrown, not a wrapped copy
    const { span } = tracer.spans[0];
    expect(span.status).toEqual({ code: 'error', message: 'something went wrong' });
    expect(span.exceptions).toHaveLength(1);
    expect(span.exceptions[0]).toBe(originalError);
    expect(span.ended).toBe(true);
  });

  it('skips recordException when opts.recordException is false but still sets error status and rethrows', async () => {
    // Arrange
    const originalError = new Error('opt-out error');

    // Act
    await expect(
      withSpan(
        'no-record-span',
        {},
        async () => {
          throw originalError;
        },
        { recordException: false }
      )
    ).rejects.toThrow('opt-out error');

    // Assert — error status set but no exception recorded
    const { span } = tracer.spans[0];
    expect(span.status).toEqual({ code: 'error', message: 'opt-out error' });
    expect(span.exceptions).toHaveLength(0);
    expect(span.ended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// withSpan — tracer resilience (structural guarantee tests)
// ---------------------------------------------------------------------------

describe('withSpan — tracer resilience', () => {
  afterEach(() => {
    resetTracer();
    vi.restoreAllMocks();
  });

  it('falls back to NOOP_SPAN when startSpan throws, logs a warn, and fn runs to completion', async () => {
    // Arrange
    registerTracer(new ThrowingTracer());
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let spanReceivedByFn: Span | null = null;

    // Act
    const result = await withSpan('resilience-span', {}, async (span) => {
      spanReceivedByFn = span;
      return 'fn completed';
    });

    // Assert — fn ran and received the NOOP_SPAN fallback
    expect(result).toBe('fn completed');
    expect(spanReceivedByFn).toBe(NOOP_SPAN);

    // Warn logged with correct span name
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.startSpan threw — proceeding without span',
      expect.objectContaining({ span: 'resilience-span' })
    );
  });

  it('ThrowingTracer + fn that throws: original fn error is rethrown, warn still fires', async () => {
    // Arrange
    registerTracer(new ThrowingTracer());
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const fnError = new Error('fn error after tracer broken');

    // Act
    await expect(
      withSpan('double-failure-span', {}, async () => {
        throw fnError;
      })
    ).rejects.toThrow('fn error after tracer broken');

    // Assert — the thrown error is the original fn error, not the tracer error
    // Warn fires for the startSpan failure
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.startSpan threw — proceeding without span',
      expect.objectContaining({ span: 'double-failure-span' })
    );
  });

  it('FlakySpanTracer: setStatus/end both throw, withSpan returns fn value cleanly with individual warns', async () => {
    // Arrange
    registerTracer(new FlakySpanTracer());
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Act — fn succeeds; setStatus + end will throw internally
    const result = await withSpan('flakey-ok-span', {}, async () => 'ok result');

    // Assert — fn return value is preserved despite tracer method failures
    expect(result).toBe('ok result');

    // Individual warns fired for each failed tracer method
    const warnMessages = warnSpy.mock.calls.map((c) => c[0]);
    expect(warnMessages).toContain('Tracer.setStatus threw — continuing');
    expect(warnMessages).toContain('Tracer.end threw — continuing');
  });

  it('FlakySpanTracer + thrown fn error: original error propagates even when setStatus/recordException/end all throw', async () => {
    // Arrange
    registerTracer(new FlakySpanTracer());
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const originalError = new Error('fn error from flakey span test');

    // Act — fn throws; catch block's setStatus, recordException, end all throw internally
    await expect(
      withSpan('flakey-error-span', {}, async () => {
        throw originalError;
      })
    ).rejects.toThrow('fn error from flakey span test');
  });
});

// ---------------------------------------------------------------------------
// startManualSpan
// ---------------------------------------------------------------------------

describe('startManualSpan', () => {
  afterEach(() => {
    resetTracer();
    vi.restoreAllMocks();
  });

  it('happy path: returns span + end; calling end with ok status records status and ends span', () => {
    // Arrange
    const tracer = new RecordingTracer();
    registerTracer(tracer);

    // Act
    const { span, end } = startManualSpan('manual-span', { 'attr.key': 'val' });
    end({ code: 'ok' });

    // Assert
    expect(tracer.spans).toHaveLength(1);
    const recorded = tracer.spans[0].span;
    expect(recorded.status).toEqual({ code: 'ok' });
    expect(recorded.ended).toBe(true);
    expect(recorded.exceptions).toHaveLength(0);
    expect(span).toBe(recorded);
  });

  it('error path: end with error status + error param records BOTH status AND exception; without error param records status only', () => {
    // Arrange — two independent spans
    const tracer = new RecordingTracer();
    registerTracer(tracer);
    const errInstance = new Error('manual error');

    // Act — first: error with error param
    const { end: endWithErr } = startManualSpan('manual-error-span', {});
    endWithErr({ code: 'error', message: 'manual error' }, errInstance);

    // Act — second: error without error param
    const { end: endNoErr } = startManualSpan('manual-error-no-instance', {});
    endNoErr({ code: 'error', message: 'no instance' });

    // Assert — first span: both status and exception recorded
    const firstSpan = tracer.spans[0].span;
    expect(firstSpan.status).toEqual({ code: 'error', message: 'manual error' });
    expect(firstSpan.exceptions).toHaveLength(1);
    expect(firstSpan.exceptions[0]).toBe(errInstance);

    // Assert — second span: status recorded, no exception
    const secondSpan = tracer.spans[1].span;
    expect(secondSpan.status).toEqual({ code: 'error', message: 'no instance' });
    expect(secondSpan.exceptions).toHaveLength(0);
  });

  it('ThrowingTracer: returns NOOP_SPAN, end is safe to call (no throw), warn fires', () => {
    // Arrange
    registerTracer(new ThrowingTracer());
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Act
    const { span, end } = startManualSpan('manual-throwing-span', {});

    // Assert — fallback to NOOP_SPAN
    expect(span).toBe(NOOP_SPAN);

    // Warn fired for startSpan failure
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.startSpan threw — proceeding without span',
      expect.objectContaining({ span: 'manual-throwing-span' })
    );

    // end() must not throw even on the NOOP_SPAN fallback
    // Assert observable state: warn was called before end, confirm no new throws from end
    const warnCountBeforeEnd = warnSpy.mock.calls.length;
    end({ code: 'ok' });
    // end on NOOP_SPAN path calls safeSetStatus/safeEnd which go through NOOP_SPAN — no throw expected.
    // Assert that the call count didn't increase due to method-throw warns (NOOP_SPAN methods are safe)
    expect(warnSpy.mock.calls.length).toBe(warnCountBeforeEnd);
  });
});

// ---------------------------------------------------------------------------
// setSpanAttributes
// ---------------------------------------------------------------------------

describe('setSpanAttributes', () => {
  afterEach(() => {
    resetTracer();
    vi.restoreAllMocks();
  });

  it('truncates long strings before forwarding to span.setAttributes; short strings and numbers pass through unchanged', () => {
    // Arrange
    const span = new RecordingSpan();
    const attrs: SpanAttributes = {
      'long.attr': LONG_STRING,
      'short.attr': SHORT_STRING,
      'exact.attr': EXACT_STRING,
      'num.attr': 7,
    };

    // Act
    setSpanAttributes(span, attrs);

    // Assert — span.setAttributes was called and recorded the truncated values
    expect((span.attributes['long.attr'] as string).length).toBe(MAX_ATTRIBUTE_STRING_LENGTH);
    expect(span.attributes['long.attr']).toBe(LONG_STRING.slice(0, MAX_ATTRIBUTE_STRING_LENGTH));
    expect(span.attributes['short.attr']).toBe(SHORT_STRING);
    expect((span.attributes['exact.attr'] as string).length).toBe(MAX_ATTRIBUTE_STRING_LENGTH);
    expect(span.attributes['num.attr']).toBe(7);
  });

  it('logs a warn and does not rethrow when span.setAttributes throws', () => {
    // Arrange — a span whose setAttributes throws
    const brokenSpan: Span = {
      setAttribute: vi.fn(),
      setAttributes: vi.fn(() => {
        throw new Error('setAttributes failed');
      }),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
      traceId: () => '',
      spanId: () => '',
    };
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Act — must not throw
    expect(() => setSpanAttributes(brokenSpan, { key: 'value' })).not.toThrow();

    // Assert — warn logged with the expected message
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.setAttributes threw — continuing',
      expect.objectContaining({ error: 'setAttributes failed' })
    );
  });
});
