/**
 * Unit Test: formatStatus + STATUS_LABELS
 *
 * @see lib/utils/format-status.ts
 */

import { describe, it, expect } from 'vitest';
import { formatStatus, STATUS_LABELS } from '@/lib/utils/format-status';

describe('formatStatus', () => {
  it.each(Object.entries(STATUS_LABELS))('returns "%s" → "%s" from lookup', (key, label) => {
    expect(formatStatus(key)).toBe(label);
  });

  it('falls back to sentence-case for unknown statuses', () => {
    expect(formatStatus('waiting_for_input')).toBe('Waiting for input');
  });

  it('capitalises single-word unknown status', () => {
    expect(formatStatus('archived')).toBe('Archived');
  });

  it('handles empty string without throwing', () => {
    expect(formatStatus('')).toBe('');
  });
});
