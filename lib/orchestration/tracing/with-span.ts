import { logger } from '@/lib/logging';
import { MAX_ATTRIBUTE_STRING_LENGTH } from '@/lib/orchestration/tracing/attributes';
import { NOOP_SPAN } from '@/lib/orchestration/tracing/noop-tracer';
import { getTracer } from '@/lib/orchestration/tracing/registry';
import type {
  Span,
  SpanAttributeValue,
  SpanAttributes,
  SpanStatus,
  StartSpanOptions,
} from '@/lib/orchestration/tracing/tracer';

/**
 * Truncate a string attribute to `MAX_ATTRIBUTE_STRING_LENGTH` to defend
 * against megabyte-sized prompts blowing OTEL exporter buffers.
 */
export function truncateAttribute(value: SpanAttributeValue): SpanAttributeValue {
  if (typeof value !== 'string') return value;
  if (value.length <= MAX_ATTRIBUTE_STRING_LENGTH) return value;
  return value.slice(0, MAX_ATTRIBUTE_STRING_LENGTH);
}

function truncateAttributes(attrs: SpanAttributes | undefined): SpanAttributes | undefined {
  if (!attrs) return attrs;
  const out: SpanAttributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[key] = truncateAttribute(value);
  }
  return out;
}

function safeSetStatus(span: Span, status: SpanStatus, spanName: string): void {
  try {
    span.setStatus(status);
  } catch (err) {
    logger.warn('Tracer.setStatus threw — continuing', {
      span: spanName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function safeRecordException(span: Span, error: unknown, spanName: string): void {
  try {
    span.recordException(error);
  } catch (err) {
    logger.warn('Tracer.recordException threw — continuing', {
      span: spanName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function safeEnd(span: Span, spanName: string): void {
  try {
    span.end();
  } catch (err) {
    logger.warn('Tracer.end threw — continuing', {
      span: spanName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Run `fn` inside a span. The single point of exception safety for all
 * orchestration tracing — every wrap goes through this helper so a
 * tracer-throwing-aborts-orchestration regression is structurally impossible.
 *
 * Behaviour:
 * - `startSpan` failure → fall back to `NOOP_SPAN`; warn once; `fn` still runs.
 * - `fn` succeeds → span status `ok`; span ends.
 * - `fn` throws → span status `error`; exception recorded (unless opted out);
 *   span ends; original error is rethrown.
 * - `setStatus`/`recordException`/`end` failure → warn; original `fn` result
 *   or thrown error is preserved.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T>,
  opts?: { kind?: StartSpanOptions['kind']; recordException?: boolean; manualStatus?: boolean }
): Promise<T> {
  const truncated = truncateAttributes(attributes);
  const tracer = getTracer();
  let span: Span;
  try {
    span = tracer.startSpan(name, { attributes: truncated, kind: opts?.kind ?? 'INTERNAL' });
  } catch (tracerErr) {
    logger.warn('Tracer.startSpan threw — proceeding without span', {
      span: name,
      error: tracerErr instanceof Error ? tracerErr.message : String(tracerErr),
    });
    return fn(NOOP_SPAN);
  }

  // Activate `span` as the OTEL context so any nested `withSpan` calls
  // (or direct OTEL `startSpan` calls) see it as their parent. No-op for
  // tracers without async-context support (e.g. NoopTracer).
  return tracer.withActiveContext(span, async () => {
    try {
      const result = await fn(span);
      if (!opts?.manualStatus) safeSetStatus(span, { code: 'ok' }, name);
      return result;
    } catch (err) {
      if (!opts?.manualStatus) {
        const message = err instanceof Error ? err.message : 'error';
        safeSetStatus(span, { code: 'error', message }, name);
      }
      if (opts?.recordException !== false) safeRecordException(span, err, name);
      throw err;
    } finally {
      safeEnd(span, name);
    }
  });
}

/**
 * Manual span lifecycle. Use only where `withSpan`'s callback shape doesn't
 * compose — currently the orchestration engine's async-generator `execute()`
 * body. Returns a `{ span, end }` pair. The caller is responsible for calling
 * `end` exactly once; failure is logged but not rethrown.
 *
 * Prefer `withSpan` everywhere else.
 */
export function startManualSpan(
  name: string,
  attributes: SpanAttributes,
  opts?: { kind?: StartSpanOptions['kind'] }
): { span: Span; end: (status: SpanStatus, error?: unknown) => void } {
  const truncated = truncateAttributes(attributes);
  let span: Span;
  try {
    span = getTracer().startSpan(name, { attributes: truncated, kind: opts?.kind ?? 'INTERNAL' });
  } catch (tracerErr) {
    logger.warn('Tracer.startSpan threw — proceeding without span', {
      span: name,
      error: tracerErr instanceof Error ? tracerErr.message : String(tracerErr),
    });
    span = NOOP_SPAN;
  }

  return {
    span,
    end: (status, error) => {
      safeSetStatus(span, status, name);
      if (status.code === 'error' && error !== undefined) safeRecordException(span, error, name);
      safeEnd(span, name);
    },
  };
}

/**
 * Set attributes on an active span, applying the same truncation as `withSpan`.
 * Tracer failures are logged at warn and swallowed — never rethrown to the caller.
 */
export function setSpanAttributes(span: Span, attrs: SpanAttributes): void {
  try {
    span.setAttributes(truncateAttributes(attrs) ?? {});
  } catch (err) {
    logger.warn('Tracer.setAttributes threw — continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Set status on a span. Tracer failures are logged at warn and swallowed —
 * never rethrown to the caller. Use this from callers driving
 * `withSpanGenerator(..., { manualStatus: true })` to set the inner span's
 * success/error status without depending on uncaught throws.
 */
export function setSpanStatus(span: Span, status: SpanStatus): void {
  try {
    span.setStatus(status);
  } catch (err) {
    logger.warn('Tracer.setStatus threw — continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record an exception on a span. Tracer failures are logged at warn and
 * swallowed — never rethrown to the caller. Use this from callers running
 * with `manualStatus: true` that swallow an error in the inner generator
 * (e.g. a recoverable provider failover) but still want the failed span
 * to carry the exception in OTLP backends.
 */
export function recordSpanException(span: Span, error: unknown): void {
  try {
    span.recordException(error);
  } catch (err) {
    logger.warn('Tracer.recordException threw — continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Run an inner async generator inside a span, propagating OTEL active context
 * across each yield so nested spans (helper-`withSpan` or further
 * `withSpanGenerator` calls) become children of this span.
 *
 * Use in async-generator-shaped callers where `withSpan`'s callback shape
 * doesn't compose with `yield` — the orchestration engine's `execute()`,
 * the streaming chat handler's `run()`, and any per-iteration LLM call.
 *
 * The helper drives `inner.next()` per iteration inside
 * `tracer.withActiveContext(span, …)`, so AsyncLocalStorage captures the span
 * as the active OTEL context for the synchronous body up to each yield.
 * V8's `await` resumption preserves the captured store, so nested
 * `tracer.startSpan(…)` calls between yields see this span as their parent.
 *
 * Behaviour:
 * - `tracer.startSpan` failure → log warn, fall back to `NOOP_SPAN`; inner
 *   generator still runs (without active-context wrap).
 * - Inner returns normally → set `ok` status (skip if `manualStatus`); return
 *   the inner's return value so `yield*` callers receive it.
 * - Inner throws → set `error` status (skip if `manualStatus`),
 *   `safeRecordException`, rethrow.
 * - Consumer breaks early → `inner.return(undefined as R)` is called in the
 *   `finally` to release inner-side resources, mirroring `yield*` desugaring.
 * - Always `safeEnd(span)`.
 *
 * `manualStatus: true` lets the inner generator set its own success/error
 * status via `safeSetStatus(span, …)` — useful when the workflow outcome
 * (e.g. `singleResult.failed`) determines status without the inner throwing.
 * `safeRecordException` is still called on uncaught throws regardless.
 */
export async function* withSpanGenerator<T, R = void>(
  name: string,
  attributes: SpanAttributes,
  innerGenFn: (span: Span) => AsyncGenerator<T, R, unknown>,
  opts?: { kind?: StartSpanOptions['kind']; manualStatus?: boolean }
): AsyncGenerator<T, R, unknown> {
  const truncated = truncateAttributes(attributes);
  const tracer = getTracer();
  let span: Span;
  try {
    span = tracer.startSpan(name, { attributes: truncated, kind: opts?.kind ?? 'INTERNAL' });
  } catch (tracerErr) {
    logger.warn('Tracer.startSpan threw — proceeding without span', {
      span: name,
      error: tracerErr instanceof Error ? tracerErr.message : String(tracerErr),
    });
    span = NOOP_SPAN;
  }

  const inner = innerGenFn(span);
  const skipActiveContext = span === NOOP_SPAN;
  try {
    while (true) {
      const result = skipActiveContext
        ? await inner.next()
        : await tracer.withActiveContext(span, () => inner.next());
      if (result.done) {
        if (!opts?.manualStatus) safeSetStatus(span, { code: 'ok' }, name);
        return result.value;
      }
      yield result.value;
    }
  } catch (err) {
    if (!opts?.manualStatus) {
      const message = err instanceof Error ? err.message : 'error';
      safeSetStatus(span, { code: 'error', message }, name);
    }
    safeRecordException(span, err, name);
    throw err;
  } finally {
    // Always signal `return()` to the inner so its try/finally runs on every
    // exit path — normal completion, helper-caught throw, consumer break,
    // *and* consumer.throw(). Mirrors `yield*` desugaring; safe to call on an
    // already-finished generator (the runtime treats it as a no-op).
    try {
      await inner.return(undefined as R);
    } catch (returnErr) {
      logger.warn('Inner generator return() threw — continuing', {
        span: name,
        error: returnErr instanceof Error ? returnErr.message : String(returnErr),
      });
    }
    safeEnd(span, name);
  }
}
