/**
 * Idempotency-Key header support for orchestration outbound HTTP.
 *
 * Vendors that support safe retries (Stripe, etc.) treat repeated
 * requests with the same key as the same operation. Without it,
 * retries on a charge endpoint can double-charge a customer.
 *
 * Two modes:
 *   - `'auto'`        — generate a fresh UUID per call.
 *   - explicit string — use the supplied key verbatim. Useful when the
 *                       caller wants a deterministic key tied to a
 *                       business identifier (e.g. order ID).
 *
 * Header name is configurable because vendors disagree (Stripe uses
 * `Idempotency-Key`; some use `X-Idempotency-Key`).
 */

import { randomUUID } from 'node:crypto';

export interface HttpIdempotencyConfig {
  /** `'auto'` to generate a UUID, or an explicit key string. */
  key: string;
  /** Header name (default: 'Idempotency-Key'). */
  headerName?: string;
}

const DEFAULT_HEADER = 'Idempotency-Key';

/**
 * Resolve an idempotency config into the header to attach. Returns an
 * empty object when no config is supplied, so callers can spread the
 * result unconditionally.
 */
export function resolveIdempotencyHeader(
  config: HttpIdempotencyConfig | undefined
): Record<string, string> {
  if (!config) return {};
  const key = config.key === 'auto' ? randomUUID() : config.key;
  return { [config.headerName ?? DEFAULT_HEADER]: key };
}
