import { logger } from '@/lib/logging';
import { NOOP_TRACER } from '@/lib/orchestration/tracing/noop-tracer';
import type { Tracer } from '@/lib/orchestration/tracing/tracer';

let activeTracer: Tracer = NOOP_TRACER;

/**
 * Get the currently registered tracer. Returns the no-op tracer by default.
 *
 * Callers should not cache the result — tests may swap the tracer between
 * runs and dev hot reload may re-register.
 */
export function getTracer(): Tracer {
  return activeTracer;
}

/**
 * Register a tracer implementation. Logs a warning if a non-default tracer
 * is being replaced — typically harmless under dev hot reload, but worth
 * noticing in production where it usually means double-bootstrap.
 */
export function registerTracer(tracer: Tracer): void {
  if (activeTracer !== NOOP_TRACER) {
    logger.warn('Tracer already registered; replacing existing tracer', {
      previous: activeTracer.constructor.name,
      next: tracer.constructor.name,
    });
  }
  activeTracer = tracer;
}

/**
 * Restore the no-op tracer. Tests only — production code should never call this.
 */
export function resetTracer(): void {
  activeTracer = NOOP_TRACER;
}
