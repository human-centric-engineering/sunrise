/**
 * Unit tests for the OTEL bootstrap helper.
 *
 * Scope: `registerOtelTracer()` — wires an `OtelTracer` instance into the
 * global registry, logs a success message, and forwards the caller-supplied
 * tracer name.
 *
 * Exclusion — "missing dep" failure path:
 *   The `try/catch` around `import('@opentelemetry/api')` in the source is NOT
 *   tested here. `@opentelemetry/api` is transitively present in this repo via
 *   Next.js + Sentry (confirmed via `npm ls @opentelemetry/api`). There is no
 *   realistic way to make the import fail under Vitest without deep module-loader
 *   stubbing that doesn't model what would happen in a production fork that
 *   strips OTEL deps (Vitest's module graph differs from Node.js production
 *   resolution). The runtime guard is a trivial `try/catch` with a clear error
 *   message; cost vs value does not justify the harness complexity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logging';
import { OtelTracer } from '@/lib/orchestration/tracing/otel-adapter';
import { registerOtelTracer } from '@/lib/orchestration/tracing/otel-bootstrap';
import { getTracer, resetTracer } from '@/lib/orchestration/tracing/registry';
import * as registry from '@/lib/orchestration/tracing/registry';

beforeEach(() => {
  resetTracer();
});

afterEach(() => {
  resetTracer();
  vi.restoreAllMocks();
});

describe('registerOtelTracer', () => {
  it('calls registerTracer with an OtelTracer instance', async () => {
    // Arrange — spy on registerTracer so we can assert on the argument type
    const registerSpy = vi.spyOn(registry, 'registerTracer');

    // Act
    await registerOtelTracer();

    // Assert — registerTracer was called with an OtelTracer (not just any Tracer)
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith(expect.any(OtelTracer));
  });

  it('wires up getTracer() to return the registered OtelTracer after the call', async () => {
    // Arrange — registry starts in no-op state (resetTracer in beforeEach)

    // Act
    await registerOtelTracer();

    // Assert — the hook actually connected the new tracer; getTracer() reflects it
    expect(getTracer()).toBeInstanceOf(OtelTracer);
  });

  it('forwards a custom tracerName to the OtelTracer constructor (visible in the log)', async () => {
    // Arrange — spy on logger.info to capture the tracerName field
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    // Act
    await registerOtelTracer('custom-name');

    // Assert — the log call carries the custom name, which is what the OtelTracer
    // constructor received (bootstrap passes tracerName straight through)
    expect(infoSpy).toHaveBeenCalledWith('OTEL tracer registered for orchestration', {
      tracerName: 'custom-name',
    });
  });

  it('logs the success message with the default tracerName when none is provided', async () => {
    // Arrange
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    // Act
    await registerOtelTracer();

    // Assert — message matches the documented constant in the source
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('OTEL tracer registered for orchestration', {
      tracerName: 'sunrise-orchestration',
    });
  });
});
