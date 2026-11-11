/**
 * Tier B: matching what the layer already knows, in the forms people write
 * it. Assertions name the exact text covered.
 */
import { describe, expect, it } from 'vitest';
import { CORE_ENTITY_TYPES, type KnownValue } from '@/lib/privacy/adapters/types';
import {
  findKnownValueSpans,
  KNOWN_VALUE_CONFIDENCE,
  KNOWN_VALUES_DETECTOR_ID,
  knownValuesDetector,
  VARIANT_CONFIDENCE,
} from '@/lib/privacy/pii/known-values';

function found(text: string, known: KnownValue[]): [string, string, number][] {
  return findKnownValueSpans(text, known)
    .map((s): [string, string, number, number] => [
      s.type,
      text.slice(s.start, s.end),
      s.confidence,
      s.start,
    ])
    .sort((a, b) => a[3] - b[3])
    .map(([type, t, c]) => [type, t, c]);
}

const person = (value: string): KnownValue => ({ type: 'PERSON', value });

describe('findKnownValueSpans — people', () => {
  it('finds the full name in any case and spacing, as a known value', () => {
    // Its parts match too, inside it; the overlap merge folds them into the
    // full name, which keeps the higher confidence.
    expect(found('i am james   HART, hello', [person('James Hart')])).toEqual([
      ['PERSON', 'james   HART', KNOWN_VALUE_CONFIDENCE],
      ['PERSON', 'james', VARIANT_CONFIDENCE],
      ['PERSON', 'HART', VARIANT_CONFIDENCE],
    ]);
  });

  it('finds the first and last name alone, as variants', () => {
    expect(found('James said Hart would call.', [person('James Hart')])).toEqual([
      ['PERSON', 'James', VARIANT_CONFIDENCE],
      ['PERSON', 'Hart', VARIANT_CONFIDENCE],
    ]);
  });

  it('finds an initial and surname, and the surname-first form', () => {
    expect(found('Signed J. Hart; filed as Hart, James', [person('James Hart')])).toEqual(
      expect.arrayContaining([
        ['PERSON', 'J. Hart', VARIANT_CONFIDENCE],
        ['PERSON', 'Hart, James', VARIANT_CONFIDENCE],
      ])
    );
  });

  it('matches a name part that is also a word only when capitalised', () => {
    // The user called Will Hart does not have every "will" masked.
    expect(found('I will ask Will.', [person('Will Hart')])).toEqual([
      ['PERSON', 'Will', VARIANT_CONFIDENCE],
    ]);
  });

  it('keeps a word-like first name capitalised in the reordered forms too', () => {
    expect(found('Hart may call later', [person('May Hart')])).toEqual([
      ['PERSON', 'Hart', VARIANT_CONFIDENCE],
    ]);
    expect(found('Filed as Hart May', [person('May Hart')])).toContainEqual([
      'PERSON',
      'Hart May',
      VARIANT_CONFIDENCE,
    ]);
  });

  it('leaves a title or suffix out of the name parts', () => {
    expect(found('Ask Dr. Patel, then Hart', [person('Dr. Jane Hart')])).toEqual([
      ['PERSON', 'Hart', VARIANT_CONFIDENCE],
    ]);
    expect(found('Jr. staff and Hart', [person('Jane Hart Jr.')])).toEqual([
      ['PERSON', 'Hart', VARIANT_CONFIDENCE],
    ]);
  });

  it('finds a known name after text that lower-casing lengthens', () => {
    // "İ" lower-cases to two code units, so lower-case positions drift.
    const text = `${'İ'.repeat(200)} contact Jane Hart today`;
    expect(found(text, [person('Jane Hart')])).toContainEqual([
      'PERSON',
      'Jane Hart',
      KNOWN_VALUE_CONFIDENCE,
    ]);
  });

  it('does not match inside a longer word', () => {
    expect(found('Hartley and Jamesons', [person('James Hart')])).toEqual([]);
  });

  it('does not offer a part shorter than three letters alone', () => {
    expect(found('Jo said yes', [person('Jo Bloggs')])).toEqual([]);
  });
});

describe('findKnownValueSpans — companies and other values', () => {
  it('finds a company with and without its legal suffix', () => {
    expect(
      found('Halden Logistics Ltd, or just Halden Logistics', [
        { type: 'ORG', value: 'Halden Logistics Ltd' },
      ])
    ).toEqual(
      expect.arrayContaining([
        ['ORG', 'Halden Logistics Ltd', KNOWN_VALUE_CONFIDENCE],
        ['ORG', 'Halden Logistics', VARIANT_CONFIDENCE],
      ])
    );
  });

  it('matches a word-named company without its suffix only capitalised', () => {
    const spans = found('What is next? Next PLC called.', [{ type: 'ORG', value: 'Next PLC' }]);
    expect(spans.map(([, t]) => t)).not.toContain('next');
    expect(spans).toContainEqual(['ORG', 'Next PLC', KNOWN_VALUE_CONFIDENCE]);
  });

  it('finds any other value exactly, ignoring case', () => {
    expect(found('Project KINGFISHER is late', [{ type: 'ORG', value: 'Kingfisher' }])).toEqual([
      ['ORG', 'KINGFISHER', KNOWN_VALUE_CONFIDENCE],
    ]);
  });

  it('treats a value as a literal, not a pattern', () => {
    expect(
      found('pay a.b+c@example.com or axb+c@exampleXcom', [
        { type: 'EMAIL', value: 'a.b+c@example.com' },
      ])
    ).toEqual([['EMAIL', 'a.b+c@example.com', KNOWN_VALUE_CONFIDENCE]]);
  });
});

describe('findKnownValueSpans — phone numbers', () => {
  it('finds a known number however it is spaced or prefixed', () => {
    const spans = found('Call +44 7700 900515 or 07700-900-515', [
      { type: 'PHONE', value: '07700900515' },
    ]);
    expect(spans.map(([, t]) => t)).toEqual(
      expect.arrayContaining(['+44 7700 900515', '07700-900-515'])
    );
    expect(spans.every(([type]) => type === 'PHONE')).toBe(true);
  });

  it('finds a known number in brackets or with an international prefix', () => {
    const spans = found('Ring (07700) 900515 or 0044 (0)7700-900515', [
      { type: 'PHONE', value: '+447700900515' },
    ]).map(([, t]) => t);
    expect(spans).toEqual(['(07700) 900515', '0044 (0)7700-900515']);
  });

  it('does not report a different number', () => {
    expect(found('Call 07700 900516', [{ type: 'PHONE', value: '07700900515' }])).toEqual([]);
  });
});

describe('findKnownValueSpans — what it refuses', () => {
  it('skips a type it does not declare, so the result is never malformed', () => {
    expect(found('Ref ABC-123', [{ type: 'POLICY_NUMBER', value: 'ABC-123' }])).toEqual([]);
  });

  it('skips a value under three characters', () => {
    expect(found('id 42 here', [{ type: 'ORG', value: '42' }])).toEqual([]);
  });

  it('finds nothing when it knows nothing', () => {
    expect(found('James Hart', [])).toEqual([]);
  });
});

describe('findKnownValueSpans — cost', () => {
  it('costs little for known values the text never mentions', () => {
    // Every value used to run all of its patterns over the whole text.
    const text = 'nothing relevant here at all. '.repeat(4000);
    const many = Array.from({ length: 300 }, (_, i) => person(`Firstname${i} Surname${i}`));
    const t0 = performance.now();
    expect(findKnownValueSpans(text, many)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe('knownValuesDetector', () => {
  const ctx = (knownValues: KnownValue[], signal = new AbortController().signal) => ({
    signal,
    scopeId: 's',
    knownValues,
    priorSpans: [],
  });

  it('declares every core type and reads ctx.knownValues', async () => {
    const detector = knownValuesDetector();
    expect(detector.id).toBe(KNOWN_VALUES_DETECTOR_ID);
    expect(detector.egress).toBe('in_process');
    expect(detector.entityTypes).toEqual(CORE_ENTITY_TYPES);
    const spans = await detector.detect({ text: 'Hi James Hart' }, ctx([person('James Hart')]));
    expect(spans).toContainEqual({
      type: 'PERSON',
      start: 3,
      end: 13,
      confidence: KNOWN_VALUE_CONFIDENCE,
    });
  });

  it('rejects when its signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(
      knownValuesDetector().detect({ text: 'x' }, ctx([], controller.signal))
    ).rejects.toThrow('gone');
  });
});
