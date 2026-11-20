/**
 * The messages a validation schema shows, from the catalogue (§138 t-1073).
 *
 * A schema a form shows to a person is built by a factory that takes a
 * {@link ValidationT}: the form passes `useTranslations('validation')`, so
 * its errors read in the viewer's language. The schema an API route uses is
 * the same factory given {@link englishValidation}, so the error text a route
 * returns is the source catalogue's English and never depends on who asked.
 *
 * Limits are written into the messages (`… at least 8 characters`) rather
 * than passed as `{min}`: an ICU number argument is grouped (`5,000`), which
 * would change the text the API has always returned.
 */

import { createTranslator } from 'next-intl';
import { validation } from '@/lib/i18n/messages/en.json';

export type ValidationKey = keyof typeof validation;

/** Looks up a `validation.*` message. `values` fills ICU arguments. */
export type ValidationT = (key: ValidationKey, values?: Record<string, string>) => string;

const english = createTranslator({
  locale: 'en',
  messages: { validation },
  namespace: 'validation',
});

/** The source catalogue's English: what API routes return. */
export const englishValidation: ValidationT = (key, values) => english(key, values);
