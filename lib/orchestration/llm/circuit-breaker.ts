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
 *
 * Keyed per CREDENTIAL, not per provider (§120 t-744): `getBreaker` takes the
 * key `breakerKeyOf(provider)` / `getProviderWithFallbacks().breakerKey`
 * returns — the slug for the install's shared credential, slug + identity for
 * one a fork's credential resolver gives a single org. So one org's failing
 * key never pauses another org's healthy one. The admin reads aggregate by
 * provider (`getCircuitBreakerStatusForProvider`, `resetBreakersForProvider`).
 *
 * Tenancy posture: shared-by-decision — per (provider slug, credential
 * identity); the shared credential is shared by every org that uses it
 * (lib/tenancy/process-state.ts).
 */

import { logger } from '@/lib/logging';
import { slugOfCredentialKey } from '@/lib/orchestration/llm/credential-key';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';

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
      // Only dispatch the webhook and bump openedAt on the closed→open
      // transition. Without this guard, every subsequent failure recorded
      // while the breaker is already open re-fires the webhook (and resets
      // openedAt, which would distort `openedAt` for receivers that watch
      // it). The state itself is idempotent so leaving the assignment in
      // place is harmless.
      const wasClosed = this._state !== 'open';
      this._state = 'open';
      if (wasClosed) {
        this.openedAt = now;
        void dispatchWebhookEvent('circuit_breaker_opened', {
          // The provider SLUG, never the credential key this breaker is keyed
          // on (§120 t-744): receivers match on the slug, and an org's
          // credential identity is not theirs to see. A per-credential breaker
          // says so without saying whose.
          providerSlug: slugOfCredentialKey(this.slug),
          perCredential: slugOfCredentialKey(this.slug) !== this.slug,
          failures: this.failures.length,
          threshold: this.config.failureThreshold,
          // Config the receiver needs to understand how long the breaker
          // will stay tripped before half-open probes start.
          windowMs: this.config.windowMs,
          cooldownMs: this.config.cooldownMs,
          openedAt: new Date(now).toISOString(),
        });
        logger.warn('Circuit breaker tripped', {
          provider: this.slug,
          failures: this.failures.length,
          windowMs: this.config.windowMs,
          cooldownMs: this.config.cooldownMs,
        });
      }
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

  /** Number of failures within the current sliding window. */
  get failureCount(): number {
    this.pruneWindow(Date.now());
    return this.failures.length;
  }

  /** The breaker's configuration (thresholds and timings). */
  get currentConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  /** Timestamp (ms since epoch) when the breaker tripped, or `null` if closed. */
  get openedAtTimestamp(): number | null {
    return this.openedAt;
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

/** Status snapshot of a circuit breaker. */
export interface CircuitBreakerStatus {
  state: CircuitState;
  failureCount: number;
  openedAt: number | null;
  config: CircuitBreakerConfig;
}

/** Get the status of a specific breaker, or `null` if none exists for the slug. */
export function getCircuitBreakerStatus(slug: string): CircuitBreakerStatus | null {
  const breaker = breakers.get(slug);
  if (!breaker) return null;
  return {
    state: breaker.state,
    failureCount: breaker.failureCount,
    openedAt: breaker.openedAtTimestamp,
    config: breaker.currentConfig,
  };
}

/** How bad a state is, for picking the one an admin should see. */
const STATE_SEVERITY: Record<CircuitState, number> = { closed: 0, half_open: 1, open: 2 };

/**
 * The status an admin should see for a provider: the worst of its
 * credentials' breakers (§120 t-744), or `null` when none exists. With only the
 * shared credential that is exactly `getCircuitBreakerStatus(slug)`.
 */
export function getCircuitBreakerStatusForProvider(slug: string): CircuitBreakerStatus | null {
  let worst: CircuitBreakerStatus | null = null;
  for (const key of breakers.keys()) {
    if (slugOfCredentialKey(key) !== slug) continue;
    const status = getCircuitBreakerStatus(key);
    if (
      status &&
      (worst === null ||
        STATE_SEVERITY[status.state] > STATE_SEVERITY[worst.state] ||
        (status.state === worst.state && status.failureCount > worst.failureCount))
    ) {
      worst = status;
    }
  }
  return worst;
}

/**
 * Reset every credential's breaker for a provider — what an admin's "reset
 * breaker" means. Creates the shared one if none exists, as `getBreaker(slug)`
 * always did, so the action has a breaker to report on.
 */
export function resetBreakersForProvider(slug: string): void {
  getBreaker(slug).reset();
  for (const [key, breaker] of breakers) {
    if (key !== slug && slugOfCredentialKey(key) === slug) breaker.reset();
  }
}

/** Get all keys (slug, or slug + credential identity) that have an active breaker. */
export function getAllBreakerSlugs(): string[] {
  return Array.from(breakers.keys());
}

/** Reset all breakers (for tests). */
export function resetAllBreakers(): void {
  breakers.clear();
}
