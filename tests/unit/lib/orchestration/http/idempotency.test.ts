/**
 * Tests for `lib/orchestration/http/idempotency.ts`.
 *
 * Covers:
 *   - undefined config → no header
 *   - 'auto' → fresh UUID per call (different keys, valid format)
 *   - explicit string → passthrough
 *   - custom header name override
 */

import { describe, expect, it } from 'vitest';

import { resolveIdempotencyHeader } from '@/lib/orchestration/http/idempotency';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('resolveIdempotencyHeader', () => {
  it('returns empty object when config is undefined', () => {
    expect(resolveIdempotencyHeader(undefined)).toEqual({});
  });

  it('returns the explicit key verbatim under default header', () => {
    expect(resolveIdempotencyHeader({ key: 'order_42' })).toEqual({
      'Idempotency-Key': 'order_42',
    });
  });

  it('honours a custom header name', () => {
    expect(resolveIdempotencyHeader({ key: 'order_42', headerName: 'X-Idempotency' })).toEqual({
      'X-Idempotency': 'order_42',
    });
  });

  it('generates a UUID when key is "auto"', () => {
    const out = resolveIdempotencyHeader({ key: 'auto' });
    const value = out['Idempotency-Key'];
    expect(value).toMatch(UUID_V4_REGEX);
  });

  it('generates a fresh UUID on each call', () => {
    const a = resolveIdempotencyHeader({ key: 'auto' })['Idempotency-Key'];
    const b = resolveIdempotencyHeader({ key: 'auto' })['Idempotency-Key'];
    expect(a).not.toEqual(b);
  });
});
