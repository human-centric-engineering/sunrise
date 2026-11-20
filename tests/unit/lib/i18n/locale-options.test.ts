import { afterEach, describe, expect, it, vi } from 'vitest';

const appTags = vi.hoisted(() => ({ value: [] as string[] }));
vi.mock('@/lib/i18n/registry', () => ({ appLocaleTags: () => appTags.value }));

import { localeOptions, nativeLocaleName } from '@/lib/i18n/locale-options';

describe('nativeLocaleName', () => {
  it('names a language in itself, starting with a capital', () => {
    expect(nativeLocaleName('fr')).toBe('Français');
    expect(nativeLocaleName('de')).toBe('Deutsch');
    expect(nativeLocaleName('pt-BR')).toBe('Português (Brasil)');
  });

  it('names the pseudo-locale for what it is', () => {
    expect(nativeLocaleName('en-XA')).toBe('Pseudo-locale (en-XA)');
  });

  it('falls back to the tag when Intl cannot name it', () => {
    expect(nativeLocaleName('not a tag')).toBe('not a tag');
  });
});

describe('localeOptions', () => {
  afterEach(() => {
    appTags.value = [];
    vi.unstubAllEnvs();
  });

  it('lists the platform locales, with the pseudo-locale, outside production', () => {
    expect(localeOptions()).toEqual([
      { tag: 'en', name: 'English' },
      { tag: 'en-XA', name: 'Pseudo-locale (en-XA)' },
    ]);
  });

  it('leaves the pseudo-locale out in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(localeOptions().map((o) => o.tag)).toEqual(['en']);
  });

  it('includes the languages an app registers', () => {
    appTags.value = ['fr'];
    vi.stubEnv('NODE_ENV', 'production');
    expect(localeOptions()).toEqual([
      { tag: 'en', name: 'English' },
      { tag: 'fr', name: 'Français' },
    ]);
  });
});
