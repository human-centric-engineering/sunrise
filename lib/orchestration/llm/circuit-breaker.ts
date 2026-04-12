/**
 * Circuit Breaker for LLM providers (Phase 7 Session 7.3)
 *
 * Prevents cascading failures by tracking provider error rates and
 * temporarily disabling providers that exceed the failure threshold.
 *
 * States:
 *   closed    → healthy, requests pass through
 *   open      → tripped, requests are blocked
 *   half_open → cooldown elapsed, one probe request allowed
 *
 * NOTE: This circuit breaker uses module-level in-memory state (matching
 * the `instanceCache` pattern in `provider-manager.ts`). In a
 * multi-instance deployment (e.g. multiple containers behind a load
 * balancer), each instance maintains its own breaker state independently.
 * For coordinated circuit breaking across instances, this would need to
 * be backed by a shared store such as Redis.
 */

import { logger } from '@/lib/logging';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Number of failures within the window to trip the breaker. */
  failureThreshold: number;
  /** Sliding window duration in milliseconds. */
  windowMs: number;
  /** How long the breaker stays open before transitioning to half_open. */
  cooldownMs: number;
}

export type CircuitState = 'closed' | 'open' | 'half_open';

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
};

// ─── CircuitBreaker ─────────────────────────────────────────────────────────

export class CircuitBreaker {
  private readonly slug: string;
  private readonly config: CircuitBreakerConfig;
  private failures: number[] = [];
  private _state: CircuitState = 'closed';
  private openedAt: number | null = null;

  constructor(providerSlug: string, config?: Partial<CircuitBreakerConfig>) {
    this.slug = providerSlug;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get state(): CircuitState {
    return this._state;
  }

  /**
   * Record a failure. Returns the new state after recording.
   *
   * Failures outside the sliding window are pruned first. If the
   * remaining count meets or exceeds the threshold, the breaker trips
   * to `open`.
   */
  recordFailure(): CircuitState {
    const now = Date.now();
    this.failures.push(now);
    this.pruneWindow(now);

    if (this.failures.length >= this.config.failureThreshold) {
      this._state = 'open';
      this.openedAt = now;
      logger.warn('Circuit breaker tripped', {
        provider: this.slug,
        failures: this.failures.length,
        windowMs: this.config.windowMs,
        cooldownMs: this.config.cooldownMs,
      });
    }

    return this._state;
  }

  /**
   * Record a success. Resets the breaker to `closed` and clears
   * the failure history.
   */
  recordSuccess(): void {
    if (this._state !== 'closed') {
      logger.info('Circuit breaker reset to closed', { provider: this.slug });
    }
    this._state = 'closed';
    this.failures = [];
    this.openedAt = null;
  }

  /**
   * Check whether a request can be attempted through this breaker.
   *
   * - `closed`    → always allowed
   * - `open`      → blocked unless cooldown has elapsed, in which case
   *                  transitions to `half_open` and allows one probe
   * - `half_open` → allowed (single probe in progress)
   */
  canAttempt(): boolean {
    if (this._state === 'closed') return true;

    if (this._state === 'open') {
      const now = Date.now();
      if (this.openedAt !== null && now - this.openedAt >= this.config.cooldownMs) {
        this._state = 'half_open';
        logger.info('Circuit breaker entering half_open (probe allowed)', {
          provider: this.slug,
        });
        return true;
      }
      return false;
    }

    // half_open — allow the probe
    return true;
  }

  /** Reset to initial state (for tests). */
  reset(): void {
    this._state = 'closed';
    this.failures = [];
    this.openedAt = null;
  }

  private pruneWindow(now: number): void {
    const cutoff = now - this.config.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
  }
}

// ─── Module-level registry ──────────────────────────────────────────────────
// NOTE: Per-instance in-memory state. See file header comment about
// multi-instance deployments.

const breakers = new Map<string, CircuitBreaker>();

/** Get or create a breaker for the given provider slug. */
export function getBreaker(slug: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
  const existing = breakers.get(slug);
  if (existing) return existing;

  const breaker = new CircuitBreaker(slug, config);
  breakers.set(slug, breaker);
  return breaker;
}

/** Reset all breakers (for tests). */
export function resetAllBreakers(): void {
  breakers.clear();
}
