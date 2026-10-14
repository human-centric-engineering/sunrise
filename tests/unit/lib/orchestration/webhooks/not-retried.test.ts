/**
 * @see lib/orchestration/webhooks/not-retried.ts
 */

import { describe, it, expect } from 'vitest';
import {
  AWAITING_RETRY_STATUSES,
  RECIPIENT_ERASED,
  SUBJECT_ERASED,
  isArmedRetry,
  isAwaitingRetry,
  isStoppedByErasure,
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

describe('isAwaitingRetry', () => {
  it.each(['pending', 'failed'])('is true for %s', (status) => {
    expect(isAwaitingRetry(status)).toBe(true);
  });

  it.each(['exhausted', 'delivered', 'retrying', '', 'PENDING'])('is false for %s', (status) => {
    expect(isAwaitingRetry(status)).toBe(false);
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

describe('isStoppedByErasure', () => {
  it.each([
    notRetried(null, SUBJECT_ERASED),
    notRetried('HTTP 503', SUBJECT_ERASED),
    notRetried(null, RECIPIENT_ERASED),
    notRetried('Resend 422', RECIPIENT_ERASED),
  ])('recognises %s', (lastError) => {
    expect(isStoppedByErasure(lastError)).toBe(true);
  });

  it.each([
    null,
    '',
    'HTTP 503',
    notRetried('HTTP 503', 'subscription deleted'),
    notRetried(null, 'hook deleted'),
    'Subscription deactivated',
    // The reason's words inside a receiver's own error are not the mark
    'HTTP 400: subject erased field missing',
    'subject erased',
  ])('does not recognise %s', (lastError) => {
    expect(isStoppedByErasure(lastError)).toBe(false);
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
