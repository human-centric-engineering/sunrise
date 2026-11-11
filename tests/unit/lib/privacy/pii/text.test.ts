import { describe, expect, it } from 'vitest';
import {
  allMatches,
  coverage,
  escapeRegExp,
  hasContextBefore,
  overlapsAny,
  span,
} from '@/lib/privacy/pii/text';

describe('allMatches', () => {
  it('returns every match with its index', () => {
    expect(allMatches(/\d+/g, 'a1 b22 c333').map((m) => [m[0], m.index])).toEqual([
      ['1', 1],
      ['22', 4],
      ['333', 8],
    ]);
  });

  it('leaves the caller’s pattern untouched, so calls cannot interfere', () => {
    const shared = /\d/g;
    allMatches(shared, '123');
    expect(shared.lastIndex).toBe(0);
    expect(allMatches(shared, '45')).toHaveLength(2);
  });

  it('works on a pattern without the g flag', () => {
    expect(allMatches(/x/, 'x x')).toHaveLength(2);
  });

  it('does not loop on a pattern that can match empty', () => {
    expect(allMatches(/a*/g, 'bab').map((m) => m[0])).toEqual(['', 'a', '', '']);
  });
});

describe('allMatches with an owned pattern', () => {
  it('runs the pattern as it is, and leaves it ready for the next text', () => {
    const own = /\d+/g;
    expect(allMatches(own, 'a1 b22', true).map((m) => m[0])).toEqual(['1', '22']);
    expect(own.lastIndex).toBe(0);
    expect(allMatches(own, '333', true).map((m) => m[0])).toEqual(['333']);
  });

  it('copies a pattern without the g flag even when owned', () => {
    expect(allMatches(/x/, 'x x', true)).toHaveLength(2);
  });
});

describe('hasContextBefore', () => {
  it('looks only within the window before the start', () => {
    const text = 'passport number is 123';
    expect(hasContextBefore(text, 19, /passport/, 40)).toBe(true);
    expect(hasContextBefore(text, 19, /passport/, 5)).toBe(false);
    expect(hasContextBefore(text, 19, /123/, 40)).toBe(false);
  });
});

describe('escapeRegExp', () => {
  it('makes every special character literal', () => {
    const literal = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    expect(new RegExp(`^${escapeRegExp(literal)}$`).test(literal)).toBe(true);
    expect(new RegExp(escapeRegExp('a.b')).test('axb')).toBe(false);
  });
});

describe('coverage', () => {
  it('answers whether a range lies wholly inside the spans, merged', () => {
    const covered = coverage([
      { start: 10, end: 20 },
      { start: 0, end: 5 },
      { start: 18, end: 30 },
    ]);
    expect(covered(0, 5)).toBe(true);
    expect(covered(12, 28)).toBe(true); // across two overlapping spans
    expect(covered(4, 11)).toBe(false); // straddles a gap
    expect(covered(30, 31)).toBe(false);
    expect(coverage([])(0, 1)).toBe(false);
  });

  it('does not change the spans it was given', () => {
    const spans = [
      { start: 5, end: 9 },
      { start: 0, end: 6 },
    ];
    coverage(spans);
    expect(spans).toEqual([
      { start: 5, end: 9 },
      { start: 0, end: 6 },
    ]);
  });
});

describe('overlapsAny and span', () => {
  it('treats touching ranges as not overlapping', () => {
    expect(overlapsAny(5, 10, [{ start: 0, end: 5 }])).toBe(false);
    expect(overlapsAny(5, 10, [{ start: 9, end: 12 }])).toBe(true);
    expect(overlapsAny(5, 10, [])).toBe(false);
  });

  it('builds a span', () => {
    expect(span('EMAIL', 1, 4, 1)).toEqual({ type: 'EMAIL', start: 1, end: 4, confidence: 1 });
  });
});
