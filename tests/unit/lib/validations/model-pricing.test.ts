/**
 * Unit tests: Model Matrix chat pricing rules (t-774).
 *
 * These helpers are the one statement of the pair rule, the price bound and
 * the approval screen's string-to-number reading, so every writer of the
 * split prices agrees.
 *
 * @see lib/validations/model-pricing.ts
 */

import { describe, it, expect } from 'vitest';

import {
  hasSplitPricing,
  isHalfPrice,
  MAX_PRICE_PER_MILLION_TOKENS,
  numericStringToNumber,
  splitPriceInputSchema,
  splitPriceSchema,
} from '@/lib/validations/model-pricing';

describe('isHalfPrice', () => {
  it.each([
    [3, 15, false],
    [null, null, false],
    [undefined, undefined, false],
    [null, undefined, false],
    [0, 0, false],
    [3, null, true],
    [null, 15, true],
    [undefined, 15, true],
    [0, null, true],
  ])('(%s, %s) → %s', (input, output, expected) => {
    expect(isHalfPrice(input, output)).toBe(expected);
  });
});

describe('hasSplitPricing', () => {
  it('is true for chat and for reasoning models', () => {
    expect(hasSplitPricing(['chat'])).toBe(true);
    expect(hasSplitPricing(['reasoning'])).toBe(true);
    expect(hasSplitPricing(['chat', 'embedding'])).toBe(true);
  });

  it('is false for models priced some other way', () => {
    expect(hasSplitPricing(['embedding'])).toBe(false);
    expect(hasSplitPricing(['audio', 'image'])).toBe(false);
    expect(hasSplitPricing([])).toBe(false);
  });
});

describe('splitPriceSchema', () => {
  it('accepts 0 through the bound', () => {
    expect(splitPriceSchema.safeParse(0).success).toBe(true);
    expect(splitPriceSchema.safeParse(MAX_PRICE_PER_MILLION_TOKENS).success).toBe(true);
  });

  it('rejects negatives, values above the bound, and strings', () => {
    expect(splitPriceSchema.safeParse(-1).success).toBe(false);
    expect(splitPriceSchema.safeParse(MAX_PRICE_PER_MILLION_TOKENS + 0.01).success).toBe(false);
    expect(splitPriceSchema.safeParse('3').success).toBe(false);
  });
});

describe('numericStringToNumber / splitPriceInputSchema', () => {
  it('reads a numeric string as the number it spells', () => {
    expect(numericStringToNumber('3.5')).toBe(3.5);
    expect(numericStringToNumber(' 16 ')).toBe(16);
    expect(splitPriceInputSchema.parse('0.15')).toBe(0.15);
  });

  it('returns anything else as given, for the schema to judge', () => {
    expect(numericStringToNumber('')).toBe('');
    expect(numericStringToNumber('1e')).toBe('1e');
    expect(numericStringToNumber('1e3')).toBe('1e3');
    expect(numericStringToNumber('0x10')).toBe('0x10');
    expect(numericStringToNumber('0b11')).toBe('0b11');
    expect(numericStringToNumber('-1')).toBe('-1');
    expect(numericStringToNumber(null)).toBeNull();
    expect(numericStringToNumber(4)).toBe(4);
    expect(splitPriceInputSchema.safeParse('1e').success).toBe(false);
    expect(splitPriceInputSchema.safeParse('-1').success).toBe(false);
  });
});
