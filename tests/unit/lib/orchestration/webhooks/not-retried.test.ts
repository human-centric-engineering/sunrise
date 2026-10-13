/**
 * @see lib/orchestration/webhooks/not-retried.ts
 */

import { describe, it, expect } from 'vitest';
import {
  AWAITING_RETRY_STATUSES,
  isAwaitingRetry,
  notRetried,
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
