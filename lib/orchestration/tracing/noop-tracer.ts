import type {
  Span,
  SpanAttributes,
  SpanStatus,
  StartSpanOptions,
  Tracer,
} from '@/lib/orchestration/tracing/tracer';

class NoopSpan implements Span {
  setAttribute(_key: string, _value: unknown): void {}
  setAttributes(_attrs: SpanAttributes): void {}
  setStatus(_status: SpanStatus): void {}
  recordException(_error: unknown): void {}
  end(): void {}
  traceId(): string {
    return '';
  }
  spanId(): string {
    return '';
  }
}

/**
 * Singleton no-op span. Returned by `NoopTracer.startSpan()` and used as the
 * fallback when the active tracer throws on `startSpan`.
 */
export const NOOP_SPAN: Span = new NoopSpan();

class NoopTracerImpl implements Tracer {
  startSpan(_name: string, _options?: StartSpanOptions): Span {
    return NOOP_SPAN;
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

/**
 * Default tracer. Zero allocations on the hot path — `startSpan` always
 * returns the singleton `NOOP_SPAN` and every `Span` method is empty.
 */
export const NOOP_TRACER: Tracer = new NoopTracerImpl();
