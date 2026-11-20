/**
 * The pseudo-locale (§138 t-1071). What can go wrong is the ICU structure:
 * an argument name, a plural keyword or a tag rewritten would break the
 * message, so each case formats the result and checks the values still land.
 */
import { describe, expect, it } from 'vitest';
import { IntlMessageFormat } from 'intl-messageformat';
import { pseudoLocalize, pseudoLocalizeMessage } from '@/lib/i18n/pseudo';
import { messagesFor, sourceMessages } from '@/lib/i18n/catalogue';

function format(message: string, values?: Record<string, unknown>): string {
  return String(new IntlMessageFormat(message, 'en').format(values as never));
}

function leafKeys(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [prefix + key] : leafKeys(value as object, `${prefix}${key}.`)
  );
}

describe('pseudoLocalizeMessage', () => {
  it('accents and brackets plain text', () => {
    expect(pseudoLocalizeMessage('Save')).toBe('[Šåṽé]');
  });

  it('keeps argument names', () => {
    expect(format(pseudoLocalizeMessage('Hello {name}'), { name: 'Ada' })).toBe('[Ĥéļļö Ada]');
  });

  it('keeps plural keywords and #, and rewrites each branch', () => {
    const message = pseudoLocalizeMessage('{count, plural, one {# item} other {# items}}');
    expect(format(message, { count: 1 })).toBe('[1 îţéɱ]');
    expect(format(message, { count: 3 })).toBe('[3 îţéɱš]');
  });

  it('keeps select keys', () => {
    const message = pseudoLocalizeMessage('{g, select, female {She} other {They}} left');
    expect(format(message, { g: 'female' })).toBe('[Šĥé ļéƒţ]');
  });

  it('keeps rich-text tag names and rewrites their content', () => {
    const message = pseudoLocalizeMessage('Read <link>the terms</link>');
    const out = new IntlMessageFormat(message, 'en').format({
      link: (chunks: unknown) => `<a>${String(chunks)}</a>`,
    });
    expect(Array.isArray(out) ? out.join('') : out).toBe('[Ŕéåð <a>ţĥé ţéŕɱš</a>]');
  });

  it('keeps number and date arguments', () => {
    const message = pseudoLocalizeMessage('{n, number} at {d, date, short}');
    expect(message).toContain('{n, number}');
    expect(message).toContain('{d, date, short}');
  });

  it('keeps escaped literals as literals', () => {
    expect(format(pseudoLocalizeMessage("It's '{'literal'}'"))).toBe("[Îţ'š {ļîţéŕåļ}]");
  });

  it('throws on a message that is not valid ICU', () => {
    expect(() => pseudoLocalizeMessage('Hello {name')).toThrow();
  });
});

describe('the catalogue', () => {
  it('has the same keys in the pseudo-locale as in en', () => {
    const en = leafKeys(sourceMessages());
    expect(en.length).toBeGreaterThan(0);
    expect(leafKeys(messagesFor('en-XA'))).toEqual(en);
  });

  it('turns every en message into a different, valid pseudo message', () => {
    const pseudo = pseudoLocalize(sourceMessages());
    const en = sourceMessages();
    for (const key of leafKeys(en)) {
      const path = key.split('.');
      const source = path.reduce<unknown>((node, k) => (node as Record<string, unknown>)[k], en);
      const translated = path.reduce<unknown>(
        (node, k) => (node as Record<string, unknown>)[k],
        pseudo
      );
      expect(translated, key).not.toBe(source);
      expect(() => new IntlMessageFormat(translated as string, 'en')).not.toThrow();
    }
  });

  it('serves en for a locale with no catalogue', () => {
    expect(messagesFor('fr')).toBe(sourceMessages());
  });
});
