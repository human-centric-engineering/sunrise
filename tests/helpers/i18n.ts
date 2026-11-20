/**
 * next-intl for tests, backed by the real source catalogue (§138 t-1073).
 *
 * `tests/setup.ts` mocks `next-intl` and `next-intl/server` with these, for
 * every file. A component reads its strings exactly as it does in the app,
 * from `lib/i18n/messages/en.json`, so a test asserts on the English a viewer
 * sees and fails on a key that is missing from the catalogue. No provider
 * wrapper is needed in a render.
 *
 * A test that needs another locale mocks the module itself, or calls
 * {@link translatorFor} with its own messages.
 */

import { createFormatter, createTranslator } from 'next-intl';
import en from '@/lib/i18n/messages/en.json';
import { I18N_FORMATS } from '@/lib/i18n/format';

export const TEST_LOCALE = 'en';
export const TEST_TIME_ZONE = 'UTC';
/** A fixed "now" for relative times, so a snapshot never drifts. */
export const TEST_NOW = new Date('2026-11-20T12:00:00Z');

type NamespaceArg = string | { namespace?: string; locale?: string } | undefined;

function namespaceOf(arg: NamespaceArg): string | undefined {
  return typeof arg === 'string' ? arg : arg?.namespace;
}

/** A translator over `messages` (the source catalogue by default). */
export function translatorFor(namespace?: string, messages: Record<string, unknown> = en) {
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
  useMessages: () => en,
};

/** A stand-in for `next-intl/server`, which cannot load outside a request. */
export const nextIntlServerMock = {
  getTranslations: async (arg?: NamespaceArg) => translatorFor(namespaceOf(arg)),
  getFormatter: async () => testFormatter(),
  getLocale: async () => TEST_LOCALE,
  getTimeZone: async () => TEST_TIME_ZONE,
  getNow: async () => TEST_NOW,
  getMessages: async () => en,
  setRequestLocale: () => {},
  getRequestConfig: (fn: unknown) => fn,
};
