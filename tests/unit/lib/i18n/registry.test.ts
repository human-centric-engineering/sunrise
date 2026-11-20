/**
 * The app catalogue seam (§138 t-1072): an app's own strings, its languages
 * and its replacements for platform strings reach the catalogue and the
 * supported-locale list; nothing registered changes nothing; and an init that
 * throws part-way rolls back every map, so the platform catalogue still serves.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTranslator } from 'next-intl';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

/** What the fork's `initAppMessages()` does in each test. */
const appInit = vi.hoisted(() => ({ run: (): void => {} }));
vi.mock('@/lib/app/messages', () => ({ initAppMessages: () => appInit.run() }));

import en from '@/lib/i18n/messages/en.json';
import {
  APP_MESSAGE_NAMESPACES,
  appLocaleTags,
  catalogueFor,
  overridePlatformMessages,
  registerAppLocale,
  registerAppMessages,
  __resetAppMessagesForTests,
} from '@/lib/i18n/registry';
import { messagesFor } from '@/lib/i18n/catalogue';
import { supportedLocales } from '@/lib/i18n/locales';
import { pseudoLocalize, pseudoLocalizeMessage } from '@/lib/i18n/pseudo';
import { resolveLocale } from '@/lib/i18n/resolve';
import { supportedLocaleSchema } from '@/lib/validations/locale';
import type { MessageTree } from '@/lib/i18n/pseudo';

/** Read one key from a built catalogue, the way next-intl resolves it. */
function translate(locale: string, key: string): string {
  const t = createTranslator({ locale, messages: catalogueFor(locale) });
  return (t as unknown as (k: string) => string)(key);
}

beforeEach(() => {
  vi.clearAllMocks();
  appInit.run = () => {};
  __resetAppMessagesForTests();
});

describe('with nothing registered', () => {
  it('serves the platform catalogue exactly as before', () => {
    expect(catalogueFor('en')).toEqual(en);
    expect(messagesFor('en')).toEqual(en);
    expect(catalogueFor('en-XA')).toEqual(pseudoLocalize(en));
    // A locale with no catalogue still gets the source.
    expect(catalogueFor('fr')).toEqual(en);
    expect(supportedLocales()).toEqual(['en', 'en-XA']);
    expect(appLocaleTags()).toEqual([]);
    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('runs the app init once, on the first read', () => {
    const run = vi.fn();
    appInit.run = run;
    expect(run).not.toHaveBeenCalled();
    catalogueFor('en');
    supportedLocales();
    catalogueFor('en-XA');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('an app namespace', () => {
  it('resolves in the source locale and is pseudo-localised with it', () => {
    appInit.run = () => {
      registerAppMessages('en', { app: { client: { title: 'Clients' } } });
    };
    expect(translate('en', 'app.client.title')).toBe('Clients');
    expect(translate('en-XA', 'app.client.title')).toBe(pseudoLocalizeMessage('Clients'));
    // The platform's strings are still there beside it.
    expect(translate('en', 'common.save')).toBe('Save');
  });

  it('merges calls for the same locale, a later key winning', () => {
    appInit.run = () => {
      registerAppMessages('en', { app: { client: { title: 'Clients', empty: 'None yet' } } });
      registerAppMessages('en', { app: { client: { title: 'Customers' } } });
    };
    expect(translate('en', 'app.client.title')).toBe('Customers');
    expect(translate('en', 'app.client.empty')).toBe('None yet');
  });

  it('falls back to the app’s English per key in an app locale', () => {
    appInit.run = () => {
      registerAppMessages('en', { app: { client: { title: 'Clients', empty: 'None yet' } } });
      registerAppLocale('fr', {});
      registerAppMessages('fr', { app: { client: { title: 'Clients (fr)' } } });
    };
    expect(translate('fr', 'app.client.title')).toBe('Clients (fr)');
    expect(translate('fr', 'app.client.empty')).toBe('None yet');
  });

  it('never collides with the platform: its catalogue has no reserved namespace', () => {
    for (const ns of APP_MESSAGE_NAMESPACES) expect(Object.keys(en)).not.toContain(ns);
  });

  it('is refused outside the reserved namespaces', () => {
    expect(APP_MESSAGE_NAMESPACES).toEqual(['app', 'framework']);
    expect(() => registerAppMessages('en', { common: { save: 'Go' } })).toThrow(
      /"app" or "framework"/
    );
    expect(() => registerAppMessages('en', { client: { title: 'x' } })).toThrow(
      /namespace "client"/
    );
  });
});

describe('a registered locale', () => {
  it('becomes supported, choosable and resolvable', () => {
    appInit.run = () => {
      registerAppLocale('fr', { common: { save: 'Enregistrer' } });
    };
    expect(supportedLocales()).toEqual(['en', 'en-XA', 'fr']);
    expect(appLocaleTags()).toEqual(['fr']);
    // The resolution serves it, regional requests included.
    expect(resolveLocale({ acceptLanguage: 'fr-CA,fr;q=0.9' })).toEqual({
      locale: 'fr',
      source: 'accept-language',
    });
    expect(resolveLocale({ userLocale: 'fr' }).locale).toBe('fr');
    // The stored choice validates and is canonicalised.
    expect(supportedLocaleSchema.parse('FR')).toBe('fr');
    expect(translate('fr', 'common.save')).toBe('Enregistrer');
  });

  it('shows a missing platform key in English and names it in the log once', () => {
    appInit.run = () => {
      registerAppLocale('fr', { common: { save: 'Enregistrer' } });
    };
    expect(translate('fr', 'common.cancel')).toBe(en.common.cancel);
    catalogueFor('fr');
    const missing = mockLog.warn.mock.calls.filter(([msg]) =>
      String(msg).includes('missing from an app locale')
    );
    expect(missing).toHaveLength(1);
    expect(missing[0][1]).toMatchObject({ locale: 'fr' });
    expect((missing[0][1] as { keys: string[] }).keys).toContain('common.cancel');
    expect((missing[0][1] as { keys: string[] }).keys).not.toContain('common.save');
  });

  it('logs the same gap once across registrations that rebuild the catalogue', () => {
    appInit.run = () => {
      registerAppLocale('fr', { common: { save: 'Enregistrer' } });
      // A read between registrations builds `fr`; the next call clears it.
      catalogueFor('fr');
      registerAppMessages('fr', { app: { client: { title: 'Clients' } } });
    };
    catalogueFor('fr');
    const missing = mockLog.warn.mock.calls.filter(([msg]) =>
      String(msg).includes('missing from an app locale')
    );
    expect(missing).toHaveLength(1);
  });

  it('is stored in its canonical spelling', () => {
    appInit.run = () => {
      registerAppLocale('pt-br', { common: { save: 'Salvar' } });
    };
    expect(supportedLocales()).toContain('pt-BR');
    expect(translate('pt-BR', 'common.save')).toBe('Salvar');
  });

  it('drops a platform key the platform does not have, with a warning', () => {
    appInit.run = () => {
      registerAppLocale('fr', {
        common: { save: 'Enregistrer', retired: 'Ancien' },
        gone: { x: 'y' },
      });
    };
    const fr = catalogueFor('fr') as Record<string, unknown>;
    expect(fr.gone).toBeUndefined();
    expect((fr.common as Record<string, unknown>).retired).toBeUndefined();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'i18n: registerAppLocale ignored strings the platform does not have',
      expect.objectContaining({ locale: 'fr', keys: ['common.retired', 'gone'] })
    );
  });

  it('refuses a platform locale, a non-tag and the reserved namespaces', () => {
    expect(() => registerAppLocale('en')).toThrow(/platform locale/);
    expect(() => registerAppLocale('en-xa')).toThrow(/platform locale/);
    expect(() => registerAppLocale('not a tag')).toThrow(/not a language tag/);
    expect(() => registerAppLocale('fr', { app: { x: 'y' } })).toThrow(/registerAppMessages/);
  });

  it('must exist before strings are registered in it', () => {
    expect(() => registerAppMessages('de', { app: { x: 'y' } })).toThrow(
      /registerAppLocale\(\) first/
    );
    expect(() => overridePlatformMessages('de', { common: { save: 'x' } })).toThrow(
      /registerAppLocale\(\) first/
    );
    expect(() => registerAppMessages('en-XA', { app: { x: 'y' } })).toThrow(/generated from "en"/);
  });
});

describe('an override', () => {
  it('wins over the platform string, and reaches the pseudo-locale', () => {
    appInit.run = () => {
      overridePlatformMessages('en', { common: { save: 'Save changes' } });
    };
    expect(translate('en', 'common.save')).toBe('Save changes');
    expect(translate('en-XA', 'common.save')).toBe(pseudoLocalizeMessage('Save changes'));
    expect(translate('en', 'common.cancel')).toBe(en.common.cancel);
  });

  it('wins over the app locale’s own translation', () => {
    appInit.run = () => {
      // Registered before the translation, to show the order is by layer, not by call.
      registerAppLocale('fr', {});
      overridePlatformMessages('fr', { common: { save: 'Valider' } });
      registerAppLocale('fr', { common: { save: 'Enregistrer', cancel: 'Annuler' } });
    };
    expect(translate('fr', 'common.save')).toBe('Valider');
    expect(translate('fr', 'common.cancel')).toBe('Annuler');
  });

  it('is refused for an app namespace', () => {
    expect(() => overridePlatformMessages('en', { app: { x: 'y' } })).toThrow(
      /registerAppMessages/
    );
  });
});

describe('a malformed tree', () => {
  it('is refused', () => {
    expect(() => registerAppMessages('en', { app: { n: 3 } } as unknown as MessageTree)).toThrow(
      /object of strings/
    );
    expect(() =>
      registerAppMessages('en', { app: { list: ['a'] } } as unknown as MessageTree)
    ).toThrow(/object of strings/);
    expect(() => registerAppMessages('en', { app: { 'a.b': 'x' } })).toThrow(/not a usable key/);
    expect(() =>
      registerAppMessages('en', JSON.parse('{"app":{"__proto__":{"x":"y"}}}') as MessageTree)
    ).toThrow(/not a usable key/);
  });

  it('refuses a string that is not valid ICU, naming the key', () => {
    expect(() => registerAppMessages('en', { app: { greet: 'Hi {name' } })).toThrow(
      /"app\.greet" is not a valid ICU message/
    );
    registerAppLocale('fr');
    expect(() => overridePlatformMessages('fr', { common: { save: '{' } })).toThrow(
      /"common\.save" is not a valid ICU message/
    );
  });

  it('fails the init on a broken string, so the pseudo-locale still renders', () => {
    appInit.run = () => {
      registerAppMessages('en', { app: { greet: 'Hi {name' } });
    };
    expect(catalogueFor('en-XA')).toEqual(pseudoLocalize(en));
    expect(catalogueFor('en')).toEqual(en);
    expect(mockLog.error).toHaveBeenCalledTimes(1);
  });
});

describe('registration guards', () => {
  it('refuses a deprecated tag, naming the current one', () => {
    expect(() => registerAppLocale('iw')).toThrow(/deprecated tag; use "he"/);
  });

  it('refuses a key whose shape differs between locales', () => {
    registerAppMessages('en', { app: { title: 'Clients' } });
    registerAppLocale('fr');
    expect(() => registerAppMessages('fr', { app: { title: { one: 'x' } } })).toThrow(
      /"app\.title" was registered in "en" as a string/
    );
  });

  it('refuses a later call that changes a string into a group, or back', () => {
    registerAppMessages('en', { app: { client: { title: 'X', body: 'Y' } } });
    expect(() => registerAppMessages('en', { app: { client: 'Clients' } })).toThrow(
      /"app\.client" was registered as a group of strings/
    );
    expect(() => registerAppMessages('en', { app: { client: { title: { a: 'b' } } } })).toThrow(
      /"app\.client\.title" was registered as a string/
    );
  });
});

describe('a regional tag', () => {
  it('is served by its registered base language', () => {
    appInit.run = () => {
      registerAppLocale('fr', { common: { save: 'Enregistrer' } });
    };
    expect(catalogueFor('fr-CA')).toBe(catalogueFor('fr'));
    expect(translate('fr-CA', 'common.save')).toBe('Enregistrer');
    expect(catalogueFor('de-AT')).toEqual(en);
  });
});

describe('the pseudo-locale', () => {
  it('is recognised in any case', () => {
    expect(catalogueFor('en-xa')).toEqual(pseudoLocalize(en));
    expect(catalogueFor('EN-XA')).toBe(catalogueFor('en-XA'));
  });
});

describe('an init that throws part-way', () => {
  it('rolls back every map, and the platform catalogue still serves', () => {
    appInit.run = () => {
      registerAppMessages('en', { app: { client: { title: 'Clients' } } });
      overridePlatformMessages('en', { common: { save: 'Save changes' } });
      registerAppLocale('fr', { common: { save: 'Enregistrer' } });
      registerAppMessages('fr', { app: { client: { title: 'Clients (fr)' } } });
      overridePlatformMessages('fr', { common: { cancel: 'Annuler' } });
      throw new Error('bad translation file');
    };
    expect(catalogueFor('en')).toEqual(en);
    expect(catalogueFor('en-XA')).toEqual(pseudoLocalize(en));
    expect(catalogueFor('fr')).toEqual(en);
    expect(supportedLocales()).toEqual(['en', 'en-XA']);
    expect(appLocaleTags()).toEqual([]);
    expect(supportedLocaleSchema.safeParse('fr').success).toBe(false);
    expect(mockLog.error).toHaveBeenCalledWith(
      'i18n: initAppMessages threw — app strings and languages rolled back and disabled',
      { error: 'bad translation file' }
    );
  });

  it('drops a catalogue the init read before it threw', () => {
    appInit.run = () => {
      registerAppMessages('en', { app: { client: { title: 'Clients' } } });
      // A read inside the init builds and caches a catalogue with the partial registration.
      catalogueFor('en');
      throw new Error('late failure');
    };
    expect(catalogueFor('en')).toEqual(en);
  });
});
