import { describe, expect, it } from 'vitest';
import {
  localeChoiceBodySchema,
  localeChoiceSchema,
  supportedLocaleSchema,
} from '@/lib/validations/locale';

describe('supportedLocaleSchema', () => {
  it('accepts a supported locale and stores its canonical spelling', () => {
    expect(supportedLocaleSchema.parse(' en-xa ')).toBe('en-XA');
    expect(supportedLocaleSchema.parse('EN')).toBe('en');
  });

  it('refuses a locale with no catalogue, naming the ones there are', () => {
    const result = supportedLocaleSchema.safeParse('fr');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Language must be one of: en, en-XA');
  });

  it('refuses an over-long value before matching it', () => {
    expect(supportedLocaleSchema.safeParse('en-' + 'x'.repeat(40)).success).toBe(false);
  });
});

describe('localeChoiceSchema', () => {
  it('accepts null to clear a choice', () => {
    expect(localeChoiceSchema.parse(null)).toBeNull();
  });
});

describe('localeChoiceBodySchema', () => {
  it('requires the locale key and refuses any other', () => {
    expect(localeChoiceBodySchema.safeParse({}).success).toBe(false);
    expect(localeChoiceBodySchema.safeParse({ locale: 'en', extra: 1 }).success).toBe(false);
    expect(localeChoiceBodySchema.parse({ locale: null })).toEqual({ locale: null });
  });
});
