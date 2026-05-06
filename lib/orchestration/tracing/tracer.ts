/**
 * Tracer interface — vendor-neutral tracing primitive for the orchestration layer.
 *
 * Implementations must never throw from any method. Callers go through
 * `withSpan` (see `with-span.ts`) which enforces exception safety, but
 * direct callers must still treat tracer failures as non-fatal.
 *
 * The default registered tracer is a no-op (see `noop-tracer.ts`). Forks
 * opt into real tracing by calling `registerOtelTracer()` from
 * `otel-bootstrap.ts` after starting their own OpenTelemetry `TracerProvider`.
 */

export type SpanAttributeValue = string | number | boolean | undefined;

export type SpanAttributes = Record<string, SpanAttributeValue>;

export type SpanStatusCode = 'ok' | 'error' | 'unset';

export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

export type SpanKind = 'INTERNAL' | 'CLIENT' | 'SERVER' | 'PRODUCER' | 'CONSUMER';

export interface StartSpanOptions {
  attributes?: SpanAttributes;
  kind?: SpanKind;
}

export interface Span {
  setAttribute(key: string, value: SpanAttributeValue): void;
  setAttributes(attrs: SpanAttributes): void;
  setStatus(status: SpanStatus): void;
  recordException(error: unknown): void;
  end(): void;
  /** Trace ID for correlation with external systems (e.g. AiCostLog). Empty string for no-op spans. */
  traceId(): string;
  /** Span ID for correlation with external systems. Empty string for no-op spans. */
  spanId(): string;
}

export interface Tracer {
  /**
   * Start a span. Implementations must never throw — the wrapper helpers in
   * `with-span.ts` rely on this contract to keep instrumentation safe.
   */
  startSpan(name: string, options?: StartSpanOptions): Span;

  /**
   * Run `fn` inside a span. The span becomes the active context for the
   * duration of `fn`. Implementations propagate context across awaits using
   * `AsyncLocalStorage` (OTEL adapter) or a no-op (default).
   */
  withSpan<T>(name: string, options: StartSpanOptions, fn: (span: Span) => Promise<T>): Promise<T>;

  /**
   * Run `fn` with `span` as the active OTEL context. Used by `with-span.ts`'s
   * `withSpan` helper (which manages span lifecycle directly) so nested span
   * creation sees the outer span as their parent. No-op for tracers without
   * async-context support.
   */
  withActiveContext<T>(span: Span, fn: () => Promise<T>): Promise<T>;
}
