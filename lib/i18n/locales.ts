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
 * Boundary-clean: no `next/*` and no database imports, so the proxy, the
 * client and the email renderer can all use it.
 *
 * @see .context/ui/i18n.md
 */

import { match } from '@formatjs/intl-localematcher';
import { appLocaleTags } from '@/lib/i18n/registry';

/** The source language: every string is written in it, and every lookup falls back to it. */
export const DEFAULT_LOCALE = 'en';

/** The pseudo-locale generated from {@link DEFAULT_LOCALE}, for checking screens. */
export const PSEUDO_LOCALE = 'en-XA';

/** The locales Sunrise ships a catalogue for. */
export const PLATFORM_LOCALES: readonly string[] = Object.freeze([DEFAULT_LOCALE, PSEUDO_LOCALE]);

/**
 * The cookie a visitor's own choice of language is kept in. Strictly
 * necessary under the consent config's "essential" category: it is a
 * preference the visitor set, like the theme, and identifies nobody.
 */
export const LOCALE_COOKIE_NAME = 'sunrise_locale';

/** One year, in seconds. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** The longest language tag stored or matched; BCP 47 recommends supporting 35. */
export const MAX_LOCALE_TAG_LENGTH = 35;

const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i;

/** Whether `tag` has the shape of a BCP 47 language tag; says nothing about support. */
export function isLanguageTag(tag: string): boolean {
  return tag.length <= MAX_LOCALE_TAG_LENGTH && LANGUAGE_TAG.test(tag);
}

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
