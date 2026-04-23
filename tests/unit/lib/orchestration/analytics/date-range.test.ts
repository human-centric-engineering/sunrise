import { describe, expect, it } from 'vitest';

import {
  ANALYTICS_DEFAULT_RANGE_DAYS,
  getAnalyticsDefaultDateInputs,
  resolveAnalyticsDateRange,
} from '@/lib/orchestration/analytics/date-range';

const FIXED_NOW = new Date('2026-04-23T12:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('resolveAnalyticsDateRange', () => {
  it('defaults `to` to now and `from` to 30 days before `to`', () => {
    const { from, to } = resolveAnalyticsDateRange({}, FIXED_NOW);
    expect(to).toEqual(FIXED_NOW);
    expect(to.getTime() - from.getTime()).toBe(ANALYTICS_DEFAULT_RANGE_DAYS * MS_PER_DAY);
  });

  it('uses the supplied `to` and defaults `from` relative to it', () => {
    const explicitTo = '2026-03-01T00:00:00.000Z';
    const { from, to } = resolveAnalyticsDateRange({ to: explicitTo }, FIXED_NOW);
    expect(to.toISOString()).toBe(explicitTo);
    expect(to.getTime() - from.getTime()).toBe(ANALYTICS_DEFAULT_RANGE_DAYS * MS_PER_DAY);
  });

  it('honours both `from` and `to` when provided', () => {
    const { from, to } = resolveAnalyticsDateRange(
      { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
      FIXED_NOW
    );
    expect(from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('getAnalyticsDefaultDateInputs', () => {
  it('returns YYYY-MM-DD strings for the 30-day default window', () => {
    const { from, to } = getAnalyticsDefaultDateInputs(FIXED_NOW);
    expect(to).toBe('2026-04-23');
    expect(from).toBe('2026-03-24');
  });
});
