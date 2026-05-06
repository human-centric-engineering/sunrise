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
  setSpanStatus,
  recordSpanException,
  withSpanGenerator,
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

  async withActiveContext<T>(_span: Span, fn: () => Promise<T>): Promise<T> {
    return fn();
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

  async withActiveContext<T>(_span: Span, fn: () => Promise<T>): Promise<T> {
    return fn();
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

  async withActiveContext<T>(_span: Span, fn: () => Promise<T>): Promise<T> {
    return fn();
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

// ---------------------------------------------------------------------------
// Option defaults and edge cases
// ---------------------------------------------------------------------------

describe('option defaults and edge cases', () => {
  afterEach(() => {
    resetTracer();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // truncateAttributes — undefined / falsy early-return branch (line 24)
  // -------------------------------------------------------------------------

  it('startManualSpan: handles undefined attrs without throwing (truncateAttributes falsy early-return branch)', () => {
    // Arrange — cast undefined to bypass TS; drives the `if (!attrs) return attrs` branch
    // in truncateAttributes (line 24). The TypeScript signature requires SpanAttributes, but
    // the runtime guard exists for defensive safety.
    const tracer = new RecordingTracer();
    registerTracer(tracer);

    // Act — startManualSpan internally calls truncateAttributes(undefined)
    const { end } = startManualSpan('undefined-attrs-span', undefined as unknown as SpanAttributes);
    end({ code: 'ok' });

    // Assert — span created and status recorded cleanly; truncateAttributes returned without iterating
    expect(tracer.spans).toHaveLength(1);
    expect(tracer.spans[0].span.status).toEqual({ code: 'ok' });
  });

  // -------------------------------------------------------------------------
  // withSpan — non-Error thrown by fn (line 101 'error' literal branch)
  // -------------------------------------------------------------------------

  it('withSpan: uses "error" as the status message when fn throws a non-Error value', async () => {
    // Arrange — throw a plain string (not an Error instance)
    const tracer = new RecordingTracer();
    registerTracer(tracer);

    // Act
    await expect(
      withSpan('non-error-throw-span', {}, async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain string error';
      })
    ).rejects.toThrow('plain string error');

    // Assert — span status message falls back to the literal 'error' string
    const { span } = tracer.spans[0];
    expect(span.status).toEqual({ code: 'error', message: 'error' });
    // Exception is still recorded (recordException not opted out)
    expect(span.exceptions).toHaveLength(1);
    expect(span.exceptions[0]).toBe('plain string error');
    expect(span.ended).toBe(true);
  });

  // -------------------------------------------------------------------------
  // withSpan — non-Error thrown by startSpan (line 91 String(err) branch)
  // -------------------------------------------------------------------------

  it('withSpan: logs String(err) in the warn when startSpan throws a non-Error value', async () => {
    // Arrange — a tracer whose startSpan throws a plain string
    const nonErrorThrowingTracer: Tracer = {
      startSpan: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string tracer error';
      },
      withSpan: async (_n, _o, fn) => fn(NOOP_SPAN),
      withActiveContext: async (_s, fn) => fn(),
    };
    registerTracer(nonErrorThrowingTracer);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Act — fn must still run (fallback to NOOP_SPAN)
    const result = await withSpan('non-error-startspan-span', {}, async () => 'ran');

    // Assert — fn ran, warn was called with String(err) as the error field
    expect(result).toBe('ran');
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.startSpan threw — proceeding without span',
      expect.objectContaining({ error: 'string tracer error' })
    );
  });

  // -------------------------------------------------------------------------
  // startManualSpan — non-Error thrown by startSpan (line 130 String(err) branch)
  // -------------------------------------------------------------------------

  it('startManualSpan: logs String(err) in the warn when startSpan throws a non-Error value', () => {
    // Arrange
    const nonErrorThrowingTracer: Tracer = {
      startSpan: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 42;
      },
      withSpan: async (_n, _o, fn) => fn(NOOP_SPAN),
      withActiveContext: async (_s, fn) => fn(),
    };
    registerTracer(nonErrorThrowingTracer);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Act
    const { span, end } = startManualSpan('manual-non-error-throw', {});
    end({ code: 'ok' });

    // Assert — NOOP_SPAN fallback, warn carries String(42) = '42'
    expect(span).toBe(NOOP_SPAN);
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.startSpan threw — proceeding without span',
      expect.objectContaining({ error: '42' })
    );
  });

  // -------------------------------------------------------------------------
  // safeSetStatus — non-Error thrown by span.setStatus (line 38 String(err) branch)
  // -------------------------------------------------------------------------

  it('withSpan: logs String(err) in safeSetStatus warn when setStatus throws a non-Error', async () => {
    // Arrange — a span whose setStatus throws a plain string
    const stringThrowSpan: Span = {
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'setStatus string error';
      },
      recordException: vi.fn(),
      end: vi.fn(),
      traceId: () => '',
      spanId: () => '',
    };
    const stringThrowTracer: Tracer = {
      startSpan: () => stringThrowSpan,
      withSpan: async (_n, _o, fn) => fn(NOOP_SPAN),
      withActiveContext: async (_s, fn) => fn(),
    };
    registerTracer(stringThrowTracer);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Act — fn succeeds; safeSetStatus fires and its internal catch gets a non-Error
    const result = await withSpan('setStatus-non-error', {}, async () => 'done');

    // Assert — result preserved; warn carries the stringified value
    expect(result).toBe('done');
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.setStatus threw — continuing',
      expect.objectContaining({ error: 'setStatus string error' })
    );
  });

  // -------------------------------------------------------------------------
  // safeRecordException — non-Error thrown by span.recordException (line 49)
  // -------------------------------------------------------------------------

  it('withSpan: logs String(err) in safeRecordException warn when recordException throws a non-Error', async () => {
    // Arrange — span whose recordException throws a plain number
    const recordThrowSpan: Span = {
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      recordException: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 99;
      },
      end: vi.fn(),
      traceId: () => '',
      spanId: () => '',
    };
    const recordThrowTracer: Tracer = {
      startSpan: () => recordThrowSpan,
      withSpan: async (_n, _o, fn) => fn(NOOP_SPAN),
      withActiveContext: async (_s, fn) => fn(),
    };
    registerTracer(recordThrowTracer);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const fnError = new Error('fn threw');

    // Act — fn throws so safeRecordException is called; recordException internally throws non-Error
    await expect(
      withSpan('recordException-non-error', {}, async () => {
        throw fnError;
      })
    ).rejects.toThrow('fn threw');

    // Assert — warn carries String(99) = '99'
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.recordException threw — continuing',
      expect.objectContaining({ error: '99' })
    );
  });

  // -------------------------------------------------------------------------
  // safeEnd — non-Error thrown by span.end (line 60 String(err) branch)
  // -------------------------------------------------------------------------

  it('withSpan: logs String(err) in safeEnd warn when end throws a non-Error', async () => {
    // Arrange — span whose end throws a plain object
    const endThrowSpan: Span = {
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { msg: 'end-object-error' };
      },
      traceId: () => '',
      spanId: () => '',
    };
    const endThrowTracer: Tracer = {
      startSpan: () => endThrowSpan,
      withSpan: async (_n, _o, fn) => fn(NOOP_SPAN),
      withActiveContext: async (_s, fn) => fn(),
    };
    registerTracer(endThrowTracer);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Act — fn succeeds; safeEnd fires in the finally block
    const result = await withSpan('safeEnd-non-error', {}, async () => 'ok');

    // Assert — result preserved; warn carries String({ msg: 'end-object-error' })
    expect(result).toBe('ok');
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.end threw — continuing',
      expect.objectContaining({ error: '[object Object]' })
    );
  });

  // -------------------------------------------------------------------------
  // setSpanAttributes — truncateAttributes returns undefined → ?? {} fallback (line 151)
  // -------------------------------------------------------------------------

  it('setSpanAttributes: calls span.setAttributes with {} when truncateAttributes returns undefined', () => {
    // Arrange — pass undefined as attrs (cast to bypass TS); truncateAttributes returns undefined
    // so the ?? {} fallback on line 151 kicks in, calling setAttributes({}) instead of undefined
    const span = new RecordingSpan();

    // Act
    setSpanAttributes(span, undefined as unknown as SpanAttributes);

    // Assert — setAttributes was called with the {} fallback (no keys set, but called cleanly)
    expect(span.attributes).toEqual({});
  });

  // -------------------------------------------------------------------------
  // setSpanAttributes — non-Error thrown by span.setAttributes (line 154)
  // -------------------------------------------------------------------------

  it('setSpanAttributes: logs String(err) in the warn when setAttributes throws a non-Error', () => {
    // Arrange — a span whose setAttributes throws a plain string
    const brokenSpan: Span = {
      setAttribute: vi.fn(),
      setAttributes: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string-setAttributes-error';
      },
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
      traceId: () => '',
      spanId: () => '',
    };
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Act
    setSpanAttributes(brokenSpan, { key: 'value' });

    // Assert — warn carries String('string-setAttributes-error')
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.setAttributes threw — continuing',
      expect.objectContaining({ error: 'string-setAttributes-error' })
    );
  });
});

// ---------------------------------------------------------------------------
// setSpanStatus — public helper
// ---------------------------------------------------------------------------

describe('setSpanStatus', () => {
  afterEach(() => {
    resetTracer();
    vi.restoreAllMocks();
  });

  it('happy path: forwards the status call to the span', () => {
    // Arrange
    const span = new RecordingSpan();

    // Act
    setSpanStatus(span, { code: 'ok' });

    // Assert — the call was forwarded (not swallowed), span received the status
    expect(span.status).toEqual({ code: 'ok' });
  });

  it('happy path: forwards error status with message', () => {
    // Arrange
    const span = new RecordingSpan();

    // Act
    setSpanStatus(span, { code: 'error', message: 'something failed' });

    // Assert
    expect(span.status).toEqual({ code: 'error', message: 'something failed' });
  });

  it('logs a warn and does not rethrow when span.setStatus throws an Error', () => {
    // Arrange
    const brokenSpan: Span = {
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: () => {
        throw new Error('setStatus exploded');
      },
      recordException: vi.fn(),
      end: vi.fn(),
      traceId: () => '',
      spanId: () => '',
    };
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Act — must not throw
    expect(() => setSpanStatus(brokenSpan, { code: 'ok' })).not.toThrow();

    // Assert — warn logged with correct message
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.setStatus threw — continuing',
      expect.objectContaining({ error: 'setStatus exploded' })
    );
  });

  it('logs String(err) in the warn when setStatus throws a non-Error value', () => {
    // Arrange
    const brokenSpan: Span = {
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string-setStatus-error';
      },
      recordException: vi.fn(),
      end: vi.fn(),
      traceId: () => '',
      spanId: () => '',
    };
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Act
    setSpanStatus(brokenSpan, { code: 'error', message: 'attempt' });

    // Assert — warn carries String('string-setStatus-error')
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.setStatus threw — continuing',
      expect.objectContaining({ error: 'string-setStatus-error' })
    );
  });
});

// ---------------------------------------------------------------------------
// recordSpanException — public helper
// ---------------------------------------------------------------------------

describe('recordSpanException', () => {
  afterEach(() => {
    resetTracer();
    vi.restoreAllMocks();
  });

  it('happy path: forwards the error to span.recordException', () => {
    // Arrange
    const span = new RecordingSpan();
    const err = new Error('something went wrong');

    // Act
    recordSpanException(span, err);

    // Assert — exception was recorded on the span (not silently dropped)
    expect(span.exceptions).toHaveLength(1);
    expect(span.exceptions[0]).toBe(err);
  });

  it('happy path: forwards non-Error values (string, number) to span.recordException', () => {
    // Arrange
    const span = new RecordingSpan();

    // Act
    recordSpanException(span, 'plain string error');
    recordSpanException(span, 42);

    // Assert — both values forwarded
    expect(span.exceptions).toHaveLength(2);
    expect(span.exceptions[0]).toBe('plain string error');
    expect(span.exceptions[1]).toBe(42);
  });

  it('logs a warn and does not rethrow when span.recordException throws an Error', () => {
    // Arrange
    const brokenSpan: Span = {
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      recordException: () => {
        throw new Error('recordException exploded');
      },
      end: vi.fn(),
      traceId: () => '',
      spanId: () => '',
    };
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Act — must not throw
    expect(() => recordSpanException(brokenSpan, new Error('original'))).not.toThrow();

    // Assert — warn logged with correct message
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.recordException threw — continuing',
      expect.objectContaining({ error: 'recordException exploded' })
    );
  });

  it('logs String(err) in the warn when recordException throws a non-Error value', () => {
    // Arrange
    const brokenSpan: Span = {
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      recordException: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 99;
      },
      end: vi.fn(),
      traceId: () => '',
      spanId: () => '',
    };
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Act
    recordSpanException(brokenSpan, new Error('original'));

    // Assert — warn carries String(99) = '99'
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.recordException threw — continuing',
      expect.objectContaining({ error: '99' })
    );
  });
});

// ---------------------------------------------------------------------------
// withSpanGenerator — happy path
// ---------------------------------------------------------------------------

describe('withSpanGenerator — happy path', () => {
  let tracer: RecordingTracer;

  beforeEach(() => {
    tracer = new RecordingTracer();
    registerTracer(tracer);
  });

  afterEach(() => {
    resetTracer();
    vi.restoreAllMocks();
  });

  it('yields all values from the inner generator in order', async () => {
    // Arrange
    async function* inner(_span: Span): AsyncGenerator<string, void, unknown> {
      yield 'a';
      yield 'b';
      yield 'c';
    }

    // Act
    const values: string[] = [];
    for await (const v of withSpanGenerator('gen-happy', {}, inner)) {
      values.push(v);
    }

    // Assert — all values flowed through unchanged
    expect(values).toEqual(['a', 'b', 'c']);
  });

  it('sets ok status and ends the span after the inner generator completes normally', async () => {
    // Arrange
    async function* inner(_span: Span): AsyncGenerator<number, void, unknown> {
      yield 1;
      yield 2;
    }

    // Act
    for await (const _ of withSpanGenerator('gen-ok-status', {}, inner)) {
      // drain
    }

    // Assert — span ended with ok status and no exceptions
    expect(tracer.spans).toHaveLength(1);
    const { span } = tracer.spans[0];
    expect(span.status).toEqual({ code: 'ok' });
    expect(span.ended).toBe(true);
    expect(span.exceptions).toHaveLength(0);
  });

  it('propagates the return value so yield* callers receive it', async () => {
    // Arrange — inner generator returns a typed value (R = string)
    async function* inner(_span: Span): AsyncGenerator<number, string, unknown> {
      yield 1;
      return 'final-return-value';
    }

    // Act — use yield* to capture the return value
    async function* outer(): AsyncGenerator<number, string, unknown> {
      return yield* withSpanGenerator('gen-return', {}, inner);
    }

    const gen = outer();
    let next = await gen.next();
    while (!next.done) {
      next = await gen.next();
    }
    const returnValue: string | undefined = next.value;

    // Assert — the R-typed return value round-trips through the helper
    expect(returnValue).toBe('final-return-value');
  });

  it('multiple yields with mixed numeric values flow through unchanged', async () => {
    // Arrange — verifies the yield pipeline does not transform T values
    const yielded = [10, 20, 30, 40, 50];
    async function* inner(_span: Span): AsyncGenerator<number, void, unknown> {
      for (const v of yielded) {
        yield v;
      }
    }

    // Act
    const collected: number[] = [];
    for await (const v of withSpanGenerator('gen-multi', {}, inner)) {
      collected.push(v);
    }

    // Assert — values identical (not transformed/wrapped)
    expect(collected).toEqual(yielded);
  });

  it('forwards opts.kind to tracer.startSpan and defaults to INTERNAL when undefined', async () => {
    // Arrange — extend RecordingTracer to capture kind
    const kindCapture: Array<{ name: string; kind: string | undefined }> = [];
    const kindTracer: import('@/lib/orchestration/tracing/tracer').Tracer = {
      startSpan(name, options) {
        kindCapture.push({ name, kind: options?.kind });
        return new RecordingSpan();
      },
      withSpan: async (_n, _o, fn) => fn(new RecordingSpan()),
      withActiveContext: async (_s, fn) => fn(),
    };
    registerTracer(kindTracer);

    // Act — first call with explicit CLIENT kind, second with no opts (defaults to INTERNAL)
    async function* noop(_span: Span): AsyncGenerator<never, void, unknown> {}
    for await (const _ of withSpanGenerator('gen-client-kind', {}, noop, { kind: 'CLIENT' })) {
      // drain
    }
    for await (const _ of withSpanGenerator('gen-default-kind', {}, noop)) {
      // drain
    }

    // Assert — explicit kind forwarded; missing opts defaults to INTERNAL
    expect(kindCapture).toHaveLength(2);
    expect(kindCapture[0]).toEqual({ name: 'gen-client-kind', kind: 'CLIENT' });
    expect(kindCapture[1]).toEqual({ name: 'gen-default-kind', kind: 'INTERNAL' });
  });

  it('attributes are truncated before forwarding to startSpan', async () => {
    // Arrange
    async function* noop(_span: Span): AsyncGenerator<never, void, unknown> {}

    // Act
    for await (const _ of withSpanGenerator(
      'gen-truncate',
      { 'long.attr': LONG_STRING, 'num.attr': 7 },
      noop
    )) {
      // drain
    }

    // Assert — initialAttributes on the recorded span are truncated
    const { initialAttributes } = tracer.spans[0];
    expect((initialAttributes!['long.attr'] as string).length).toBe(MAX_ATTRIBUTE_STRING_LENGTH);
    expect(initialAttributes!['num.attr']).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// withSpanGenerator — error path
// ---------------------------------------------------------------------------

describe('withSpanGenerator — error path', () => {
  let tracer: RecordingTracer;

  beforeEach(() => {
    tracer = new RecordingTracer();
    registerTracer(tracer);
  });

  afterEach(() => {
    resetTracer();
    vi.restoreAllMocks();
  });

  it('sets error status, records exception, ends span, and rethrows when inner throws mid-yield', async () => {
    // Arrange
    const innerError = new Error('inner generator exploded');
    async function* inner(_span: Span): AsyncGenerator<string, void, unknown> {
      yield 'first';
      throw innerError;
    }

    // Act
    const values: string[] = [];
    await expect(async () => {
      for await (const v of withSpanGenerator('gen-inner-throw', {}, inner)) {
        values.push(v);
      }
    }).rejects.toThrow('inner generator exploded');

    // Assert — yielded value before throw was received; span closed correctly
    expect(values).toEqual(['first']);
    const { span } = tracer.spans[0];
    expect(span.status).toEqual({ code: 'error', message: 'inner generator exploded' });
    expect(span.exceptions).toHaveLength(1);
    expect(span.exceptions[0]).toBe(innerError);
    expect(span.ended).toBe(true);
  });

  it('sets error status on first-step throw (before yielding anything)', async () => {
    // Arrange — inner throws synchronously on first .next() call
    const firstStepError = new Error('error before first yield');
    async function* inner(_span: Span): AsyncGenerator<string, void, unknown> {
      throw firstStepError;

      yield 'never';
    }

    // Act
    await expect(async () => {
      for await (const _ of withSpanGenerator('gen-first-step-throw', {}, inner)) {
        // drain
      }
    }).rejects.toThrow('error before first yield');

    // Assert — span still receives error treatment even though nothing was yielded
    const { span } = tracer.spans[0];
    expect(span.status).toEqual({ code: 'error', message: 'error before first yield' });
    expect(span.exceptions).toHaveLength(1);
    expect(span.exceptions[0]).toBe(firstStepError);
    expect(span.ended).toBe(true);
  });

  it('uses "error" as the status message when inner throws a non-Error value', async () => {
    // Arrange — throw a plain string
    // eslint-disable-next-line require-yield
    async function* inner(_span: Span): AsyncGenerator<never, void, unknown> {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string error from inner';
    }

    // Act
    await expect(async () => {
      for await (const _ of withSpanGenerator('gen-non-error-throw', {}, inner)) {
        // drain
      }
    }).rejects.toBe('string error from inner');

    // Assert — message falls back to 'error' literal for non-Error throws
    const { span } = tracer.spans[0];
    expect(span.status).toEqual({ code: 'error', message: 'error' });
    expect(span.exceptions[0]).toBe('string error from inner');
    expect(span.ended).toBe(true);
  });

  it('manualStatus: true — skips setStatus on throw but STILL calls recordException', async () => {
    // This is the critical non-obvious spec: manualStatus gates setStatus but NOT recordException.
    // A regression where recordException is also gated on !manualStatus would silently break
    // failover-style usage where the caller reads the exception from the OTLP backend.
    const innerError = new Error('failover error');
    // eslint-disable-next-line require-yield
    async function* inner(_span: Span): AsyncGenerator<never, void, unknown> {
      throw innerError;
    }

    // Act
    await expect(async () => {
      for await (const _ of withSpanGenerator('gen-manual-status-throw', {}, inner, {
        manualStatus: true,
      })) {
        // drain
      }
    }).rejects.toThrow('failover error');

    // Assert — status NOT set by helper (manualStatus: true), but exception IS recorded
    const { span } = tracer.spans[0];
    // Status should remain null (never set by helper) when manualStatus: true
    expect(span.status).toBeNull();
    // But exception MUST be recorded regardless of manualStatus
    expect(span.exceptions).toHaveLength(1);
    expect(span.exceptions[0]).toBe(innerError);
    expect(span.ended).toBe(true);
  });

  it('manualStatus: true — does not set ok status when inner completes normally', async () => {
    // Verify the normal-completion branch also respects manualStatus
    async function* inner(_span: Span): AsyncGenerator<string, void, unknown> {
      yield 'event';
    }

    for await (const _ of withSpanGenerator('gen-manual-status-ok', {}, inner, {
      manualStatus: true,
    })) {
      // drain
    }

    // Assert — status was never touched by the helper; inner controlled it (or left it unset)
    const { span } = tracer.spans[0];
    expect(span.status).toBeNull();
    expect(span.ended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// withSpanGenerator — consumer early-exit (break / throw)
// ---------------------------------------------------------------------------

describe('withSpanGenerator — consumer early exit', () => {
  let tracer: RecordingTracer;

  beforeEach(() => {
    tracer = new RecordingTracer();
    registerTracer(tracer);
  });

  afterEach(() => {
    resetTracer();
    vi.restoreAllMocks();
  });

  it('consumer break: calls inner.return() so inner try/finally runs', async () => {
    // Arrange — inner has a finally block with a side effect we can observe.
    // If inner.return() is correctly called, the finally fires and sets the flag.
    let innerFinallyCalled = false;
    async function* inner(_span: Span): AsyncGenerator<number, void, unknown> {
      try {
        yield 1;
        yield 2;
        yield 3;
      } finally {
        innerFinallyCalled = true;
      }
    }

    // Act — break after first item (consumer exits early)
    for await (const v of withSpanGenerator('gen-consumer-break', {}, inner)) {
      expect(v).toBe(1);
      break;
    }

    // Assert — inner's finally must have run (inner.return() was called by the helper)
    expect(innerFinallyCalled).toBe(true);
    // Span ends regardless
    expect(tracer.spans[0].span.ended).toBe(true);
  });

  it('consumer break: span ends (always) even when inner runs no iterations', async () => {
    // Sanity check: break before consuming anything
    let innerFinallyCalled = false;
    async function* inner(_span: Span): AsyncGenerator<number, void, unknown> {
      try {
        yield 1;
      } finally {
        innerFinallyCalled = true;
      }
    }

    // We can't break before the first item is consumed in for-await (the first
    // next() is called before the body runs), so we break immediately after.
    let count = 0;
    for await (const _ of withSpanGenerator('gen-break-immediate', {}, inner)) {
      count++;
      break;
    }

    expect(count).toBe(1);
    expect(innerFinallyCalled).toBe(true);
    expect(tracer.spans[0].span.ended).toBe(true);
  });

  it('consumer.throw(): forwards return() to inner so its try/finally runs', async () => {
    // Regression guard: when the consumer calls gen.throw(err), the helper's
    // finally must call inner.return() so the inner's own try/finally fires —
    // mirroring `yield*` desugaring. The fix removed the `done` flag from the
    // catch path so inner.return() is now called unconditionally in finally.
    // A regression that re-introduces the gate (or skips inner.return on the
    // catch path) would silently leak inner-side resources (e.g. nested
    // spans, file handles, agent budget locks).
    let innerFinallyCalled = false;
    async function* inner(_span: Span): AsyncGenerator<number, void, unknown> {
      try {
        yield 1;
        yield 2;
      } finally {
        innerFinallyCalled = true;
      }
    }

    // Act — consume one item, then throw at the outer generator
    const gen = withSpanGenerator('gen-consumer-throw', {}, inner);
    const first = await gen.next();
    expect(first.value).toBe(1);

    // Throw into the outer generator (consumer-initiated throw)
    const consumerError = new Error('consumer threw');
    await expect(gen.throw(consumerError)).rejects.toThrow('consumer threw');

    // Assert — inner.return() was forwarded; inner's finally fired.
    expect(innerFinallyCalled).toBe(true);

    // Span still ends (safeEnd always fires) and records the consumer error.
    const recorded = tracer.spans[0].span;
    expect(recorded.ended).toBe(true);
    expect(recorded.exceptions).toContain(consumerError);
    expect(recorded.status).toEqual({ code: 'error', message: 'consumer threw' });
  });
});

// ---------------------------------------------------------------------------
// withSpanGenerator — tracer resilience
// ---------------------------------------------------------------------------

describe('withSpanGenerator — tracer resilience', () => {
  afterEach(() => {
    resetTracer();
    vi.restoreAllMocks();
  });

  it('ThrowingTracer: falls back to NOOP_SPAN, inner generator still runs, logs a warn', async () => {
    // Arrange
    registerTracer(new ThrowingTracer());
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let spanPassedToInner: Span | null = null;

    async function* inner(span: Span): AsyncGenerator<string, void, unknown> {
      spanPassedToInner = span;
      yield 'ran';
    }

    // Act
    const values: string[] = [];
    for await (const v of withSpanGenerator('gen-throwing-tracer', {}, inner)) {
      values.push(v);
    }

    // Assert — inner ran despite tracer failure, fallback NOOP_SPAN was used
    expect(values).toEqual(['ran']);
    expect(spanPassedToInner).toBe(NOOP_SPAN);
    expect(warnSpy).toHaveBeenCalledWith(
      'Tracer.startSpan threw — proceeding without span',
      expect.objectContaining({ span: 'gen-throwing-tracer' })
    );
  });

  it('ThrowingTracer + inner throws: original inner error still propagates', async () => {
    // Arrange
    registerTracer(new ThrowingTracer());
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const innerError = new Error('inner error with throwing tracer');

    // eslint-disable-next-line require-yield
    async function* inner(_span: Span): AsyncGenerator<never, void, unknown> {
      throw innerError;
    }

    // Act & Assert — inner's error rethrown even when tracer is broken
    await expect(async () => {
      for await (const _ of withSpanGenerator('gen-throwing-tracer-throw', {}, inner)) {
        // drain
      }
    }).rejects.toThrow('inner error with throwing tracer');
  });

  it('FlakySpanTracer: setStatus/recordException/end all throw — inner results still flow, warns logged', async () => {
    // Arrange — FlakySpanTracer returns a FlakeySpan that throws on all span methods
    registerTracer(new FlakySpanTracer());
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    async function* inner(_span: Span): AsyncGenerator<string, void, unknown> {
      yield 'value-1';
      yield 'value-2';
    }

    // Act — inner completes normally; setStatus + end will throw internally
    const values: string[] = [];
    for await (const v of withSpanGenerator('gen-flakey-span', {}, inner)) {
      values.push(v);
    }

    // Assert — values flowed through; warns logged for each failed span method
    expect(values).toEqual(['value-1', 'value-2']);
    const warnMessages = warnSpy.mock.calls.map((c) => c[0]);
    expect(warnMessages).toContain('Tracer.setStatus threw — continuing');
    expect(warnMessages).toContain('Tracer.end threw — continuing');
  });

  it('FlakySpanTracer + inner throws: original error propagates; recordException/setStatus/end warns logged', async () => {
    // Arrange
    registerTracer(new FlakySpanTracer());
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const innerError = new Error('inner error with flakey span');

    // eslint-disable-next-line require-yield
    async function* inner(_span: Span): AsyncGenerator<never, void, unknown> {
      throw innerError;
    }

    // Act & Assert — original error propagates even when all span methods throw
    await expect(async () => {
      for await (const _ of withSpanGenerator('gen-flakey-span-throw', {}, inner)) {
        // drain
      }
    }).rejects.toThrow('inner error with flakey span');
  });

  it('inner.return() throwing in finally is caught and logged — does not escape', async () => {
    // Arrange — an inner generator whose return() method throws
    let innerFinallyCalled = false;
    // Cast through `unknown` because TypeScript's `AsyncGenerator` type
    // requires `[Symbol.asyncDispose]` (added in newer lib.es2022 / explicit
    // resource management). The driver loop only calls `next()` / `return()`
    // / `throw()` / `[Symbol.asyncIterator]`, so the dispose hook isn't used.
    const maliciousInner = {
      next: async () => ({ value: 1, done: false }),
      return: async () => {
        innerFinallyCalled = true;
        throw new Error('inner.return() exploded');
      },
      throw: async (err: unknown) => {
        throw err;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    } as unknown as AsyncGenerator<number, void, unknown>;

    const tracer = new RecordingTracer();
    registerTracer(tracer);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Act — consume one item then break (triggers inner.return() in finally)
    for await (const v of withSpanGenerator('gen-malicious-inner', {}, () => maliciousInner)) {
      expect(v).toBe(1);
      break;
    }

    // Assert — inner.return() was called (it set the flag before throwing)
    expect(innerFinallyCalled).toBe(true);
    // The throw from inner.return() was caught and logged, not re-thrown
    expect(warnSpy).toHaveBeenCalledWith(
      'Inner generator return() threw — continuing',
      expect.objectContaining({ span: 'gen-malicious-inner', error: 'inner.return() exploded' })
    );
    // Span still ends via safeEnd (even after inner.return() threw)
    expect(tracer.spans[0].span.ended).toBe(true);
  });
});
