/**
 * MockTracer — in-memory Tracer implementation for integration tests.
 *
 * Records every span into a `spans` array so tests can assert on the exact
 * span tree produced by the orchestration layer.
 *
 * Key design decisions:
 * - IDs are deterministic counters rather than UUIDs so tests can assert
 *   exact values (e.g. `'span-1'`) without any string-matching tricks.
 * - Parent tracking uses Node's `AsyncLocalStorage` so context forks per
 *   Promise — sibling parallel branches each see the same outer parent
 *   without entanglement, matching the real `OtelTracer` behaviour.
 * - `startSpan` reads the current ALS store; `withSpan` and
 *   `withActiveContext` set it for the duration of `fn`.
 * - `reset()` clears `spans` AND the counter so every test starts from a
 *   clean, predictable baseline. Call it in `beforeEach`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  NOOP_SPAN,
  type Span,
  type SpanAttributes,
  type SpanStatus,
  type SpanStatusCode,
  type StartSpanOptions,
  type Tracer,
} from '@/lib/orchestration/tracing';

// ---------------------------------------------------------------------------
// RecordedSpan — the shape stored in MockTracer.spans
// ---------------------------------------------------------------------------

export interface RecordedSpan {
  name: string;
  attributes: SpanAttributes;
  status: SpanStatus | null;
  exceptions: unknown[];
  ended: boolean;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  /** Performance.now() value at span start — used for sibling ordering in assertSpanTree. */
  startTime: number;
  endTime: number | null;
}

// ---------------------------------------------------------------------------
// ExpectedSpan — declarative tree shape for assertSpanTree
// ---------------------------------------------------------------------------

export interface ExpectedSpan {
  name: string;
  attributes?: Partial<SpanAttributes>;
  status?: SpanStatusCode;
  children?: ExpectedSpan[];
}

// ---------------------------------------------------------------------------
// MockSpan — the live Span object returned by MockTracer.startSpan
// ---------------------------------------------------------------------------

class MockSpan implements Span {
  private readonly _recorded: RecordedSpan;

  constructor(recorded: RecordedSpan) {
    this._recorded = recorded;
  }

  setAttribute(key: string, value: SpanAttributes[string]): void {
    this._recorded.attributes[key] = value;
  }

  setAttributes(attrs: SpanAttributes): void {
    for (const [key, value] of Object.entries(attrs)) {
      this._recorded.attributes[key] = value;
    }
  }

  setStatus(status: SpanStatus): void {
    this._recorded.status = status;
  }

  recordException(error: unknown): void {
    this._recorded.exceptions.push(error);
  }

  end(): void {
    this._recorded.ended = true;
    this._recorded.endTime = performance.now();
  }

  traceId(): string {
    return this._recorded.traceId;
  }

  spanId(): string {
    return this._recorded.spanId;
  }
}

// ---------------------------------------------------------------------------
// MockTracer
// ---------------------------------------------------------------------------

export class MockTracer implements Tracer {
  readonly spans: RecordedSpan[] = [];

  /** Monotonically increasing counter; reset by reset(). */
  private _spanCounter = 0;

  /**
   * Per-async-chain active span. Mirrors `OtelTracer`'s
   * `AsyncLocalStorageContextManager` so concurrent branches (e.g.
   * `Promise.all` over `withSpan` callbacks) each see their own outer parent
   * without entanglement.
   */
  private readonly _activeContext = new AsyncLocalStorage<RecordedSpan>();

  /**
   * NOTE — deterministic-but-non-isolating traceId assignment:
   * MockTracer assigns `'trace-1'` to every root span for assertion convenience —
   * this is a deterministic constant, not a real propagated trace context. Tests that
   * need true trace-context isolation (e.g. asserting two spans share a real propagated
   * traceId vs. independently producing 'trace-1') must use the OTEL adapter against
   * `BasicTracerProvider` — see `tests/unit/lib/orchestration/tracing/otel-adapter.test.ts`.
   */
  private _nextId(): { traceId: string; spanId: string } {
    this._spanCounter += 1;
    const spanId = `span-${this._spanCounter}`;
    const parent = this._activeContext.getStore() ?? null;
    const traceId = parent ? parent.traceId : 'trace-1';
    return { traceId, spanId };
  }

  startSpan(name: string, options?: StartSpanOptions): Span {
    const { traceId, spanId } = this._nextId();
    const parent = this._activeContext.getStore() ?? null;

    const recorded: RecordedSpan = {
      name,
      attributes: { ...(options?.attributes ?? {}) },
      status: null,
      exceptions: [],
      ended: false,
      traceId,
      spanId,
      parentSpanId: parent ? parent.spanId : null,
      startTime: performance.now(),
      endTime: null,
    };

    this.spans.push(recorded);
    return new MockSpan(recorded);
  }

  async withSpan<T>(
    name: string,
    options: StartSpanOptions,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    // Open the span; this call reads the ALS store for parent linkage.
    const span = this.startSpan(name, options);
    const recorded = this.spans[this.spans.length - 1];

    // Run the callback with this span set as the active context, so any
    // nested startSpan / withSpan / withActiveContext calls see it as
    // parent. AsyncLocalStorage forks per Promise — concurrent branches
    // each see the outer parent rather than each other.
    return this._activeContext.run(recorded, async () => {
      try {
        const result = await fn(span);
        span.setStatus({ code: 'ok' });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'error';
        span.setStatus({ code: 'error', message });
        span.recordException(err);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async withActiveContext<T>(span: Span, fn: () => Promise<T>): Promise<T> {
    // Find the RecordedSpan that corresponds to this Span by spanId so nested
    // startSpan calls see it as their parent. If the span is foreign (e.g. a
    // NOOP_SPAN passed in), fall through and just run fn.
    const recorded = this.spans.find((s) => s.spanId === span.spanId());
    if (!recorded) return fn();
    return this._activeContext.run(recorded, fn);
  }

  /** Clear all recorded spans and reset the span counter. Call in beforeEach. */
  reset(): void {
    this.spans.length = 0;
    this._spanCounter = 0;
    // No need to clear _activeContext — ALS is request-scoped.
  }
}

// ---------------------------------------------------------------------------
// ThrowingTracer
//
// startSpan throws unconditionally; withSpan falls back to NOOP_SPAN
// (mirrors the with-span.ts fallback path) so the wrapped code still runs.
// ---------------------------------------------------------------------------

export class ThrowingTracer implements Tracer {
  startSpan(): Span {
    throw new Error('mock tracer broken');
  }

  /**
   * NOTE — this models the with-span.ts fallback path (NOOP_SPAN after startSpan throws),
   * not a real OTEL withSpan. Tests that need to exercise the startSpan throw path should
   * call `getTracer().startSpan(...)` directly rather than `withSpan(...)`, since withSpan
   * here bypasses the throw and invokes fn(NOOP_SPAN) directly.
   */
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
// assertSpanTree
// ---------------------------------------------------------------------------

/**
 * Assert that the recorded spans form the expected tree.
 *
 * - Picks the single root span (parentSpanId === null).
 * - Walks expected vs actual recursively; children are sorted by startTime
 *   so sibling ordering in the expected tree is flexible.
 * - Attribute assertions are "contains all expected keys"; extra actual
 *   attributes are silently ignored.
 * - Throws a descriptive Error on any mismatch so test failure output is
 *   operator-readable without --verbose.
 */
export function assertSpanTree(spans: RecordedSpan[], expected: ExpectedSpan): void {
  const roots = spans.filter((s) => s.parentSpanId === null);

  if (roots.length !== 1) {
    throw new Error(
      `assertSpanTree: expected exactly 1 root span but found ${roots.length}. ` +
        `All span names: [${spans.map((s) => s.name).join(', ')}]`
    );
  }

  const root = roots[0];
  assertSpanNode(spans, root, expected, []);
}

function assertSpanNode(
  allSpans: RecordedSpan[],
  actual: RecordedSpan,
  expected: ExpectedSpan,
  path: string[]
): void {
  const location = [...path, actual.name].join(' > ');

  // Name check
  if (actual.name !== expected.name) {
    throw new Error(
      `assertSpanTree at [${location}]: ` +
        `expected span name '${expected.name}' but got '${actual.name}'`
    );
  }

  // Attribute check (subset — extra actual attributes are fine)
  if (expected.attributes !== undefined) {
    for (const [key, expectedValue] of Object.entries(expected.attributes)) {
      const actualValue = actual.attributes[key];
      if (actualValue !== expectedValue) {
        throw new Error(
          `assertSpanTree at [${location}]: ` +
            `attribute '${key}' expected '${String(expectedValue)}' but got '${String(actualValue)}'`
        );
      }
    }
  }

  // Status check
  if (expected.status !== undefined) {
    const actualCode = actual.status?.code ?? 'unset';
    if (actualCode !== expected.status) {
      throw new Error(
        `assertSpanTree at [${location}]: ` +
          `status expected '${expected.status}' but got '${actualCode}'`
      );
    }
  }

  // Children check
  if (expected.children !== undefined) {
    const actualChildren = allSpans
      .filter((s) => s.parentSpanId === actual.spanId)
      .sort((a, b) => a.startTime - b.startTime);

    if (actualChildren.length !== expected.children.length) {
      const childNames = actualChildren.map((c) => c.name);
      throw new Error(
        `assertSpanTree at [${location}]: ` +
          `expected ${expected.children.length} children but got ${actualChildren.length}: ` +
          `[${childNames.join(', ')}]`
      );
    }

    for (let i = 0; i < expected.children.length; i += 1) {
      const expectedChild = expected.children[i];
      const actualChild = actualChildren[i];
      assertSpanNode(allSpans, actualChild, expectedChild, [...path, actual.name]);
    }
  }
}

// ---------------------------------------------------------------------------
// findSpan
// ---------------------------------------------------------------------------

/**
 * Return the first span matching `name` (and optional attribute predicate).
 * Throws with a diagnostic list of all recorded span names if not found.
 */
export function findSpan(
  spans: RecordedSpan[],
  name: string,
  attributesPredicate?: (attrs: SpanAttributes) => boolean
): RecordedSpan {
  const match = spans.find(
    (s) =>
      s.name === name && (attributesPredicate === undefined || attributesPredicate(s.attributes))
  );

  if (match === undefined) {
    const recorded = spans.map((s) => s.name).join(', ');
    throw new Error(`Span not found: '${name}'. Recorded spans: [${recorded || '(none)'}]`);
  }

  return match;
}
