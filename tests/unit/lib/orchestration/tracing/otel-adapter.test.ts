/**
 * Unit tests for the OtelTracer / OtelSpan adapter.
 *
 * Uses a real BasicTracerProvider + InMemorySpanExporter — no network, no mocking
 * of OTEL itself. The point is to verify the actual mapping from Sunrise's
 * vendor-neutral Tracer interface onto the OTEL JS API.
 *
 * SDK notes:
 * - @opentelemetry/sdk-trace-base@2.5.0 — BasicTracerProvider accepts
 *   spanProcessors in its constructor (no addSpanProcessor method in v2).
 * - The OTEL GlobalAPI (trace provider, context manager) is a true singleton:
 *   setGlobalTracerProvider / setGlobalContextManager silently no-op on subsequent
 *   calls after the first registration. These are therefore initialized once in
 *   beforeAll; individual tests use exporter.reset() to isolate spans.
 * - AsyncLocalStorageContextManager must be .enable()d before context propagation
 *   (parent/child) works correctly through async boundaries.
 * - parentSpanContext (not parentSpanId) is the correct ReadableSpan field in
 *   @opentelemetry/sdk-trace-base@2.x.
 *
 * The "missing OTEL dep" failure path in OtelTracer is NOT tested here. It would
 * require deep module-loader mocking for a dep that is always present in this
 * codebase. See Sprint 2 Batch 2.2 notes in the test plan.
 */

import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import * as otelApi from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { beforeAll, beforeEach, afterEach, describe, it, expect } from 'vitest';

import { OtelTracer } from '@/lib/orchestration/tracing/otel-adapter';
import { MAX_ATTRIBUTE_STRING_LENGTH } from '@/lib/orchestration/tracing/attributes';
import { resetTracer, registerTracer } from '@/lib/orchestration/tracing/registry';
import {
  withSpan as withSpanHelper,
  withSpanGenerator,
} from '@/lib/orchestration/tracing/with-span';

// ─── Test infrastructure ────────────────────────────────────────────────────

// Shared exporter — reset between tests. Provider + context manager are
// singletons in the OTEL GlobalAPI and can only be registered once per process.
const exporter = new InMemorySpanExporter();

beforeAll(() => {
  // AsyncLocalStorageContextManager must be enabled before context propagation
  // works through async boundaries (startActiveSpan parent/child).
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  otelApi.context.setGlobalContextManager(contextManager);

  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  otelApi.trace.setGlobalTracerProvider(provider);
});

beforeEach(() => {
  exporter.reset();
  resetTracer(); // Keep Sunrise registry at NOOP — testing OtelTracer directly
});

afterEach(() => {
  resetTracer();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('OtelTracer', () => {
  // Case 1: Construct + happy path
  it('exports a span to the in-memory exporter with correct name, attributes, and OK status', async () => {
    // Arrange
    const otelTracer = new OtelTracer(otelApi, 'test-tracer');
    const attrs = { model: 'gpt-4o', tokens: 100 };

    // Act
    const result = await otelTracer.withSpan('llm.call', { attributes: attrs }, async () => 'ok');

    // Assert — verify the adapter's mapping, not just the function return value
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('llm.call');
    expect(spans[0].attributes).toMatchObject({ model: 'gpt-4o', tokens: 100 });
    expect(spans[0].status.code).toBe(otelApi.SpanStatusCode.OK);
    expect(result).toBe('ok');
  });

  // Case 2: Nested spans → parent/child
  it('produces a parent/child span relationship via startActiveSpan context propagation', async () => {
    // Arrange
    const otelTracer = new OtelTracer(otelApi, 'test-tracer');

    // Act — nested withSpan calls; OtelTracer.withSpan uses startActiveSpan which
    // propagates context through AsyncLocalStorage across awaits.
    await otelTracer.withSpan('workflow.execute', {}, async () => {
      await otelTracer.withSpan('workflow.step', {}, async () => 'inner');
    });

    // Assert — child's parentSpanContext.spanId must equal the parent's spanId.
    // Note: in @opentelemetry/sdk-trace-base@2.x, the ReadableSpan field is
    // `parentSpanContext` (the full context object), not `parentSpanId`.
    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === 'workflow.execute');
    const child = spans.find((s) => s.name === 'workflow.step');

    expect(parent?.status.code).toBe(otelApi.SpanStatusCode.OK);
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  });

  // Case 3: traceId() and spanId() match OTEL spanContext()
  it('returns traceId and spanId strings that match the underlying OTEL spanContext', async () => {
    // Arrange
    const otelTracer = new OtelTracer(otelApi, 'test-tracer');
    let capturedTraceId = '';
    let capturedSpanId = '';

    // Act
    await otelTracer.withSpan('chat.turn', {}, async (span) => {
      capturedTraceId = span.traceId();
      capturedSpanId = span.spanId();
    });

    // Assert — IDs must be non-empty hex strings of OTEL's documented lengths
    // (traceId: 32 hex chars = 128-bit, spanId: 16 hex chars = 64-bit)
    expect(capturedTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(capturedSpanId).toMatch(/^[0-9a-f]{16}$/);

    // And they must match what landed on the exported span
    const spans = exporter.getFinishedSpans();
    expect(capturedTraceId).toBe(spans[0].spanContext().traceId);
    expect(capturedSpanId).toBe(spans[0].spanContext().spanId);
  });

  // Case 4: Throwing fn → ERROR status + recorded exception event
  it('sets ERROR status and records an exception event when the callback throws', async () => {
    // Arrange
    const otelTracer = new OtelTracer(otelApi, 'test-tracer');
    const err = new Error('something went wrong');

    // Act
    await expect(
      otelTracer.withSpan('chat.turn', {}, async () => {
        throw err;
      })
    ).rejects.toThrow('something went wrong');

    // Assert — status code, message, and exception event
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(otelApi.SpanStatusCode.ERROR);
    expect(spans[0].status.message).toBe('something went wrong');

    const exceptionEvent = spans[0].events.find((e) => e.name === 'exception');
    expect(exceptionEvent?.attributes?.['exception.message']).toBe('something went wrong');
  });

  // Case 5: recordException accepts non-Error values
  it('wraps non-Error thrown values in { message: String(error) } for the exception event', async () => {
    // Arrange — throw a raw string (not an Error instance)
    const otelTracer = new OtelTracer(otelApi, 'test-tracer');
    const thrownValue = 'string error thrown directly';

    // Act
    await expect(
      otelTracer.withSpan('chat.turn', {}, async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw thrownValue;
      })
    ).rejects.toBe(thrownValue);

    // Assert — OtelTracer.withSpan calls otelSpan.recordException({ message: String(err) })
    // for non-Error values; the OTEL SDK records this as an exception event with
    // the exception.message attribute set to the stringified value.
    const spans = exporter.getFinishedSpans();
    const exceptionEvent = spans[0].events.find((e) => e.name === 'exception');
    expect(exceptionEvent?.attributes?.['exception.message']).toBe(thrownValue);
  });

  // Case 6: setAttribute(key, undefined) is a no-op
  it('does not forward undefined attribute values to the underlying OTEL span', async () => {
    // Arrange
    const otelTracer = new OtelTracer(otelApi, 'test-tracer');

    // Act
    await otelTracer.withSpan('llm.call', {}, async (span) => {
      span.setAttribute('skipped', undefined);
      span.setAttribute('kept', 'real-value');
    });

    // Assert — 'kept' appears; 'skipped' must not appear at all
    const spans = exporter.getFinishedSpans();
    expect(spans[0].attributes['kept']).toBe('real-value');
    expect(Object.prototype.hasOwnProperty.call(spans[0].attributes, 'skipped')).toBe(false);
  });

  // Cases 6b–6d and 7: helper-integration tests that require OtelTracer in the
  // Sunrise registry. Grouped into a nested describe so registerTracer / resetTracer
  // form a symmetric beforeEach/afterEach pair (per project pattern in
  // otel-engine-trace.test.ts:108-128 and otel-chat-trace.test.ts:311-325).
  describe('with-span.ts helper integration (real provider)', () => {
    let otelTracer: OtelTracer;

    beforeEach(() => {
      otelTracer = new OtelTracer(otelApi, 'test-tracer');
      registerTracer(otelTracer);
    });

    afterEach(() => {
      resetTracer();
    });

    // Case 6b: Parent/child propagation via the with-span.ts helper.
    // Regression guard for the helper bug: the helper used to call
    // getTracer().startSpan() without activating the span as the OTEL context,
    // so nested helper calls produced flat root spans in OTLP backends.
    // It now wraps fn inside getTracer().withActiveContext(span, ...) which
    // calls context.with(setSpan(active(), inner), fn) — restoring AsyncLocalStorage
    // propagation. This test must verify against a real BasicTracerProvider; a
    // unit-style mock could pass without exercising the actual context manager.
    it('helper withSpan establishes parent/child via withActiveContext (real provider)', async () => {
      // Arrange — otelTracer registered in beforeEach

      // Act — nested calls through the public helper
      await withSpanHelper('outer', {}, async () => {
        await withSpanHelper('inner', {}, async () => 'done');
      });

      // Assert — child's parentSpanContext.spanId must equal the outer span's spanId.
      const spans = exporter.getFinishedSpans();
      const outer = spans.find((s) => s.name === 'outer');
      const inner = spans.find((s) => s.name === 'inner');
      expect(outer).toBeDefined();
      expect(inner).toBeDefined();
      expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
    });

    // Case 6c: Parent/child propagation via the with-span.ts generator helper.
    // Regression guard for the manual-span context-propagation gap: spans created
    // inside an async generator's body must see the outer span as their parent
    // even across yields. `withSpanGenerator` drives `inner.next()` inside
    // `tracer.withActiveContext(span, …)` per iteration so AsyncLocalStorage
    // captures the span as the active OTEL context for the synchronous body up
    // to each yield. This test must run against a real BasicTracerProvider — a
    // mock could pass without exercising the actual context manager.
    it('withSpanGenerator establishes parent/child across yields (real provider)', async () => {
      // Arrange — otelTracer registered in beforeEach

      async function* outer(): AsyncGenerator<string, void, unknown> {
        yield 'outer-event-1';
        // Nested helper-withSpan call; expected parent: outer span
        await withSpanHelper('nested-helper', {}, async () => {});
        yield 'outer-event-2';
        // Nested withSpanGenerator call; expected parent: outer span
        yield* withSpanGenerator('nested-gen', {}, async function* (_innerSpan) {
          yield 'inner-event';
        });
        yield 'outer-event-3';
      }

      // Act — drain the generator the same way SSE consumers would
      const events: string[] = [];
      for await (const event of withSpanGenerator('outer', {}, outer)) {
        events.push(event);
      }

      // Assert — events flowed correctly
      expect(events).toEqual(['outer-event-1', 'outer-event-2', 'inner-event', 'outer-event-3']);

      // Span tree: outer (root) → [nested-helper, nested-gen]
      const spans = exporter.getFinishedSpans();
      const outerSpan = spans.find((s) => s.name === 'outer');
      const nestedHelper = spans.find((s) => s.name === 'nested-helper');
      const nestedGen = spans.find((s) => s.name === 'nested-gen');

      expect(outerSpan).toBeDefined();
      expect(nestedHelper).toBeDefined();
      expect(nestedGen).toBeDefined();

      expect(nestedHelper?.parentSpanContext?.spanId).toBe(outerSpan?.spanContext().spanId);
      expect(nestedGen?.parentSpanContext?.spanId).toBe(outerSpan?.spanContext().spanId);

      // All three share the outer's traceId — proves single-trace correlation
      expect(nestedHelper?.spanContext().traceId).toBe(outerSpan?.spanContext().traceId);
      expect(nestedGen?.spanContext().traceId).toBe(outerSpan?.spanContext().traceId);
    });

    // Case 6d: withSpanGenerator with manualStatus=true defers status setting
    // to the inner generator. Verifies the inner can mark error status without
    // throwing (the engine's `singleResult.failed` and chat handler's
    // `chatSpanError` paths rely on this).
    it('withSpanGenerator manualStatus=true lets inner control status without throwing', async () => {
      // Arrange — otelTracer registered in beforeEach

      // Act — inner sets error status manually then returns normally
      await (async () => {
        for await (const _ of withSpanGenerator(
          'manual-status-span',
          {},
          async function* (span) {
            span.setStatus({ code: 'error', message: 'inner-marked-error' });
            yield 'event';
          },
          { manualStatus: true }
        )) {
          // drain
        }
      })();

      // Assert — span ended with error status (helper did NOT overwrite to ok)
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].status.code).toBe(otelApi.SpanStatusCode.ERROR);
      expect(spans[0].status.message).toBe('inner-marked-error');
    });

    // Case 7: Long string attributes are truncated by withSpan (regression guard)
    it('truncates string attributes longer than MAX_ATTRIBUTE_STRING_LENGTH before forwarding to the exporter', async () => {
      // Arrange — a prompt that exceeds the 1024-char cap.
      // Truncation lives in with-span.ts's truncateAttributes. This test verifies
      // the integration between with-span.ts and OtelTracer: with-span.ts truncates
      // the attribute before passing it to OtelTracer.startSpan, and the truncated
      // value must actually reach the OTEL exporter correctly.
      // We go through with-span.ts's withSpan (not OtelTracer.withSpan directly)
      // because that is where truncation happens in production code.
      const longPrompt = 'x'.repeat(MAX_ATTRIBUTE_STRING_LENGTH + 500);

      // Act — withSpanHelper uses getTracer() from registry, which is OtelTracer
      await withSpanHelper('llm.call', { prompt: longPrompt }, async () => {});

      // Assert — exported attribute length must be exactly MAX_ATTRIBUTE_STRING_LENGTH
      const spans = exporter.getFinishedSpans();
      const promptValue = spans[0].attributes['prompt'];
      expect(typeof promptValue).toBe('string');
      expect((promptValue as string).length).toBe(MAX_ATTRIBUTE_STRING_LENGTH);
    });
  });

  // Case 8: mapKind covers every literal
  describe('mapKind', () => {
    const kindCases: Array<[import('@/lib/orchestration/tracing/tracer').SpanKind, number]> = [
      ['INTERNAL', otelApi.SpanKind.INTERNAL],
      ['CLIENT', otelApi.SpanKind.CLIENT],
      ['SERVER', otelApi.SpanKind.SERVER],
      ['PRODUCER', otelApi.SpanKind.PRODUCER],
      ['CONSUMER', otelApi.SpanKind.CONSUMER],
    ];

    for (const [sunriseKind, expectedOtelKind] of kindCases) {
      it(`maps SpanKind '${sunriseKind}' to OTEL SpanKind ${expectedOtelKind} (${otelApi.SpanKind[expectedOtelKind]})`, () => {
        // Arrange
        const otelTracer = new OtelTracer(otelApi, 'test-tracer');

        // Act — use startSpan (not withSpan) to test kind mapping directly
        const span = otelTracer.startSpan('test', { kind: sunriseKind });
        span.end();

        // Assert — the exported span's kind numeric value matches the OTEL enum
        const spans = exporter.getFinishedSpans();
        expect(spans[0].kind).toBe(expectedOtelKind);
        // Exporter isolation is handled by the module-level beforeEach; no reset needed here.
      });
    }
  });

  // Case 9: mapStatus covers every literal
  // withSpan always overrides the final status on the OTEL span, so we exercise
  // mapStatus directly via startSpan + OtelSpan.setStatus() + end(). This tests
  // the mapping in isolation without fighting the withSpan lifecycle.
  describe('mapStatus', () => {
    it("maps status code 'ok' to SpanStatusCode.OK", () => {
      // Arrange
      const otelTracer = new OtelTracer(otelApi, 'test-tracer');

      // Act
      const span = otelTracer.startSpan('test-ok', {});
      span.setStatus({ code: 'ok', message: 'all good' });
      span.end();

      // Assert
      const spans = exporter.getFinishedSpans();
      expect(spans[0].status.code).toBe(otelApi.SpanStatusCode.OK);
      expect(spans[0].status.message).toBe('all good');
    });

    it("maps status code 'error' to SpanStatusCode.ERROR", () => {
      // Arrange
      const otelTracer = new OtelTracer(otelApi, 'test-tracer');

      // Act
      const span = otelTracer.startSpan('test-error', {});
      span.setStatus({ code: 'error', message: 'something failed' });
      span.end();

      // Assert
      const spans = exporter.getFinishedSpans();
      expect(spans[0].status.code).toBe(otelApi.SpanStatusCode.ERROR);
      expect(spans[0].status.message).toBe('something failed');
    });

    it("maps status code 'unset' to SpanStatusCode.UNSET", () => {
      // Arrange
      const otelTracer = new OtelTracer(otelApi, 'test-tracer');

      // Act — default OTEL status is UNSET; explicitly set it to verify the mapping
      const span = otelTracer.startSpan('test-unset', {});
      span.setStatus({ code: 'unset' });
      span.end();

      // Assert
      const spans = exporter.getFinishedSpans();
      expect(spans[0].status.code).toBe(otelApi.SpanStatusCode.UNSET);
    });

    // Finding 15: mapStatus 'error' with no message — the cond-expr at L58 false-arm
    // (no message field) was previously uncovered. Existing 'error' test always
    // supplied status.message; this one exercises the omitted-message branch.
    it("maps status code 'error' with no message to SpanStatusCode.ERROR and omits the message field", () => {
      // Arrange
      const otelTracer = new OtelTracer(otelApi, 'test-tracer');

      // Act — omit the optional message field
      const span = otelTracer.startSpan('test-error-no-msg', {});
      span.setStatus({ code: 'error' });
      span.end();

      // Assert — status code is ERROR; message is absent (undefined) on the span
      const spans = exporter.getFinishedSpans();
      expect(spans[0].status.code).toBe(otelApi.SpanStatusCode.ERROR);
      expect(spans[0].status.message).toBeUndefined();
    });
  });

  // Case 10: OtelSpan.setAttributes() — verifies dropUndefined inside setAttributes
  // (anonymous_6 at otel-adapter.ts:92-95, previously 0 hits)
  describe('OtelSpan.setAttributes', () => {
    it('forwards defined attributes to the OTEL span and drops keys with undefined values', async () => {
      // Arrange
      const otelTracer = new OtelTracer(otelApi, 'test-tracer');

      // Act — set multiple attributes via startSpan to get an OtelSpan, then call setAttributes
      await otelTracer.withSpan('attr-test', {}, async (span) => {
        // setAttributes is the batch variant; it calls dropUndefined internally
        span.setAttributes({ key: 'val', skip: undefined });
      });

      // Assert — 'key' lands on the exported span; 'skip' must not appear
      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes['key']).toBe('val');
      expect(Object.prototype.hasOwnProperty.call(spans[0].attributes, 'skip')).toBe(false);
    });
  });

  // Case 11: OtelSpan.recordException() — both arms (Error instance and non-Error)
  // were uncovered because existing tests threw inside withSpan callbacks,
  // which the OTEL SDK records via its own internals rather than OtelSpan.recordException().
  // Calling recordException() directly on a startSpan-obtained span exercises the
  // Sunrise wrapper's two branches at otel-adapter.ts:101-107.
  describe('OtelSpan.recordException', () => {
    it('records an Error instance as an OTEL exception event', () => {
      // Arrange
      const otelTracer = new OtelTracer(otelApi, 'test-tracer');
      const err = new Error('record-exception-error');

      // Act — call recordException directly (not via a throwing callback)
      const span = otelTracer.startSpan('rec-err', {});
      span.recordException(err);
      span.end();

      // Assert — an exception event with the correct message is present
      const spans = exporter.getFinishedSpans();
      const exceptionEvent = spans[0].events.find((e) => e.name === 'exception');
      expect(exceptionEvent?.attributes?.['exception.message']).toBe('record-exception-error');
    });

    it('wraps a plain string in { message: String(error) } for the exception event', () => {
      // Arrange
      const otelTracer = new OtelTracer(otelApi, 'test-tracer');

      // Act — non-Error value exercises the else-branch at otel-adapter.ts:105
      const span = otelTracer.startSpan('rec-plain', {});
      span.recordException('plain string error');
      span.end();

      // Assert — the exception event's message is the stringified value
      const spans = exporter.getFinishedSpans();
      const exceptionEvent = spans[0].events.find((e) => e.name === 'exception');
      expect(exceptionEvent?.attributes?.['exception.message']).toBe('plain string error');
    });
  });

  // Case 12: withActiveContext fallback — if span is NOT an OtelSpan instance
  // (e.g. NOOP_SPAN from a different tracer), fn() is called directly without
  // OTEL context wrapping (the `if (!(span instanceof OtelSpan)) return fn()` guard
  // at otel-adapter.ts:175 was previously uncovered).
  describe('OtelTracer.withActiveContext — non-OtelSpan fallback', () => {
    it('invokes fn and returns its value when the span is not an OtelSpan instance', async () => {
      // Arrange — import NOOP_SPAN which is not an OtelSpan instance
      const { NOOP_SPAN } = await import('@/lib/orchestration/tracing/noop-tracer');
      const otelTracer = new OtelTracer(otelApi, 'test-tracer');
      const expectedValue = { result: 'fallback-ran' };

      // Act — pass NOOP_SPAN (non-OtelSpan) to withActiveContext; fn must still run
      const result = await otelTracer.withActiveContext(NOOP_SPAN, async () => expectedValue);

      // Assert — fn ran and its value was returned; no throw, no wrapping
      expect(result).toBe(expectedValue);
    });
  });
});
