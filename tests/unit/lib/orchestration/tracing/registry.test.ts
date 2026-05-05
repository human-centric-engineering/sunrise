/**
 * Unit tests for the tracer registry.
 *
 * The registry is a module-level mutable singleton. Its contract:
 * - `getTracer()` returns NOOP_TRACER by default
 * - `registerTracer(t)` swaps the active tracer
 * - Replacing a non-default tracer logs a warning with previous/next constructor names
 * - `resetTracer()` restores the no-op default
 * - Concurrent `withSpan` calls after registration all see the newly-registered tracer
 *
 * IMPORTANT: every test calls `resetTracer()` in beforeEach to prevent cross-test
 * contamination — the registry is module-level and pollutes silently across tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logging';
import { NOOP_TRACER } from '@/lib/orchestration/tracing/noop-tracer';
import { getTracer, registerTracer, resetTracer } from '@/lib/orchestration/tracing/registry';
import type { Span, StartSpanOptions, Tracer } from '@/lib/orchestration/tracing/tracer';

// --- Minimal test-double tracer -----------------------------------------------

class TestTracer implements Tracer {
  readonly calls: Array<{ span: Span }> = [];

  startSpan(_name: string, _options?: StartSpanOptions): Span {
    return NOOP_TRACER.startSpan(_name, _options);
  }

  async withSpan<T>(
    name: string,
    options: StartSpanOptions,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    const span = this.startSpan(name, options);
    this.calls.push({ span });
    return fn(span);
  }
}

// A second subclass with a distinct constructor name — used for the replacement-warning test.
class SecondTracer extends TestTracer {}

// ---------------------------------------------------------------------------

beforeEach(() => {
  // Guard against cross-test contamination from the module-level singleton.
  resetTracer();
});

afterEach(() => {
  resetTracer();
  vi.restoreAllMocks();
});

describe('getTracer', () => {
  it('returns NOOP_TRACER by default (before any registerTracer call)', () => {
    // Arrange — resetTracer() already called in beforeEach
    // Act
    const tracer = getTracer();

    // Assert
    expect(tracer).toBe(NOOP_TRACER);
  });
});

describe('registerTracer', () => {
  it('swaps the active tracer so getTracer() returns the newly registered instance', () => {
    // Arrange
    const custom = new TestTracer();

    // Act
    registerTracer(custom);

    // Assert — getTracer() must now return the exact instance we registered
    expect(getTracer()).toBe(custom);
  });

  it('logs a warning when replacing a non-default (non-NOOP) tracer', () => {
    // Arrange — install a first custom tracer, then prepare a second one
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const first = new TestTracer();
    const second = new SecondTracer();

    registerTracer(first); // no warning — replacing NOOP
    expect(warnSpy).not.toHaveBeenCalled();

    // Act — replacing a non-default tracer should warn
    registerTracer(second);

    // Assert — warning fired exactly once with the documented message and constructor names
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('Tracer already registered; replacing existing tracer', {
      previous: 'TestTracer',
      next: 'SecondTracer',
    });
  });

  it('does NOT log a warning when replacing NOOP_TRACER (first registration)', () => {
    // Arrange
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const custom = new TestTracer();

    // Act — NOOP_TRACER is the default, so no "replacing non-default" warning
    registerTracer(custom);

    // Assert
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('resetTracer', () => {
  it('restores the no-op default after a custom tracer has been registered', () => {
    // Arrange
    const custom = new TestTracer();
    registerTracer(custom);
    expect(getTracer()).toBe(custom); // confirm custom was registered

    // Act
    resetTracer();

    // Assert — back to the singleton no-op
    expect(getTracer()).toBe(NOOP_TRACER);
  });
});

describe('concurrent withSpan calls after registerTracer', () => {
  it('both calls see the same registered tracer instance (not a stale NOOP reference)', async () => {
    // Arrange — register a recording tracer
    const tracer = new TestTracer();
    registerTracer(tracer);

    // Act — fire two concurrent withSpan calls
    await Promise.all([
      getTracer().withSpan('op-a', {}, async (_span) => {
        /* no-op body */
      }),
      getTracer().withSpan('op-b', {}, async (_span) => {
        /* no-op body */
      }),
    ]);

    // Assert — tracer.calls captured both invocations, both via the same registered instance
    expect(tracer.calls).toHaveLength(2);
    // The spans returned are from our TestTracer (which delegates to NOOP_TRACER.startSpan),
    // confirming calls routed through the registered tracer, not through NOOP_TRACER directly.
    tracer.calls.forEach(({ span }) => {
      // Each span produced by TestTracer.startSpan delegates to NOOP_TRACER.startSpan,
      // which returns NOOP_SPAN — confirming the registered tracer handled the call.
      expect(span).toBeDefined();
    });
  });

  it('getTracer() returns the same registered instance across multiple calls', () => {
    // Arrange
    const tracer = new TestTracer();
    registerTracer(tracer);

    // Act — call getTracer() multiple times
    const ref1 = getTracer();
    const ref2 = getTracer();

    // Assert — same registered instance each time (not a copy)
    expect(ref1).toBe(tracer);
    expect(ref2).toBe(tracer);
  });
});
