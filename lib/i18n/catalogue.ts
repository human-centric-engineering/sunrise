/**
 * The string catalogue (§138 t-1071): the messages for one locale.
 *
 * `en` is `lib/i18n/messages/en.json`, the source every string is written in.
 * The pseudo-locale is generated from it (`lib/i18n/pseudo.ts`). What an app
 * registers (its own strings, its languages, its replacements for platform
 * strings: `lib/i18n/registry.ts`, t-1072) is merged in there, and the built
 * catalogue is kept for the life of the process. A locale with no catalogue
 * gets `en`, so a caller that skipped resolution still renders text.
 *
 * Boundary-clean: no `next/*` imports, so the email renderer uses it as the
 * request config does.
 */

import type en from '@/lib/i18n/messages/en.json';
import type { AppMessages } from '@/lib/app/messages';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { catalogueFor } from '@/lib/i18n/registry';

/**
 * The shape of the source catalogue: the platform's strings and the app's
 * own (`AppMessages` in `lib/app/messages.ts`). Every locale has the same
 * keys, because a key a locale lacks is filled from `en`.
 */
export type Messages = typeof en & AppMessages;

/** The messages for `locale`, falling back to the source catalogue. */
export function messagesFor(locale: string): Messages {
  // Same keys as the source by construction: every catalogue is built over it.
  return catalogueFor(locale) as Messages;
}

/**
 * The built source catalogue: the platform's `en` strings with the app's `en`
 * strings and overrides merged in. The platform's own strings alone are
 * `lib/i18n/messages/en.json`.
 */
export function sourceMessages(): Messages {
  return messagesFor(DEFAULT_LOCALE);
}
