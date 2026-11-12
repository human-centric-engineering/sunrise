/**
 * Tests: lib/privacy/adapters/spans.ts — span validation and overlap
 * resolution (§127 t-988).
 */
import { describe, expect, it } from 'vitest';
import { MalformedSpansError, resolveOverlaps, validateSpans } from '@/lib/privacy/adapters/spans';
import type { AttributedSpan } from '@/lib/privacy/adapters/types';

const TEXT = 'Email priya@example.com or call 07700 900123.';
const DECLARED = new Set(['EMAIL', 'PHONE']);

function valid() {
  return { type: 'EMAIL', start: 6, end: 23, confidence: 1 };
}

describe('validateSpans', () => {
  it('accepts well-formed spans and attributes them to the detector', () => {
    expect(validateSpans([valid()], TEXT, 'acme.x', DECLARED)).toEqual([
      { type: 'EMAIL', start: 6, end: 23, confidence: 1, source: 'acme.x' },
    ]);
    expect(TEXT.slice(6, 23)).toBe('priya@example.com');
  });

  it('accepts a span ending exactly at the end of the text', () => {
    const end = TEXT.length;
    expect(validateSpans([{ ...valid(), start: end - 1, end }], TEXT, 'a', DECLARED)).toHaveLength(
      1
    );
  });

  it('keeps learned only when it is exactly true (t-1018)', () => {
    const flagged = (learned: unknown) =>
      validateSpans([{ ...valid(), learned }], TEXT, 'a', DECLARED)[0];
    expect(flagged(true)).toEqual({ ...valid(), source: 'a', learned: true });
    // Anything else is a span found where it stands, which is what a refusal
    // acts on: a malformed flag cannot hide where details are.
    for (const other of [false, 'true', 1, null, undefined]) {
      expect(flagged(other)).not.toHaveProperty('learned');
    }
  });

  it('drops unknown extra fields rather than passing them on', () => {
    const [span] = validateSpans([{ ...valid(), text: 'priya@example.com' }], TEXT, 'a', DECLARED);
    expect(span).not.toHaveProperty('text');
  });

  const rejects: [string, unknown, RegExp][] = [
    ['a result that is not an array', { spans: [] }, /not an array/],
    ['a span that is not an object', [null], /span 0 is not an object/],
    ['a span that is an array', [[1, 2]], /span 0 is not an object/],
    ['an invalid type name', [{ ...valid(), type: 'email' }], /span 0 has an invalid type/],
    ['a type the detector did not declare', [{ ...valid(), type: 'IBAN' }], /did not declare/],
    ['a fractional offset', [{ ...valid(), start: 6.5 }], /non-integer offset/],
    ['a string offset', [{ ...valid(), end: '23' }], /non-integer offset/],
    ['a negative start', [{ ...valid(), start: -1 }], /out of range/],
    ['an end past the text', [{ ...valid(), end: TEXT.length + 1 }], /out of range/],
    ['an empty span', [{ ...valid(), end: 6 }], /out of range/],
    ['a reversed span', [{ ...valid(), start: 23, end: 6 }], /out of range/],
    ['a confidence above 1', [{ ...valid(), confidence: 1.01 }], /invalid confidence/],
    ['a NaN confidence', [{ ...valid(), confidence: Number.NaN }], /invalid confidence/],
    ['a missing confidence', [{ type: 'EMAIL', start: 6, end: 23 }], /invalid confidence/],
  ];

  it.each(rejects)('rejects %s', (_name, result, message) => {
    expect(() => validateSpans(result, TEXT, 'acme.x', DECLARED)).toThrow(message);
  });

  it('rejects the whole result when one span is bad, rather than trusting the rest', () => {
    const result = [valid(), { ...valid(), start: 99, end: 120 }];
    expect(() => validateSpans(result, TEXT, 'acme.x', DECLARED)).toThrow(MalformedSpansError);
  });

  it('never quotes the text in its reason', () => {
    try {
      validateSpans([{ ...valid(), end: TEXT.length + 5 }], TEXT, 'acme.x', DECLARED);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedSpansError);
      expect(String(err)).not.toContain('priya');
    }
  });
});

function span(
  type: string,
  start: number,
  end: number,
  confidence: number,
  source = 'a'
): AttributedSpan {
  return { type, start, end, confidence, source };
}

describe('resolveOverlaps', () => {
  it('leaves non-overlapping spans alone and sorts them by start', () => {
    const a = span('EMAIL', 10, 20, 1);
    const b = span('PHONE', 0, 5, 1);
    expect(resolveOverlaps([a, b])).toEqual([b, a]);
  });

  it('keeps touching spans separate', () => {
    expect(resolveOverlaps([span('PERSON', 0, 5, 0.5), span('ORG', 5, 9, 0.5)])).toHaveLength(2);
  });

  it('merges overlapping spans into their union, so no part of either is left unmasked', () => {
    // "Mark" (a list guess) inside a suffixed company name, plus a partial overlap.
    const merged = resolveOverlaps([
      span('ORG', 0, 20, 0.8),
      span('PERSON', 0, 4, 0.4),
      span('ADDRESS', 18, 30, 0.6),
    ]);

    expect(merged).toEqual([{ type: 'ORG', start: 0, end: 30, confidence: 0.8, source: 'a' }]);
  });

  it('marks a merged span learned only when every member was (t-1018)', () => {
    const learned = (s: AttributedSpan): AttributedSpan => ({ ...s, learned: true });
    // One member found where it stands makes the union a finding of its own.
    expect(
      resolveOverlaps([learned(span('PERSON', 0, 6, 0.7)), span('PERSON', 0, 12, 0.75)])[0]
    ).not.toHaveProperty('learned');
    expect(
      resolveOverlaps([learned(span('PERSON', 0, 6, 0.7)), learned(span('ORG', 3, 9, 0.75))])
    ).toEqual([{ type: 'ORG', start: 0, end: 9, confidence: 0.75, source: 'a', learned: true }]);
    expect(resolveOverlaps([learned(span('PERSON', 0, 6, 0.7))])[0].learned).toBe(true);
  });

  it('names the merged span after its most confident member', () => {
    const merged = resolveOverlaps([span('PHONE', 0, 11, 0.6), span('NHS_NUMBER', 0, 10, 1)]);
    expect(merged[0].type).toBe('NHS_NUMBER');
  });

  it('breaks a confidence tie by length, then by registration rank', () => {
    expect(resolveOverlaps([span('A', 0, 4, 0.5), span('B', 0, 6, 0.5)])[0].type).toBe('B');

    const rank = new Map([
      ['core.rules', 0],
      ['acme.x', 1],
    ]);
    const merged = resolveOverlaps(
      [span('APP', 0, 6, 0.5, 'acme.x'), span('CORE', 0, 6, 0.5, 'core.rules')],
      rank
    );
    expect(merged[0].type).toBe('CORE');
  });

  it('gives the same answer whatever order the spans arrive in', () => {
    const spans = [
      span('ORG', 0, 20, 0.8, 'x'),
      span('PERSON', 0, 4, 0.8, 'y'),
      span('ADDRESS', 18, 30, 0.6, 'z'),
      span('EMAIL', 40, 50, 1, 'x'),
      span('PHONE', 45, 55, 1, 'y'),
    ];
    const expected = resolveOverlaps(spans);
    for (let i = 0; i < 50; i++) {
      const shuffled = [...spans].sort(() => Math.random() - 0.5);
      expect(resolveOverlaps(shuffled)).toEqual(expected);
    }
  });

  it('returns nothing for nothing', () => {
    expect(resolveOverlaps([])).toEqual([]);
  });
});
