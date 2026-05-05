/**
 * OpenTelemetry adapter for the orchestration `Tracer` interface.
 *
 * Maps Sunrise's vendor-neutral span shape onto the OTEL JS API.
 * `@opentelemetry/api` is an optional/peer dependency — this file is
 * compiled but only loaded when `registerOtelTracer()` is called from
 * the bootstrap helper, which has its own runtime guard.
 *
 * The adapter never decides where spans go: forks construct their own
 * `TracerProvider` (e.g. via `@opentelemetry/sdk-node` with an OTLP
 * exporter) and pass it in. Sampling, batch export, and resource
 * attribution are all the fork's responsibility.
 *
 * Type-only imports of `@opentelemetry/api` keep this file safe to
 * compile in environments where the peer dep is not installed.
 */

import type * as Otel from '@opentelemetry/api';

import type {
  Span,
  SpanAttributeValue,
  SpanAttributes,
  SpanKind,
  SpanStatus,
  StartSpanOptions,
  Tracer,
} from '@/lib/orchestration/tracing/tracer';

type OtelModule = typeof Otel;

function mapKind(otel: OtelModule, kind: SpanKind | undefined): Otel.SpanKind {
  switch (kind) {
    case 'CLIENT':
      return otel.SpanKind.CLIENT;
    case 'SERVER':
      return otel.SpanKind.SERVER;
    case 'PRODUCER':
      return otel.SpanKind.PRODUCER;
    case 'CONSUMER':
      return otel.SpanKind.CONSUMER;
    case 'INTERNAL':
    default:
      return otel.SpanKind.INTERNAL;
  }
}

function mapStatus(otel: OtelModule, status: SpanStatus): Otel.SpanStatus {
  switch (status.code) {
    case 'ok':
      return {
        code: otel.SpanStatusCode.OK,
        ...(status.message ? { message: status.message } : {}),
      };
    case 'error':
      return {
        code: otel.SpanStatusCode.ERROR,
        ...(status.message ? { message: status.message } : {}),
      };
    case 'unset':
    default:
      return { code: otel.SpanStatusCode.UNSET };
  }
}

function dropUndefined(attrs: SpanAttributes | undefined): Otel.Attributes | undefined {
  if (!attrs) return undefined;
  const out: Otel.Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) out[key] = value as Otel.AttributeValue;
  }
  return out;
}

class OtelSpan implements Span {
  constructor(
    private readonly otel: OtelModule,
    private readonly inner: Otel.Span
  ) {}

  setAttribute(key: string, value: SpanAttributeValue): void {
    if (value === undefined) return;
    this.inner.setAttribute(key, value as Otel.AttributeValue);
  }

  setAttributes(attrs: SpanAttributes): void {
    const cleaned = dropUndefined(attrs);
    if (cleaned) this.inner.setAttributes(cleaned);
  }

  setStatus(status: SpanStatus): void {
    this.inner.setStatus(mapStatus(this.otel, status));
  }

  recordException(error: unknown): void {
    if (error instanceof Error) {
      this.inner.recordException(error);
    } else {
      this.inner.recordException({ message: String(error) });
    }
  }

  end(): void {
    this.inner.end();
  }

  traceId(): string {
    return this.inner.spanContext().traceId;
  }

  spanId(): string {
    return this.inner.spanContext().spanId;
  }
}

export class OtelTracer implements Tracer {
  constructor(
    private readonly otel: OtelModule,
    private readonly tracerName: string = 'sunrise-orchestration'
  ) {}

  startSpan(name: string, options?: StartSpanOptions): Span {
    const attributes = dropUndefined(options?.attributes);
    const inner = this.otel.trace.getTracer(this.tracerName).startSpan(name, {
      kind: mapKind(this.otel, options?.kind),
      ...(attributes ? { attributes } : {}),
    });
    return new OtelSpan(this.otel, inner);
  }

  async withSpan<T>(
    name: string,
    options: StartSpanOptions,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    const otelTracer = this.otel.trace.getTracer(this.tracerName);
    const attributes = dropUndefined(options.attributes);
    return otelTracer.startActiveSpan(
      name,
      {
        kind: mapKind(this.otel, options.kind),
        ...(attributes ? { attributes } : {}),
      },
      async (otelSpan) => {
        const wrapped = new OtelSpan(this.otel, otelSpan);
        try {
          const result = await fn(wrapped);
          otelSpan.setStatus({ code: this.otel.SpanStatusCode.OK });
          return result;
        } catch (err) {
          otelSpan.setStatus({
            code: this.otel.SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : 'error',
          });
          if (err instanceof Error) {
            otelSpan.recordException(err);
          } else {
            otelSpan.recordException({ message: String(err) });
          }
          throw err;
        } finally {
          otelSpan.end();
        }
      }
    );
  }
}
