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

function ClientsHeading() {
  const t = useTranslations('app.clients');
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

    expect(translatorFor('app.clients')('title')).toBe('Your clients');
    expect((await getTranslations('app.clients'))('title')).toBe('Your clients');
    // The platform's own strings are still there.
    expect(translatorFor()('common.save')).toBe(translatorFor(undefined, en)('common.save'));
    expect(useMessages()).toMatchObject({ app: { clients: { title: 'Your clients' } } });
  });

  it('reads the catalogue on every call, so a string registered after a render is seen', () => {
    expect(translatorFor('app.clients').has('title')).toBe(false);

    registerAppMessages('en', { app: { clients: { title: 'Your clients' } } });

    expect(translatorFor('app.clients')('title')).toBe('Your clients');
  });
});
