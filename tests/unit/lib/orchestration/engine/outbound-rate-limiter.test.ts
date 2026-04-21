/**
 * Tests for `lib/orchestration/engine/outbound-rate-limiter.ts`.
 *
 * Covers:
 *   - Per-host sliding window enforcement.
 *   - Retry-After recording (seconds and HTTP-date).
 *   - Retry-After deadline blocking.
 *   - Reset clears all state.
 *   - Configurable limit via env var.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  checkOutboundRateLimit,
  recordRetryAfter,
  resetOutboundRateLimiters,
} from '@/lib/orchestration/engine/outbound-rate-limiter';

describe('outbound-rate-limiter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    resetOutboundRateLimiters();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('allows requests under the limit', () => {
    process.env.ORCHESTRATION_OUTBOUND_RATE_LIMIT = '5';
    resetOutboundRateLimiters();

    for (let i = 0; i < 5; i++) {
      expect(checkOutboundRateLimit('api.example.com').allowed).toBe(true);
    }
  });

  it('blocks requests that exceed the limit', () => {
    process.env.ORCHESTRATION_OUTBOUND_RATE_LIMIT = '3';
    resetOutboundRateLimiters();

    expect(checkOutboundRateLimit('api.example.com').allowed).toBe(true);
    expect(checkOutboundRateLimit('api.example.com').allowed).toBe(true);
    expect(checkOutboundRateLimit('api.example.com').allowed).toBe(true);

    const result = checkOutboundRateLimit('api.example.com');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('tracks separate limits per host', () => {
    process.env.ORCHESTRATION_OUTBOUND_RATE_LIMIT = '2';
    resetOutboundRateLimiters();

    expect(checkOutboundRateLimit('host-a.com').allowed).toBe(true);
    expect(checkOutboundRateLimit('host-a.com').allowed).toBe(true);
    // host-a should be blocked now.
    expect(checkOutboundRateLimit('host-a.com').allowed).toBe(false);
    // host-b should still be allowed.
    expect(checkOutboundRateLimit('host-b.com').allowed).toBe(true);
  });

  it('uses default 60/min when env var is not set', () => {
    delete process.env.ORCHESTRATION_OUTBOUND_RATE_LIMIT;
    resetOutboundRateLimiters();

    // Should allow many requests (up to 60).
    for (let i = 0; i < 60; i++) {
      expect(checkOutboundRateLimit('api.example.com').allowed).toBe(true);
    }

    // 61st should be blocked.
    expect(checkOutboundRateLimit('api.example.com').allowed).toBe(false);
  });

  // ─── Retry-After ───────────────────────────────────────────────────────

  it('blocks requests during Retry-After window (seconds format)', () => {
    recordRetryAfter('api.example.com', '60');

    const result = checkOutboundRateLimit('api.example.com');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('blocks requests during Retry-After window (HTTP-date format)', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    recordRetryAfter('api.example.com', future);

    const result = checkOutboundRateLimit('api.example.com');
    expect(result.allowed).toBe(false);
  });

  it('ignores invalid Retry-After values', () => {
    recordRetryAfter('api.example.com', 'not-a-date-or-number');

    // Should still be allowed (invalid Retry-After ignored).
    expect(checkOutboundRateLimit('api.example.com').allowed).toBe(true);
  });

  it('allows requests after Retry-After window expires', () => {
    // Record a very short Retry-After (already in the past).
    const past = new Date(Date.now() - 1000).toUTCString();
    recordRetryAfter('api.example.com', past);

    expect(checkOutboundRateLimit('api.example.com').allowed).toBe(true);
  });

  // ─── Reset ─────────────────────────────────────────────────────────────

  it('resetOutboundRateLimiters clears all state', () => {
    process.env.ORCHESTRATION_OUTBOUND_RATE_LIMIT = '1';
    resetOutboundRateLimiters();

    expect(checkOutboundRateLimit('api.example.com').allowed).toBe(true);
    expect(checkOutboundRateLimit('api.example.com').allowed).toBe(false);

    resetOutboundRateLimiters();

    expect(checkOutboundRateLimit('api.example.com').allowed).toBe(true);
  });
});
