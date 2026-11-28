// @vitest-environment happy-dom

/**
 * Unit Tests: the next-intl test helper reads the app's strings (t-1131, #1363)
 *
 * `tests/setup.ts` routes every file's `next-intl` and `next-intl/server`
 * through `tests/helpers/i18n.ts`. The helper serves `catalogueFor('en')`:
 * the platform's `en.json` merged with what the app registers. These tests
 * prove both halves. With nothing registered the catalogue is `en.json`
 * alone, so every existing test reads what it did. A string an app
 * registers renders in a component test as its English, not as a
 * missing key.
 *
 * @see tests/helpers/i18n.ts
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useMessages, useTranslations } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';

import en from '@/lib/i18n/messages/en.json';
import { __resetAppMessagesForTests, registerAppMessages } from '@/lib/i18n/registry';
import { testMessages, translatorFor } from '@/tests/helpers/i18n';

afterEach(() => {
  __resetAppMessagesForTests();
});

// An app's keys are not in the platform's message types, so these tests read
// the translators untyped, as an app's own typed augmentation would allow.
type Plain = ((key: string) => string) & { has: (key: string) => boolean };
const plain = (t: unknown): Plain => t as Plain;
const useAppTranslations = (namespace: string): Plain =>
  plain((useTranslations as unknown as (ns: string) => unknown)(namespace));
const getAppTranslations = async (namespace: string): Promise<Plain> =>
  plain(await (getTranslations as unknown as (ns: string) => Promise<unknown>)(namespace));

function ClientsHeading() {
  const t = useAppTranslations('app.clients');
  return <h1>{t('title')}</h1>;
}

describe('the test catalogue', () => {
  it('is en.json alone while the app registers no strings', async () => {
    expect(testMessages()).toEqual(en);
    expect(useMessages()).toEqual(en);
    expect(await getMessages()).toEqual(en);
  });

  it('renders a string the app registers as its English, in a component', () => {
    registerAppMessages('en', { app: { clients: { title: 'Your clients' } } });

    render(<ClientsHeading />);

    expect(screen.getByRole('heading', { name: 'Your clients' })).toBeInTheDocument();
  });

  it('serves the app’s strings beside the platform’s, on the client and the server', async () => {
    registerAppMessages('en', { app: { clients: { title: 'Your clients' } } });

    expect(plain(translatorFor('app.clients'))('title')).toBe('Your clients');
    expect((await getAppTranslations('app.clients'))('title')).toBe('Your clients');
    // The platform's own strings are still there.
    expect(plain(translatorFor())('common.save')).toBe(
      plain(translatorFor(undefined, en))('common.save')
    );
    expect(useMessages()).toMatchObject({ app: { clients: { title: 'Your clients' } } });
  });

  it('reads the catalogue on every call, so a string registered after a render is seen', () => {
    expect(plain(translatorFor('app.clients')).has('title')).toBe(false);

    registerAppMessages('en', { app: { clients: { title: 'Your clients' } } });

    expect(plain(translatorFor('app.clients'))('title')).toBe('Your clients');
  });
});
