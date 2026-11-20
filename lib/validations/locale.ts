/**
 * Locale validation (§138 t-1071).
 *
 * A locale someone chooses must be one the interface has a catalogue for, so
 * the check runs against `supportedLocales()` at request time rather than a
 * fixed list: a locale an app registers becomes choosable without a change
 * here. The stored value is the canonical spelling (`en-XA`, not `en-xa`).
 */

import { z } from 'zod';
import {
  canonicalSupportedLocale,
  MAX_LOCALE_TAG_LENGTH,
  supportedLocales,
} from '@/lib/i18n/locales';

/** A supported locale, canonicalised. */
export const supportedLocaleSchema = z
  .string()
  .trim()
  .max(MAX_LOCALE_TAG_LENGTH)
  .transform((tag, ctx) => {
    const locale = canonicalSupportedLocale(tag);
    if (!locale) {
      ctx.addIssue({
        code: 'custom',
        message: `Language must be one of: ${supportedLocales().join(', ')}`,
      });
      return z.NEVER;
    }
    return locale;
  });

/** A supported locale, or `null` to clear the choice and follow the next step. */
export const localeChoiceSchema = supportedLocaleSchema.nullable();

/** `PUT /api/v1/orgs/[id]/locale` and `PUT /api/v1/locale`. */
export const localeChoiceBodySchema = z.object({ locale: localeChoiceSchema }).strict();
