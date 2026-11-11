/**
 * The stateless token strategy, masking and restoring, by example.
 * `properties.test.ts` checks the round trip over generated inputs.
 */
import { describe, expect, it } from 'vitest';
import { maskText, PLACEHOLDER_INSTRUCTION } from '@/lib/privacy/pii/mask';
import { ENTITY_TYPE_PATTERN } from '@/lib/privacy/adapters/types';
import {
  placeholderPattern,
  TYPE_CHAR,
  TYPE_FIRST_CHAR,
} from '@/lib/privacy/pii/placeholder-grammar';
import { restoreText, restoreValue } from '@/lib/privacy/pii/restore';
import {
  formatPlaceholder,
  STATELESS_TOKEN_STRATEGY_ID,
  statelessTokenStrategy,
} from '@/lib/privacy/pii/token-strategy';

const newSession = () => statelessTokenStrategy().createSession({ scopeId: 's' });

describe('statelessTokenStrategy', () => {
  it('is core, and says it stores nothing', () => {
    const strategy = statelessTokenStrategy();
    expect(strategy.id).toBe(STATELESS_TOKEN_STRATEGY_ID);
    expect(strategy.persistent).toBe(false);
  });

  it('numbers by first appearance within each type', () => {
    const s = newSession();
    expect(s.placeholderFor('PERSON', 'James Hart')).toBe('[PERSON_1]');
    expect(s.placeholderFor('ORG', 'Halden Ltd')).toBe('[ORG_1]');
    expect(s.placeholderFor('PERSON', 'Priya Sharma')).toBe('[PERSON_2]');
    expect(s.placeholderFor('PERSON', 'James Hart')).toBe('[PERSON_1]');
  });

  it('gives a value one placeholder whatever type it is reported as', () => {
    const s = newSession();
    expect(s.placeholderFor('ORG', 'Halden')).toBe('[ORG_1]');
    expect(s.placeholderFor('PERSON', 'Halden')).toBe('[ORG_1]');
  });

  it('treats values that differ in case as different values', () => {
    // Restoring must give back exactly what was masked.
    const s = newSession();
    expect(s.placeholderFor('PERSON', 'James')).not.toBe(s.placeholderFor('PERSON', 'JAMES'));
  });

  it('maps a placeholder back, and knows nothing it did not issue', () => {
    const s = newSession();
    s.placeholderFor('EMAIL', 'a@example.com');
    expect(s.valueFor('[EMAIL_1]')).toBe('a@example.com');
    expect(s.valueFor('[EMAIL_2]')).toBeUndefined();
    expect(s.entries()).toEqual([
      { placeholder: '[EMAIL_1]', type: 'EMAIL', value: 'a@example.com' },
    ]);
  });

  it('starts every session empty: nothing carries from one call to the next', () => {
    const strategy = statelessTokenStrategy();
    const first = strategy.createSession({ scopeId: 's' });
    first.placeholderFor('PERSON', 'James Hart');
    expect(strategy.createSession({ scopeId: 's' }).entries()).toEqual([]);
  });

  it('cannot be changed through what entries() returns', () => {
    const s = newSession();
    s.placeholderFor('PERSON', 'James Hart');
    const [entry] = s.entries();
    entry.value = 'someone else';
    expect(s.valueFor('[PERSON_1]')).toBe('James Hart');
  });
});

describe('maskText', () => {
  it('replaces each span with its placeholder and counts them by type', () => {
    const s = newSession();
    const text = 'Email James Hart at j.hart@example.com; James Hart agreed.';
    const result = maskText(
      text,
      [
        { type: 'PERSON', start: 6, end: 16 },
        { type: 'EMAIL', start: 20, end: 38 },
        { type: 'PERSON', start: 40, end: 50 },
      ],
      s,
      []
    );
    expect(result.text).toBe('Email [PERSON_1] at [EMAIL_1]; [PERSON_1] agreed.');
    expect(result.counts).toEqual({ PERSON: 2, EMAIL: 1 });
  });

  it('merges overlapping spans rather than dropping one', () => {
    const s = newSession();
    const result = maskText(
      'at 14 Acacia Avenue',
      [
        { type: 'ADDRESS', start: 3, end: 15 },
        { type: 'LOCATION', start: 6, end: 19 },
      ],
      s,
      []
    );
    expect(result.text).toBe('at [ADDRESS_1]');
    expect(s.valueFor('[ADDRESS_1]')).toBe('14 Acacia Avenue');
  });

  it('masks text that already looks like a placeholder, so it comes back as written', () => {
    const s = newSession();
    const text = 'The template uses [PERSON_1] and PERSON_2 for names.';
    const masked = maskText(text, [], s, []);
    expect(masked.text).toBe('The template uses [LITERAL_1] and [LITERAL_2] for names.');
    // Look-alikes are counted apart: they are not detections.
    expect(masked.counts).toEqual({});
    expect(masked.literals).toBe(2);
    expect(restoreText(masked.text, s).text).toBe(text);
  });

  it('catches a look-alike a span cuts through, and one masking would create', () => {
    const s = newSession();
    // A span over "2]" leaves "[PERSON_1" behind; restoring it must not
    // become someone's name.
    const cut = '[PERSON_12] here';
    const masked = maskText(cut, [{ type: 'DATE', start: 9, end: 11 }], s, []);
    expect(restoreText(masked.text, s).text).toBe(cut);
    // "PERSON_1x" is not a look-alike, but with "x" masked it would become
    // "PERSON_1[…]", which is.
    const s2 = newSession();
    s2.placeholderFor('PERSON', 'James Hart');
    const made = maskText('PERSON_1x', [{ type: 'PERSON', start: 8, end: 9 }], s2, []);
    expect(restoreText(made.text, s2).text).toBe('PERSON_1x');
  });

  it('masks a look-alike of a declared type before any value of that type appears', () => {
    // A fork's detector declares US_SSN. An early message carries the
    // look-alike; a later one in the same call carries a real SSN.
    const s = newSession();
    const early = maskText('Ref: US_SSN_1', [], s, ['US_SSN']);
    maskText('SSN 123-45-6789', [{ type: 'US_SSN', start: 4, end: 15 }], s, ['US_SSN']);
    expect(early.text).toBe('Ref: [LITERAL_1]');
    expect(restoreText('Your ref US_SSN_1 and [LITERAL_1]', s).text).toBe(
      'Your ref 123-45-6789 and US_SSN_1'
    );
  });

  it('can leave look-alikes alone when nothing will be restored', () => {
    const s = newSession();
    const result = maskText(
      'Template [PERSON_2] for James',
      [{ type: 'PERSON', start: 24, end: 29 }],
      s,
      [],
      {
        escapeLookAlikes: false,
      }
    );
    expect(result.text).toBe('Template [PERSON_2] for [PERSON_1]');
    expect(result.literals).toBe(0);
  });

  it('leaves identifiers that only resemble a placeholder alone', () => {
    const s = newSession();
    expect(maskText('MY_PERSON_1 HTTP_2 UTF_8', [], s, []).text).toBe('MY_PERSON_1 HTTP_2 UTF_8');
  });

  it('ignores an empty span', () => {
    expect(maskText('abc', [{ type: 'PERSON', start: 1, end: 1 }], newSession(), []).text).toBe(
      'abc'
    );
  });

  it('has a short instruction for the model that shows the format', () => {
    expect(PLACEHOLDER_INSTRUCTION).toContain(formatPlaceholder('PERSON', 1));
    expect(PLACEHOLDER_INSTRUCTION.length).toBeLessThan(250);
  });
});

describe('restoreText', () => {
  function issued() {
    const s = newSession();
    s.placeholderFor('PERSON', 'James Hart');
    s.placeholderFor('EMAIL', 'j.hart@example.com');
    s.placeholderFor('UK_NINO', 'TJ 33 15 36 A');
    return s;
  }

  it.each([
    ['[PERSON_1]', 'James Hart'],
    ['PERSON_1', 'James Hart'],
    // A lone bracket is restored around, not swallowed: it may be the model's own.
    ['[PERSON_1', '[James Hart'],
    ['PERSON_1]', 'James Hart]'],
    ["[PERSON_1]'s", "James Hart's"],
    ["PERSON_1's", "James Hart's"],
    ['"to":"[EMAIL_1]"', '"to":"j.hart@example.com"'],
    ['[UK_NINO_1]', 'TJ 33 15 36 A'],
  ])('restores %j leniently', (input, expected) => {
    expect(restoreText(input, issued()).text).toBe(expected);
  });

  it('reports a made-up placeholder of a declared fork type when told the type', () => {
    expect(restoreText('Ref [US_SSN_3]', issued()).unresolved).toEqual([]);
    expect(restoreText('Ref [US_SSN_3]', issued(), ['US_SSN']).unresolved).toEqual(['[US_SSN_3]']);
  });

  it('keeps the brackets of a Markdown link the model wrote around a placeholder', () => {
    expect(restoreText('[Contact PERSON_1](mailto:EMAIL_1)', issued()).text).toBe(
      '[Contact James Hart](mailto:j.hart@example.com)'
    );
    expect(restoreText('[PERSON_1 and others](https://x.example)', issued()).text).toBe(
      '[James Hart and others](https://x.example)'
    );
  });

  it('leaves a placeholder it never issued visible, and reports it', () => {
    const r = restoreText('Ask [PERSON_9], not PERSON_01', issued());
    expect(r.text).toBe('Ask [PERSON_9], not PERSON_01');
    expect(r.restored).toBe(0);
    expect(r.unresolved).toEqual(['[PERSON_9]', 'PERSON_01']);
  });

  it('does not touch a placeholder inside a longer identifier', () => {
    expect(restoreText('MY_PERSON_1 and PERSON_12', issued()).text).toBe(
      'MY_PERSON_1 and PERSON_12'
    );
  });

  it('counts what it restored', () => {
    expect(restoreText('[PERSON_1], PERSON_1 and [EMAIL_1]', issued()).restored).toBe(3);
  });
});

describe('restoreValue', () => {
  it('restores strings at any depth of objects and arrays, keys included', () => {
    const s = newSession();
    s.placeholderFor('PERSON', 'James Hart');
    s.placeholderFor('EMAIL', 'j.hart@example.com');
    const r = restoreValue(
      {
        to: ['[EMAIL_1]', { cc: '[PERSON_1]' }],
        nested: { deeper: [[{ name: 'PERSON_1' }]] },
        '[EMAIL_1]': 'cc',
        count: 2,
        ok: true,
        none: null,
      },
      s
    );
    expect(r.value).toEqual({
      to: ['j.hart@example.com', { cc: 'James Hart' }],
      nested: { deeper: [[{ name: 'James Hart' }]] },
      'j.hart@example.com': 'cc',
      count: 2,
      ok: true,
      none: null,
    });
    expect(r.restored).toBe(4);
  });

  it('keeps a key whose restored form another key already spells, and reports it', () => {
    const s = newSession();
    s.placeholderFor('EMAIL', 'a@example.com');
    const r = restoreValue({ 'a@example.com': 'to', '[EMAIL_1]': 'cc' }, s);
    expect(r.value).toEqual({ 'a@example.com': 'to', '[EMAIL_1]': 'cc' });
    expect(r.unresolved).toEqual(['[EMAIL_1]']);
  });

  it('keeps a "__proto__" key as an ordinary key', () => {
    const s = newSession();
    const parsed: unknown = JSON.parse('{"__proto__": {"polluted": true}}');
    const r = restoreValue(parsed, s);
    expect(Object.keys(r.value as object)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('restores a value containing a quote without breaking anything', () => {
    const s = newSession();
    s.placeholderFor('ORG', 'The "Best" Café');
    const args = JSON.parse('{"company":"[ORG_1]"}') as unknown;
    expect(restoreValue(args, s).value).toEqual({ company: 'The "Best" Café' });
  });

  it('reports unresolved placeholders from anywhere inside', () => {
    const s = newSession();
    expect(restoreValue({ a: ['[PERSON_3]'] }, s).unresolved).toEqual(['[PERSON_3]']);
  });
});

describe('placeholder grammar', () => {
  it('prefers the longer type', () => {
    const pattern = placeholderPattern(['UK', 'UK_NINO']);
    expect([...'[UK_NINO_1]'.matchAll(pattern)].map((m) => m[2])).toEqual(['UK_NINO']);
  });

  it("refuses to build a pattern for no types: every caller passes core's", () => {
    expect(() => placeholderPattern([])).toThrow(/no types/);
  });

  it('keeps the number as written', () => {
    expect(formatPlaceholder('PERSON', '01')).toBe('[PERSON_01]');
  });

  it('reads types with the same characters ENTITY_TYPE_PATTERN allows', () => {
    // The stream's hold-back is built from these classes; if the type grammar
    // changed and they did not, a split placeholder would go out half-restored.
    const typeShape = new RegExp(`^${TYPE_FIRST_CHAR}${TYPE_CHAR}*$`);
    for (const t of ['A', 'PERSON', 'UK_NINO', 'X9_Y', 'LITERAL']) {
      expect(ENTITY_TYPE_PATTERN.test(t)).toBe(true);
      expect(typeShape.test(t)).toBe(true);
    }
    for (const t of ['a', '9X', '_X', 'Per-son']) {
      expect(ENTITY_TYPE_PATTERN.test(t)).toBe(false);
      expect(typeShape.test(t)).toBe(false);
    }
  });
});
