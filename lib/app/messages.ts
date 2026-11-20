/**
 * App strings and languages (§138 t-1072).
 *
 * **Fork-owned scaffold** — Sunrise ships this empty (= the platform's own
 * catalogue in `en` and the pseudo-locale, nothing more) and does NOT change
 * it after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's exports, not their bodies).
 *
 * Three things an app can do here, with the functions in
 * `lib/i18n/registry.ts`:
 *
 * 1. **Add its own strings** — `registerAppMessages(locale, { app: { … } })`.
 *    Your strings live under the `app` namespace (a framework tier uses
 *    `framework`). Sunrise never ships either, so an upgrade can never
 *    collide with yours. Read them with `getTranslations('app.client')`.
 * 2. **Add a language** — `registerAppLocale('fr', platformStrings)`. Sunrise
 *    ships only `en` and the pseudo-locale `en-XA`, so this is how a real
 *    language reaches the platform's screens. Pass the platform's strings in
 *    that language; any you leave out show in English, and the log says
 *    which, once. Add your own strings in it with `registerAppMessages`.
 * 3. **Change a platform string** — `overridePlatformMessages(locale, { … })`.
 *    Applied last, over the platform's text and any translation.
 *
 * To have `t('app.…')` type-checked, set {@link AppMessages} to the shape of
 * your source strings, as below.
 *
 * Auto-wired: `lib/i18n/registry.ts` calls `initAppMessages()` once, lazily,
 * before the first catalogue or supported-language read. Register inside the
 * function, not at the module's top level, so a throw rolls back: if it
 * throws, none of your strings or languages are registered, the log says why,
 * and every screen shows the platform's own catalogue.
 *
 * @example
 * ```ts
 * import appEn from '@/lib/app/messages/en.json';
 * import appFr from '@/lib/app/messages/fr.json';
 * import platformFr from '@/lib/app/messages/platform-fr.json';
 * import {
 *   overridePlatformMessages,
 *   registerAppLocale,
 *   registerAppMessages,
 * } from '@/lib/i18n/registry';
 *
 * export type AppMessages = typeof appEn; // { app: { client: { … } } }
 *
 * export function initAppMessages(): void {
 *   registerAppMessages('en', appEn);
 *   registerAppLocale('fr', platformFr);
 *   registerAppMessages('fr', appFr);
 *   overridePlatformMessages('en', { common: { save: 'Save changes' } });
 * }
 * ```
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/ui/i18n.md
 */

/**
 * The shape of your own strings in the source language, for type-checked
 * keys. Empty by default: the platform's catalogue only.
 */
export type AppMessages = Record<never, never>;

export function initAppMessages(): void {
  // No app strings or languages by default.
}
