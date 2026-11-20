/**
 * The languages a person can pick, each named in itself (§138 t-1073).
 *
 * For the language picker in settings and the visitor's switch on public
 * pages. Server only, like `supportedLocales()`: the page builds the list and
 * hands it to the client component, which keeps the registry and the
 * catalogue out of the browser.
 *
 * Each language is named in its own language (`fr` → "français"), so a
 * person who cannot read the current one can still find theirs. The
 * pseudo-locale is listed outside production only: it is a check for
 * developers, not a language anyone reads.
 */

import { PSEUDO_LOCALE, supportedLocales } from '@/lib/i18n/locales';

export interface LocaleOption {
  /** The canonical tag, as `PATCH /api/v1/users/me` and `PUT /api/v1/locale` take it. */
  tag: string;
  /** The language's name, in that language. */
  name: string;
}

/** `tag`'s name in itself, or the tag when `Intl` has no name for it. */
export function nativeLocaleName(tag: string): string {
  if (tag === PSEUDO_LOCALE) return 'Pseudo-locale (en-XA)';
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    if (!name || name === tag) return tag;
    // Names come lower-case in some languages ("français"); a list reads
    // better with each starting as a sentence would.
    return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
  } catch {
    return tag;
  }
}

/** The supported locales a person may pick, each with its native name. */
export function localeOptions(): LocaleOption[] {
  const listPseudo = process.env.NODE_ENV !== 'production';
  return supportedLocales()
    .filter((tag) => listPseudo || tag !== PSEUDO_LOCALE)
    .map((tag) => ({ tag, name: nativeLocaleName(tag) }));
}
