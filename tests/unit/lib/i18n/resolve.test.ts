/**
 * The locale resolution order (§138 t-1071): user → org → cookie →
 * Accept-Language → en. Each step is asserted to win over the steps after it
 * and to fall through when it names nothing supported.
 */
import { describe, expect, it } from 'vitest';
import { parseAcceptLanguage, resolveLocale } from '@/lib/i18n/resolve';

// `en-XA` is the only non-default locale Sunrise ships, so it stands in for
// "a second language" throughout.
const SECOND = 'en-XA';

describe('resolveLocale', () => {
  it('uses the user’s own choice over everything after it', () => {
    expect(
      resolveLocale({
        userLocale: SECOND,
        orgLocale: 'en',
        cookieLocale: 'en',
        acceptLanguage: 'en',
      })
    ).toEqual({ locale: SECOND, source: 'user' });
  });

  it('uses the org default when the user has none', () => {
    expect(
      resolveLocale({
        userLocale: null,
        orgLocale: SECOND,
        cookieLocale: 'en',
        acceptLanguage: 'en',
      })
    ).toEqual({ locale: SECOND, source: 'org' });
  });

  it('uses the visitor cookie when there is no user or org choice', () => {
    expect(resolveLocale({ cookieLocale: SECOND, acceptLanguage: 'en' })).toEqual({
      locale: SECOND,
      source: 'cookie',
    });
  });

  it('uses Accept-Language when nothing is stored', () => {
    expect(resolveLocale({ acceptLanguage: 'en-GB,en;q=0.9' })).toEqual({
      locale: 'en',
      source: 'accept-language',
    });
  });

  it('falls back to en when nothing names a supported locale', () => {
    expect(resolveLocale({ acceptLanguage: 'de-DE,fr;q=0.8' })).toEqual({
      locale: 'en',
      source: 'default',
    });
    expect(resolveLocale({})).toEqual({ locale: 'en', source: 'default' });
  });

  it('skips a stored locale that has no catalogue rather than trusting it', () => {
    // A locale an app registered and later removed: the user's stored `fr`
    // must not be served, and the org's default is used instead.
    expect(resolveLocale({ userLocale: 'fr', orgLocale: SECOND })).toEqual({
      locale: SECOND,
      source: 'org',
    });
    expect(resolveLocale({ userLocale: 'fr', orgLocale: 'de', cookieLocale: SECOND })).toEqual({
      locale: SECOND,
      source: 'cookie',
    });
  });

  it('skips a malformed stored value', () => {
    expect(resolveLocale({ userLocale: '<script>', cookieLocale: 'not a tag' })).toEqual({
      locale: 'en',
      source: 'default',
    });
  });

  it('serves a regional request from its base language', () => {
    expect(resolveLocale({ userLocale: 'en-US' })).toEqual({ locale: 'en', source: 'user' });
  });

  it('never picks the pseudo-locale for a plain en request', () => {
    expect(resolveLocale({ acceptLanguage: 'en' }).locale).toBe('en');
  });

  it('matches a stored locale case-insensitively, in its canonical spelling', () => {
    expect(resolveLocale({ cookieLocale: 'EN-xa' })).toEqual({ locale: SECOND, source: 'cookie' });
  });
});

describe('parseAcceptLanguage', () => {
  it('orders by weight, then by position', () => {
    expect(parseAcceptLanguage('fr;q=0.5, de, en-GB;q=0.8, es')).toEqual([
      'de',
      'es',
      'en-GB',
      'fr',
    ]);
  });

  it('drops refused, wildcard and malformed entries', () => {
    expect(parseAcceptLanguage('en;q=0, *, fr;q=abc, de;q=0.3, ;;')).toEqual(['de']);
  });

  it('returns nothing for a missing header', () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage('')).toEqual([]);
  });

  it('falls through a header to the first supported entry', () => {
    expect(resolveLocale({ acceptLanguage: 'de-DE, fr;q=0.9, en;q=0.1' })).toEqual({
      locale: 'en',
      source: 'accept-language',
    });
  });
});
