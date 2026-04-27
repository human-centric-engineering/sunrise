import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  CircuitBreaker,
  getBreaker,
  getCircuitBreakerStatus,
  getAllBreakerSlugs,
  resetAllBreakers,
} from '@/lib/orchestration/llm/circuit-breaker';

// Suppress logger output in tests
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

import { logger } from '@/lib/logging';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test-provider', {
      failureThreshold: 3,
      windowMs: 5000,
      cooldownMs: 2000,
    });
  });

  it('starts in closed state', () => {
    expect(breaker.state).toBe('closed');
  });

  it('allows attempts when closed', () => {
    expect(breaker.canAttempt()).toBe(true);
  });

  it('stays closed after failures below threshold', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
    expect(breaker.canAttempt()).toBe(true);
  });

  it('trips to open after threshold failures', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    const state = breaker.recordFailure();
    expect(state).toBe('open');
    expect(breaker.state).toBe('open');
  });

  it('blocks attempts when open', () => {
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.canAttempt()).toBe(false);
  });

  it('transitions to half_open after cooldown', () => {
    for (let i = 0; i < 3; i++) breaker.recordFailure();

    // Advance past cooldown
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);

    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.state).toBe('half_open');

    vi.restoreAllMocks();
  });

  it('allows probe in half_open state', () => {
    for (let i = 0; i < 3; i++) breaker.recordFailure();

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);
    breaker.canAttempt(); // transitions to half_open

    expect(breaker.canAttempt()).toBe(true); // probe allowed

    vi.restoreAllMocks();
  });

  it('resets to closed on success', () => {
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.state).toBe('open');

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);
    breaker.canAttempt(); // half_open
    breaker.recordSuccess();

    expect(breaker.state).toBe('closed');
    expect(breaker.canAttempt()).toBe(true);

    vi.restoreAllMocks();
  });

  it('re-opens on failure in half_open', () => {
    for (let i = 0; i < 3; i++) breaker.recordFailure();

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);
    breaker.canAttempt(); // half_open

    // Failures have been pruned by window, need to re-fill
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.state).toBe('open');

    vi.restoreAllMocks();
  });

  it('prunes failures outside the sliding window', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    breaker.recordFailure();
    breaker.recordFailure();

    // Advance past window so old failures expire
    vi.spyOn(Date, 'now').mockReturnValue(now + 6000);
    breaker.recordFailure(); // only 1 in window now

    expect(breaker.state).toBe('closed');

    vi.restoreAllMocks();
  });

  it('reset() clears all state', () => {
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.state).toBe('open');

    breaker.reset();
    expect(breaker.state).toBe('closed');
    expect(breaker.canAttempt()).toBe(true);
  });

  // ── Public getters (Phase 2) ──────────────────────────────────────────────

  it('failureCount returns count within the sliding window', () => {
    expect(breaker.failureCount).toBe(0);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.failureCount).toBe(2);
  });

  it('failureCount prunes expired failures', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    breaker.recordFailure();

    // Advance past window
    vi.spyOn(Date, 'now').mockReturnValue(now + 6000);
    expect(breaker.failureCount).toBe(0);

    vi.restoreAllMocks();
  });

  it('currentConfig returns a copy of the config', () => {
    const config = breaker.currentConfig;
    expect(config).toEqual({
      failureThreshold: 3,
      windowMs: 5000,
      cooldownMs: 2000,
    });
    // Ensure it's a copy, not the internal reference
    config.failureThreshold = 999;
    expect(breaker.currentConfig.failureThreshold).toBe(3);
  });

  it('openedAtTimestamp is null when closed', () => {
    expect(breaker.openedAtTimestamp).toBeNull();
  });

  it('openedAtTimestamp is set after tripping', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.openedAtTimestamp).toBe(now);

    vi.restoreAllMocks();
  });

  // ── New coverage tests ────────────────────────────────────────────────────

  it('recordFailure dispatches circuit_breaker_opened webhook event when breaker trips', async () => {
    // Arrange
    vi.clearAllMocks();

    // Act — trip the breaker
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    // Assert — webhook was dispatched for the trip event
    // dispatchWebhookEvent is called with void (fire-and-forget), so we flush microtasks
    await Promise.resolve();
    expect(vi.mocked(dispatchWebhookEvent)).toHaveBeenCalledWith(
      'circuit_breaker_opened',
      expect.objectContaining({
        providerSlug: 'test-provider',
        failures: 3,
        threshold: 3,
      })
    );
  });

  it('recordSuccess logs info when transitioning from non-closed to closed state', () => {
    // Arrange — trip the breaker and advance past cooldown to half_open
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);
    breaker.canAttempt(); // transitions to half_open
    vi.clearAllMocks(); // clear prior logger calls

    // Act
    breaker.recordSuccess();

    // Assert — logger.info was called about the reset
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      'Circuit breaker reset to closed',
      expect.objectContaining({ provider: 'test-provider' })
    );

    vi.restoreAllMocks();
  });

  it('canAttempt in open state with cooldown not elapsed: returns false', () => {
    // Arrange — trip the breaker; cooldown = 2000ms but we don't advance time
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.state).toBe('open');

    // Simulate only 500ms elapsed (less than 2000ms cooldown)
    const trippedAt = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(trippedAt + 500);

    // Act
    const result = breaker.canAttempt();

    // Assert — still blocked; cooldown not yet elapsed
    expect(result).toBe(false);
    expect(breaker.state).toBe('open');

    vi.restoreAllMocks();
  });

  it('canAttempt transitions to half_open when cooldown elapses', () => {
    // Arrange — trip the breaker
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.state).toBe('open');

    // Advance past cooldown (2000ms)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2500);

    // Act
    const allowed = breaker.canAttempt();

    // Assert — probe is allowed and state is now half_open
    expect(allowed).toBe(true);
    expect(breaker.state).toBe('half_open');

    vi.restoreAllMocks();
  });
});

describe('getBreaker / resetAllBreakers', () => {
  beforeEach(() => {
    resetAllBreakers();
  });

  it('returns same instance for same slug', () => {
    const a = getBreaker('provider-a');
    const b = getBreaker('provider-a');
    expect(a).toBe(b);
  });

  it('returns different instances for different slugs', () => {
    const a = getBreaker('provider-a');
    const b = getBreaker('provider-b');
    expect(a).not.toBe(b);
  });

  it('resetAllBreakers clears the registry', () => {
    const a = getBreaker('provider-a');
    resetAllBreakers();
    const b = getBreaker('provider-a');
    expect(a).not.toBe(b);
  });
});

describe('getCircuitBreakerStatus', () => {
  beforeEach(() => {
    resetAllBreakers();
  });

  it('returns null when no breaker exists for the slug', () => {
    expect(getCircuitBreakerStatus('nonexistent')).toBeNull();
  });

  it('returns status snapshot for an existing breaker', () => {
    const breaker = getBreaker('test-slug', {
      failureThreshold: 3,
      windowMs: 5000,
      cooldownMs: 2000,
    });
    breaker.recordFailure();

    const status = getCircuitBreakerStatus('test-slug');
    expect(status).not.toBeNull();
    expect(status!.state).toBe('closed');
    expect(status!.failureCount).toBe(1);
    expect(status!.openedAt).toBeNull();
    expect(status!.config).toEqual({
      failureThreshold: 3,
      windowMs: 5000,
      cooldownMs: 2000,
    });
  });

  it('reflects open state after breaker trips', () => {
    const breaker = getBreaker('tripped', {
      failureThreshold: 2,
      windowMs: 60000,
      cooldownMs: 5000,
    });
    breaker.recordFailure();
    breaker.recordFailure();

    const status = getCircuitBreakerStatus('tripped');
    expect(status!.state).toBe('open');
    expect(status!.failureCount).toBe(2);
    expect(status!.openedAt).toBeTypeOf('number');
  });
});

describe('getAllBreakerSlugs', () => {
  beforeEach(() => {
    resetAllBreakers();
  });

  it('returns empty array when no breakers exist', () => {
    expect(getAllBreakerSlugs()).toEqual([]);
  });

  it('returns slugs for all registered breakers', () => {
    getBreaker('alpha');
    getBreaker('beta');
    getBreaker('gamma');

    const slugs = getAllBreakerSlugs();
    expect(slugs).toHaveLength(3);
    expect(slugs).toContain('alpha');
    expect(slugs).toContain('beta');
    expect(slugs).toContain('gamma');
  });
});
