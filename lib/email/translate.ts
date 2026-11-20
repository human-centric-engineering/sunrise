/**
 * The strings an email is written with (§138 t-1075): a translator over the
 * catalogue for one recipient's language, with no request and no database.
 *
 * Kept apart from `lib/email/locale.ts`, which reads the recipient's choices
 * from the database, so a template imports only this and renders anywhere:
 * in a send, in a test, in the React Email preview.
 */

import { createTranslator, type NamespaceKeys, type NestedKeyOf } from 'next-intl';
import { messagesFor, type Messages } from '@/lib/i18n/catalogue';
import { DEFAULT_TIME_ZONE, I18N_FORMATS, formatterFor } from '@/lib/i18n/format';
import { DEFAULT_LOCALE } from '@/lib/i18n/tags';

/** The language and time zone one email is written in. */
export interface EmailLocale {
  /** A supported locale. */
  locale: string;
  /** An IANA zone `Intl` knows; `UTC` for a recipient with none. */
  timeZone: string;
}

/** English, in UTC: what an email is written in when nothing says otherwise. */
export const DEFAULT_EMAIL_LOCALE: EmailLocale = Object.freeze({
  locale: DEFAULT_LOCALE,
  timeZone: DEFAULT_TIME_ZONE,
});

/** A catalogue namespace: `emails.welcome`, or an app's `app.emails.receipt`. */
export type EmailNamespace = NamespaceKeys<Messages, NestedKeyOf<Messages>>;

/** What {@link emailTranslator} returns for namespace `N`. */
export type EmailTranslator<N extends EmailNamespace> = ReturnType<
  typeof createTranslator<Messages, N>
>;

/**
 * A translator over the catalogue for `where`, outside a request: the
 * platform's strings, and an app's, in that locale (falling back to `en` for
 * a key it lacks). Use for an email's body and its subject alike.
 */
export function emailTranslator<N extends EmailNamespace>(
  where: EmailLocale,
  namespace: N
): EmailTranslator<N> {
  return createTranslator({
    locale: where.locale,
    messages: messagesFor(where.locale),
    namespace,
    timeZone: where.timeZone,
    formats: I18N_FORMATS,
  });
}

/**
 * A moment as an email states it: the named `dateTime` format in the
 * recipient's zone, with the zone named (`20 Nov 2026, 14:05 UTC`), since a
 * reader may not be where the sender assumed.
 */
export function emailDateTime(where: EmailLocale, value: Date | string): string {
  return formatterFor(where.locale, where.timeZone).dateTime(new Date(value), {
    ...I18N_FORMATS.dateTime.dateTime,
    timeZoneName: 'short',
  });
}

/** A date alone, as an email states it: the named `long` format (`20 November 2026`). */
export function emailDate(where: EmailLocale, value: Date | string): string {
  return formatterFor(where.locale, where.timeZone).dateTime(new Date(value), 'long');
}
