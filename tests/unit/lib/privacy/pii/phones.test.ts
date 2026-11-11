import { describe, expect, it } from 'vitest';
import { phoneCandidates, phoneDigitsPattern, toE164 } from '@/lib/privacy/pii/phones';

function found(text: string) {
  return phoneCandidates(text).map((c) => [text.slice(c.start, c.end), c.e164, c.valid]);
}

describe('phoneCandidates', () => {
  it('finds valid numbers with their E.164 form', () => {
    expect(found('Ring 020 7946 0958 or +44 161 496 0254.')).toEqual([
      ['020 7946 0958', '+442079460958', true],
      ['+44 161 496 0254', '+441614960254', true],
    ]);
  });

  it('finds a number in a reserved range as possible, not valid', () => {
    expect(found('Mobile 07700 900123')).toEqual([['07700 900123', '+447700900123', false]]);
  });

  it('finds two possible numbers written one after the other', () => {
    expect(found('call 07700 900123 07700 900456')).toEqual([
      ['07700 900123', '+447700900123', false],
      ['07700 900456', '+447700900456', false],
    ]);
  });

  it('finds a possible number beside a valid one in the same run', () => {
    expect(found('ring 020 7946 0958 07700 900123').map(([t]) => t)).toEqual([
      '020 7946 0958',
      '07700 900123',
    ]);
  });

  it('does not report a valid number twice', () => {
    expect(found('Ring 020 7946 0958')).toHaveLength(1);
  });

  it('ignores digit runs that are no phone number', () => {
    expect(found('Order 12345 shipped, 2 items, ref 99-1')).toEqual([]);
  });

  it('uses UTF-16 offsets after astral characters', () => {
    expect(found('😀😀 020 7946 0958')[0][0]).toBe('020 7946 0958');
  });
});

describe('phoneDigitsPattern', () => {
  const matchesIn = (e164: string, text: string) =>
    [...text.matchAll(phoneDigitsPattern(e164) ?? /$^/g)].map((m) => m[0]);

  it('matches the number written nationally or internationally, however separated', () => {
    expect(
      matchesIn('+447700900515', '07700900515, 07700 900 515, +44 7700-900515, 0044 (0)7700 900515')
    ).toEqual(['07700900515', '07700 900 515', '+44 7700-900515', '0044 (0)7700 900515']);
  });

  it('does not match inside a longer run of digits', () => {
    expect(matchesIn('+447700900515', '1077009005159')).toEqual([]);
  });

  it('returns null for something that is not a phone number', () => {
    expect(phoneDigitsPattern('not a number')).toBeNull();
  });
});

describe('toE164', () => {
  it('normalises any spelling of one number to the same value', () => {
    expect(toE164('07700 900515')).toBe('+447700900515');
    expect(toE164('+44 (0)7700-900515')).toBe('+447700900515');
  });

  it('returns null for something that is not a phone number', () => {
    expect(toE164('12')).toBeNull();
    expect(toE164('not a number')).toBeNull();
  });
});
