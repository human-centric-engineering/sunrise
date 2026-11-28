/**
 * next-intl for tests, backed by the real catalogue (§138 t-1073).
 *
 * `tests/setup.ts` mocks `next-intl` and `next-intl/server` with these, for
 * every file. A component reads its strings exactly as it does in the app:
 * from `catalogueFor('en')` (`lib/i18n/registry.ts`), which is
 * `lib/i18n/messages/en.json` merged with whatever the app registers through
 * `initAppMessages()` (t-1131, #1363). So a test asserts on the English a
 * viewer sees, an app's own `app.…` strings included, and fails on a key that
 * is missing from both. With no app strings registered it is `en.json` alone.
 * No provider wrapper is needed in a render.
 *
 * Read on every call, not captured once, so strings a test registers are
 * seen by the next render.
 *
 * A test that needs another locale mocks the module itself, or calls
 * {@link translatorFor} with its own messages. A test that mocks
 * `@/lib/i18n/registry` and renders text must give the mock a `catalogueFor`.
 */

import { createFormatter, createTranslator } from 'next-intl';
import { I18N_FORMATS } from '@/lib/i18n/format';
import { catalogueFor } from '@/lib/i18n/registry';

export const TEST_LOCALE = 'en';
export const TEST_TIME_ZONE = 'UTC';
/** A fixed "now" for relative times, so a snapshot never drifts. */
export const TEST_NOW = new Date('2026-11-20T12:00:00Z');

type NamespaceArg = string | { namespace?: string; locale?: string } | undefined;

function namespaceOf(arg: NamespaceArg): string | undefined {
  return typeof arg === 'string' ? arg : arg?.namespace;
}

/** The catalogue a viewer in the test locale reads: the source and the app's strings. */
export function testMessages(): Record<string, unknown> {
  return catalogueFor(TEST_LOCALE);
}

/** A translator over `messages` (the {@link testMessages} catalogue by default). */
export function translatorFor(
  namespace?: string,
  messages: Record<string, unknown> = testMessages()
) {
  return createTranslator({
    locale: TEST_LOCALE,
    messages,
    namespace: namespace as never,
    formats: I18N_FORMATS,
    timeZone: TEST_TIME_ZONE,
    now: TEST_NOW,
  });
}

export function testFormatter() {
  return createFormatter({
    locale: TEST_LOCALE,
    timeZone: TEST_TIME_ZONE,
    formats: I18N_FORMATS,
    now: TEST_NOW,
  });
}

/** Overrides for `next-intl`, spread over the real module. */
export const nextIntlClientMock = {
  useTranslations: (namespace?: string) => translatorFor(namespace),
  useFormatter: () => testFormatter(),
  useLocale: () => TEST_LOCALE,
  useTimeZone: () => TEST_TIME_ZONE,
  useNow: () => TEST_NOW,
  useMessages: () => testMessages(),
};

/** A stand-in for `next-intl/server`, which cannot load outside a request. */
export const nextIntlServerMock = {
  getTranslations: async (arg?: NamespaceArg) => translatorFor(namespaceOf(arg)),
  getFormatter: async () => testFormatter(),
  getLocale: async () => TEST_LOCALE,
  getTimeZone: async () => TEST_TIME_ZONE,
  getNow: async () => TEST_NOW,
  getMessages: async () => testMessages(),
  setRequestLocale: () => {},
  getRequestConfig: (fn: unknown) => fn,
};
