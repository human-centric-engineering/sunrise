/**
 * @see lib/orchestration/webhooks/not-retried.ts
 */

import { describe, it, expect } from 'vitest';
import { notRetried } from '@/lib/orchestration/webhooks/not-retried';

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
