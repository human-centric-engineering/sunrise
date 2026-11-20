/**
 * The fixed facts about language tags (§138 t-1071, t-1072).
 *
 * A leaf: it imports nothing. Two things depend on that:
 *
 * - **No import cycle.** `lib/i18n/locales.ts` reads the app's registered
 *   locales from `lib/i18n/registry.ts`, and the registry needs these
 *   constants; both import them from here, not from each other.
 * - **A light client bundle.** A schema a client form imports (the `locale`
 *   field in `lib/validations/user.ts`) checks a tag's shape from here, so the
 *   form does not pull in the catalogue, an app's translations or the ICU
 *   parser. Whether a tag is _supported_ is checked on the server.
 *
 * `lib/i18n/locales.ts` re-exports all of these; import them from there
 * unless the caller has to stay this light.
 *
 * @see .context/ui/i18n.md
 */

/** The source language: every string is written in it, and every lookup falls back to it. */
export const DEFAULT_LOCALE = 'en';

/** The pseudo-locale generated from {@link DEFAULT_LOCALE}, for checking screens. */
export const PSEUDO_LOCALE = 'en-XA';

/** The locales Sunrise ships a catalogue for. */
export const PLATFORM_LOCALES: readonly string[] = Object.freeze([DEFAULT_LOCALE, PSEUDO_LOCALE]);

/** The longest language tag stored or matched; BCP 47 recommends supporting 35. */
export const MAX_LOCALE_TAG_LENGTH = 35;

const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i;

/** Whether `tag` has the shape of a BCP 47 language tag; says nothing about support. */
export function isLanguageTag(tag: string): boolean {
  return tag.length <= MAX_LOCALE_TAG_LENGTH && LANGUAGE_TAG.test(tag);
}
