/**
 * Unit Test: formatDuration
 *
 * @see lib/utils/format-duration.ts
 *
 * Edge cases:
 * - null / missing start → em-dash
 * - invalid (NaN) start date → em-dash
 * - sub-second durations → "X ms"
 * - multi-second durations → "X.Xs"
 * - null end → uses Date.now() (running execution)
 * - invalid end date → NaN propagation check
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatDuration } from '@/lib/utils/format-duration';

describe('formatDuration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns em-dash when start is null', () => {
    expect(formatDuration(null, null)).toBe('—');
  });

  it('returns em-dash when start is empty string (falsy)', () => {
    // empty string is falsy, hits the !start guard
    expect(formatDuration('' as unknown as null, null)).toBe('—');
  });

  it('returns em-dash when start is an invalid date string', () => {
    expect(formatDuration('not-a-date', '2025-01-01T00:00:01.000Z')).toBe('—');
  });

  it('returns milliseconds for sub-second durations', () => {
    const start = '2025-01-01T10:00:00.000Z';
    const end = '2025-01-01T10:00:00.500Z';
    expect(formatDuration(start, end)).toBe('500 ms');
  });

  it('returns zero ms when start and end are identical', () => {
    const ts = '2025-01-01T10:00:00.000Z';
    expect(formatDuration(ts, ts)).toBe('0 ms');
  });

  it('returns seconds with one decimal for durations >= 1s', () => {
    const start = '2025-01-01T10:00:00.000Z';
    const end = '2025-01-01T10:00:01.500Z';
    expect(formatDuration(start, end)).toBe('1.5s');
  });

  it('returns seconds for exactly 1 second', () => {
    const start = '2025-01-01T10:00:00.000Z';
    const end = '2025-01-01T10:00:01.000Z';
    expect(formatDuration(start, end)).toBe('1.0s');
  });

  it('handles multi-minute durations', () => {
    const start = '2025-01-01T10:00:00.000Z';
    const end = '2025-01-01T10:01:30.000Z'; // 90 seconds
    expect(formatDuration(start, end)).toBe('90.0s');
  });

  it('uses Date.now() when end is null (running execution)', () => {
    const now = new Date('2025-06-15T12:00:05.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const start = '2025-06-15T12:00:00.000Z';
    expect(formatDuration(start, null)).toBe('5.0s');
  });

  it('handles 999ms boundary (still sub-second)', () => {
    const start = '2025-01-01T10:00:00.000Z';
    const end = '2025-01-01T10:00:00.999Z';
    expect(formatDuration(start, end)).toBe('999 ms');
  });
});
