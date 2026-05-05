/**
 * OpenTelemetry bootstrap helper.
 *
 * Forks call `registerOtelTracer()` from server-only init code (e.g. an
 * `instrumentation.ts` file or a startup script) AFTER constructing
 * their own `TracerProvider` with the desired exporter and sampler.
 *
 * `@opentelemetry/api` is an optional peer dependency. The dynamic
 * import below mirrors the `ioredis` pattern at
 * `lib/security/rate-limit-stores/redis.ts:72-93` — the magic comments
 * tell webpack and Turbopack not to statically resolve the specifier,
 * so forks that don't install OTEL never see a "Module not found"
 * warning. The runtime catch surfaces a clear error if the helper is
 * called without the dep installed.
 *
 * Sunrise does NOT bundle a TracerProvider. Forks own that wiring:
 *
 *   import { NodeSDK } from '@opentelemetry/sdk-node';
 *   import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
 *   import { registerOtelTracer } from '@/lib/orchestration/tracing/otel-bootstrap';
 *
 *   const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter() });
 *   sdk.start();
 *   await registerOtelTracer();
 *
 * Standard `OTEL_EXPORTER_OTLP_*` and `OTEL_TRACES_SAMPLER` env vars
 * are honoured by the NodeSDK / OTLPTraceExporter directly — Sunrise
 * does not read them.
 */

import { logger } from '@/lib/logging';
import { OtelTracer } from '@/lib/orchestration/tracing/otel-adapter';
import { registerTracer } from '@/lib/orchestration/tracing/registry';

/**
 * Register the OTEL adapter as the active tracer.
 *
 * @param tracerName - Name passed to `trace.getTracer()`. Defaults to
 *   `'sunrise-orchestration'`. Forks running multiple Sunrise instances
 *   in one process can override to disambiguate.
 *
 * @throws Error if `@opentelemetry/api` is not installed. The error is
 *   surfaced rather than swallowed because a misconfigured tracing
 *   bootstrap is a deployment-time bug worth catching loudly.
 */
export async function registerOtelTracer(
  tracerName: string = 'sunrise-orchestration'
): Promise<void> {
  let otel: typeof import('@opentelemetry/api');
  try {
    otel = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ '@opentelemetry/api');
  } catch (err) {
    throw new Error(
      "Cannot register OTEL tracer — '@opentelemetry/api' is not installed. " +
        'Run `npm install @opentelemetry/api` (and your chosen SDK + exporter) first.',
      { cause: err }
    );
  }
  registerTracer(new OtelTracer(otel, tracerName));
  logger.info('OTEL tracer registered for orchestration', { tracerName });
}
