/**
 * The string catalogue (§138 t-1071): the messages for one locale.
 *
 * `en` is `lib/i18n/messages/en.json`, the source every string is written in.
 * The pseudo-locale is generated from it on first use and kept for the life
 * of the process (`lib/i18n/pseudo.ts`). A locale with no catalogue gets
 * `en`, so a caller that skipped resolution still renders text.
 *
 * Boundary-clean: no `next/*` imports, so the email renderer uses it as the
 * request config does.
 */

import en from '@/lib/i18n/messages/en.json';
import { DEFAULT_LOCALE, PSEUDO_LOCALE } from '@/lib/i18n/locales';
import { pseudoLocalize, type MessageTree } from '@/lib/i18n/pseudo';

/** The shape of the source catalogue; every locale has the same keys. */
export type Messages = typeof en;

let pseudo: Messages | null = null;

/** The messages for `locale`, falling back to the source catalogue. */
export function messagesFor(locale: string): Messages {
  if (locale === PSEUDO_LOCALE) {
    // Same keys by construction: `pseudoLocalize` maps every leaf and adds none.
    pseudo ??= pseudoLocalize(en satisfies MessageTree) as Messages;
    return pseudo;
  }
  return en;
}

/** The source catalogue, for tests and tooling. */
export function sourceMessages(): Messages {
  return messagesFor(DEFAULT_LOCALE);
}
