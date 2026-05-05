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
  opts?: { kind?: StartSpanOptions['kind']; recordException?: boolean }
): Promise<T> {
  const truncated = truncateAttributes(attributes);
  let span: Span;
  try {
    span = getTracer().startSpan(name, { attributes: truncated, kind: opts?.kind ?? 'INTERNAL' });
  } catch (tracerErr) {
    logger.warn('Tracer.startSpan threw — proceeding without span', {
      span: name,
      error: tracerErr instanceof Error ? tracerErr.message : String(tracerErr),
    });
    return fn(NOOP_SPAN);
  }

  try {
    const result = await fn(span);
    safeSetStatus(span, { code: 'ok' }, name);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'error';
    safeSetStatus(span, { code: 'error', message }, name);
    if (opts?.recordException !== false) safeRecordException(span, err, name);
    throw err;
  } finally {
    safeEnd(span, name);
  }
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
