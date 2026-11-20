/**
 * The languages the interface can be shown in (§138 t-1071).
 *
 * Sunrise ships two catalogues: `en`, the source every string is written in,
 * and `en-XA`, a pseudo-locale generated from it (`lib/i18n/pseudo.ts`). The
 * pseudo-locale is for checking a screen, not for customers: every string on
 * it reads accented and bracketed, so English text that does not come from the
 * catalogue stands out. Real languages come from an app, through the catalogue
 * seam (`lib/app/messages.ts`, read through `lib/i18n/registry.ts`).
 *
 * Boundary-clean: no `next/*` and no database imports, so the proxy and the
 * email renderer can use it. It reads the app's registrations, so it brings
 * the catalogue with it: client code that only needs a tag's shape imports
 * `lib/i18n/tags.ts` instead.
 *
 * @see .context/ui/i18n.md
 */

import { match } from '@formatjs/intl-localematcher';
import { appLocaleTags } from '@/lib/i18n/registry';
import { isLanguageTag, PLATFORM_LOCALES, PSEUDO_LOCALE } from '@/lib/i18n/tags';

export {
  DEFAULT_LOCALE,
  isLanguageTag,
  MAX_LOCALE_TAG_LENGTH,
  PLATFORM_LOCALES,
  PSEUDO_LOCALE,
} from '@/lib/i18n/tags';

/**
 * The cookie a visitor's own choice of language is kept in. Strictly
 * necessary under the consent config's "essential" category: it is a
 * preference the visitor set, like the theme, and identifies nobody.
 */
export const LOCALE_COOKIE_NAME = 'sunrise_locale';

/** One year, in seconds. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The locales the interface can be shown in, the source language first:
 * the platform's, then those an app registered (`lib/app/messages.ts`).
 */
export function supportedLocales(): readonly string[] {
  const app = appLocaleTags();
  return app.length === 0 ? PLATFORM_LOCALES : [...PLATFORM_LOCALES, ...app];
}

/** Whether `tag` is exactly a supported locale (case-insensitive), as stored. */
export function isSupportedLocale(tag: string): boolean {
  return canonicalSupportedLocale(tag) !== null;
}

/** The supported locale `tag` names exactly, in its canonical spelling, or null. */
export function canonicalSupportedLocale(tag: string): string | null {
  const wanted = tag.toLowerCase();
  return supportedLocales().find((locale) => locale.toLowerCase() === wanted) ?? null;
}

/**
 * The supported locale that best serves a list of requested tags, in order
 * of preference, or `null` when none does.
 *
 * An exact match wins; otherwise a request falls back to its base language
 * (`fr-CA` is served by `fr`). A region never widens the other way: `en`
 * does not pick `en-XA`, and nothing ever picks the pseudo-locale unless it
 * was asked for by name, because it is not a language anyone reads.
 */
export function matchSupportedLocale(requested: readonly string[]): string | null {
  for (const tag of requested) {
    if (!isLanguageTag(tag)) continue;
    const exact = canonicalSupportedLocale(tag);
    if (exact) return exact;
    const available = supportedLocales().filter((locale) => locale !== PSEUDO_LOCALE);
    // `match` with "lookup" only truncates the request (fr-CA → fr), never
    // the available tag, so `en` cannot reach `en-XA`.
    let found: string;
    try {
      found = match([tag], available, NO_MATCH, { algorithm: 'lookup' });
    } catch {
      // A tag the shape check let through that `Intl` still rejects
      // (`xx-123456789`): it serves no one, so try the next.
      continue;
    }
    if (found !== NO_MATCH) return found;
  }
  return null;
}

/** What `match` returns for "none": never a real tag. */
const NO_MATCH = '\u0000';
