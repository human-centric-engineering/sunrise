import { describe, expect, it } from 'vitest';
import {
  canonicalSupportedLocale,
  DEFAULT_LOCALE,
  isLanguageTag,
  isSupportedLocale,
  matchSupportedLocale,
  PSEUDO_LOCALE,
  supportedLocales,
} from '@/lib/i18n/locales';

describe('supported locales', () => {
  it('ships en first, then the pseudo-locale, and nothing else', () => {
    expect(supportedLocales()).toEqual([DEFAULT_LOCALE, PSEUDO_LOCALE]);
  });

  it('recognises a supported locale in any case and returns its canonical spelling', () => {
    expect(isSupportedLocale('EN-xa')).toBe(true);
    expect(canonicalSupportedLocale('en-xa')).toBe('en-XA');
    expect(isSupportedLocale('fr')).toBe(false);
  });
});

describe('isLanguageTag', () => {
  it('accepts BCP 47 shapes and refuses anything else', () => {
    expect(isLanguageTag('zh-Hant-TW')).toBe(true);
    expect(isLanguageTag('en')).toBe(true);
    expect(isLanguageTag('e')).toBe(false);
    expect(isLanguageTag('en_GB')).toBe(false);
    expect(isLanguageTag('en-' + 'a'.repeat(40))).toBe(false);
  });
});

describe('matchSupportedLocale', () => {
  it('returns the first requested tag that is served', () => {
    expect(matchSupportedLocale(['de', 'en-AU'])).toBe('en');
  });

  it('returns null when none is served', () => {
    expect(matchSupportedLocale(['de', 'fr-CA'])).toBeNull();
  });

  it('only reaches the pseudo-locale by name', () => {
    expect(matchSupportedLocale(['en-XA'])).toBe('en-XA');
    expect(matchSupportedLocale(['en'])).toBe('en');
  });

  it('skips a tag Intl rejects instead of throwing', () => {
    expect(matchSupportedLocale(['xx-123456789', 'en'])).toBe('en');
  });
});
