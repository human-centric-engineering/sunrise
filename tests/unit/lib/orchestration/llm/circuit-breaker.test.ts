import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  CircuitBreaker,
  getBreaker,
  resetAllBreakers,
} from '@/lib/orchestration/llm/circuit-breaker';

// Suppress logger output in tests
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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
