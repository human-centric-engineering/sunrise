/**
 * @see lib/orchestration/webhooks/not-retried.ts
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  AWAITING_RETRY_STATUSES,
  DISPATCH_TIMEOUT_MS,
  RECIPIENT_ERASED,
  RETRY_CLAIM_LEASE_MS,
  SUBJECT_ERASED,
  isArmedRetry,
  notRetried,
  notRetriedSuffix,
} from '@/lib/orchestration/webhooks/not-retried';

describe('notRetried', () => {
  it('keeps the real failure first and appends why retries stopped', () => {
    expect(notRetried('HTTP 503 from upstream', 'subscription deleted')).toBe(
      'HTTP 503 from upstream (not retried: subscription deleted)'
    );
  });

  it('stands alone, capitalised, when there is no earlier error', () => {
    expect(notRetried(null, 'hook deleted')).toBe('Not retried: hook deleted');
  });

  it('treats an empty earlier error as none', () => {
    expect(notRetried('', 'hook deleted')).toBe('Not retried: hook deleted');
  });
});

describe('AWAITING_RETRY_STATUSES', () => {
  it('is the two statuses that will still be sent: first attempt pending, retry failed', () => {
    expect([...AWAITING_RETRY_STATUSES].sort()).toEqual(['failed', 'pending']);
  });
});

describe('notRetriedSuffix', () => {
  it('is exactly what notRetried appends to an earlier error', () => {
    expect('HTTP 503' + notRetriedSuffix('subject erased')).toBe(
      notRetried('HTTP 503', 'subject erased')
    );
  });
});

describe('the stoppedByErasure backfill (t-809)', () => {
  // The migration marks rows an erasure stopped before the column existed by
  // their `lastError` wording. Its literals must be exactly what notRetried()
  // wrote, for both reasons, whole and as a suffix.
  const migration = readFileSync(
    'prisma/migrations/20261015150000_delivery_stopped_by_erasure/migration.sql',
    'utf8'
  );

  it.each([SUBJECT_ERASED, RECIPIENT_ERASED])(
    'matches notRetried()’s wording for “%s”, whole and as a suffix, in both tables',
    (reason) => {
      const whole = `'${notRetried(null, reason)}'`;
      const suffix = `LIKE '%${notRetriedSuffix(reason)}'`;
      expect(migration.split(whole)).toHaveLength(3);
      expect(migration.split(suffix)).toHaveLength(3);
    }
  );
});

describe('DISPATCH_TIMEOUT_MS (t-808)', () => {
  it.each(Object.entries(DISPATCH_TIMEOUT_MS))(
    'bounds the %s channel’s send well inside the retry claim lease',
    (_channel, timeout) => {
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThan(RETRY_CLAIM_LEASE_MS);
    }
  );

  it('names every delivery channel that sends', () => {
    expect(Object.keys(DISPATCH_TIMEOUT_MS).sort()).toEqual(['email', 'hook', 'webhook']);
  });
});

describe('isArmedRetry', () => {
  const armedFor = new Date('2026-10-14T12:00:10.123Z');

  it('is true for the failed row with the nextRetryAt the timer was armed for', () => {
    expect(isArmedRetry({ status: 'failed', nextRetryAt: new Date(armedFor) }, armedFor)).toBe(
      true
    );
  });

  it('is false once an admin retried it by hand: pending, nextRetryAt cleared', () => {
    expect(isArmedRetry({ status: 'pending', nextRetryAt: null }, armedFor)).toBe(false);
  });

  it('is false when a later attempt failed and armed its own retry', () => {
    expect(
      isArmedRetry(
        { status: 'failed', nextRetryAt: new Date(armedFor.getTime() + 60_000) },
        armedFor
      )
    ).toBe(false);
  });

  it('is false one millisecond off: the match is exact', () => {
    expect(
      isArmedRetry({ status: 'failed', nextRetryAt: new Date(armedFor.getTime() + 1) }, armedFor)
    ).toBe(false);
  });

  it.each(['exhausted', 'delivered'])('is false for a row settled as %s', (status) => {
    expect(isArmedRetry({ status, nextRetryAt: null }, armedFor)).toBe(false);
  });
});
