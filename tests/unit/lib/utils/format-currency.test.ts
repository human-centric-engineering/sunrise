/**
 * Unit tests for `formatUsd()`.
 *
 * The cost dashboard renders dozens of dollar amounts — the decimal
 * rules and null/NaN handling need to be airtight so a single bad
 * summary fetch doesn't render `NaN` or `$undefined` across the page.
 */

import { describe, it, expect } from 'vitest';

import { formatUsd } from '@/lib/utils/format-currency';

describe('formatUsd', () => {
  describe('null-ish values', () => {
    it('returns — for null', () => {
      expect(formatUsd(null)).toBe('—');
    });

    it('returns — for undefined', () => {
      expect(formatUsd(undefined)).toBe('—');
    });

    it('returns — for NaN', () => {
      expect(formatUsd(Number.NaN)).toBe('—');
    });

    it('returns — for Infinity', () => {
      expect(formatUsd(Number.POSITIVE_INFINITY)).toBe('—');
    });
  });

  describe('normal values', () => {
    it('renders 0 as $0.00', () => {
      expect(formatUsd(0)).toBe('$0.00');
    });

    it('renders 12.34 with 2 decimals', () => {
      expect(formatUsd(12.34)).toBe('$12.34');
    });

    it('renders 1234.56 with thousands separators', () => {
      expect(formatUsd(1234.56)).toBe('$1,234.56');
    });

    it('renders negative values with leading minus', () => {
      expect(formatUsd(-12.34)).toBe('-$12.34');
    });
  });

  describe('sub-dollar values', () => {
    it('renders 0.0042 with 4 decimals', () => {
      expect(formatUsd(0.0042)).toBe('$0.0042');
    });

    it('renders 0.5 with 4 decimals', () => {
      expect(formatUsd(0.5)).toBe('$0.5000');
    });
  });

  describe('compact mode', () => {
    it('renders thousands as $Nk', () => {
      expect(formatUsd(1200, { compact: true })).toBe('$1.2k');
    });

    it('renders millions as $NM', () => {
      expect(formatUsd(3_400_000, { compact: true })).toBe('$3.4M');
    });

    it('renders billions as $NB', () => {
      expect(formatUsd(2_500_000_000, { compact: true })).toBe('$2.5B');
    });

    it('renders sub-thousand compact values normally', () => {
      expect(formatUsd(12, { compact: true })).toBe('$12.00');
    });
  });
});
