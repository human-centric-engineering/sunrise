/**
 * Which language a request is shown in (§138 t-1071).
 *
 * In order, the first that names a supported locale wins:
 *
 * 1. the signed-in user's own choice (`User.locale`);
 * 2. the default of the org they act in (`Org.settings.locale`);
 * 3. the visitor's choice, kept in a cookie (`LOCALE_COOKIE_NAME`);
 * 4. the browser's `Accept-Language`, in its own order of preference;
 * 5. {@link DEFAULT_LOCALE}.
 *
 * A stored value with no catalogue (a locale an app registered and then
 * removed) is skipped rather than trusted, so a stale choice degrades to the
 * next step instead of to a page with no strings.
 *
 * Pure: the request-bound half that reads the session, the org and the
 * headers is `lib/i18n/request.ts`.
 *
 * @see .context/ui/i18n.md
 */

import { DEFAULT_LOCALE, isLanguageTag, matchSupportedLocale } from '@/lib/i18n/locales';

/** Where a request's locale came from: logged, and asserted in tests. */
export type LocaleSource = 'user' | 'org' | 'cookie' | 'accept-language' | 'default';

export interface LocaleInputs {
  userLocale?: string | null;
  orgLocale?: string | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
}

export interface ResolvedLocale {
  locale: string;
  source: LocaleSource;
}

export function resolveLocale(inputs: LocaleInputs): ResolvedLocale {
  const steps: Array<[LocaleSource, readonly string[]]> = [
    ['user', inputs.userLocale ? [inputs.userLocale] : []],
    ['org', inputs.orgLocale ? [inputs.orgLocale] : []],
    ['cookie', inputs.cookieLocale ? [inputs.cookieLocale] : []],
    ['accept-language', parseAcceptLanguage(inputs.acceptLanguage)],
  ];
  for (const [source, requested] of steps) {
    const locale = matchSupportedLocale(requested);
    if (locale) return { locale, source };
  }
  return { locale: DEFAULT_LOCALE, source: 'default' };
}

/** More entries than any browser sends; a longer header is cut here. */
const MAX_ACCEPT_LANGUAGE_ENTRIES = 20;

/**
 * The language tags in an `Accept-Language` header, most preferred first.
 * Entries with `q=0` (refused) and malformed entries are dropped; `*` is
 * dropped too, since the fallback already covers "anything".
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  const entries: Array<{ tag: string; q: number; index: number }> = [];
  const parts = header.split(',').slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES);
  parts.forEach((part, index) => {
    const [rawTag, ...params] = part.trim().split(';');
    const tag = rawTag?.trim() ?? '';
    if (!isLanguageTag(tag)) return;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key?.trim() !== 'q') continue;
      const parsed = Number(value);
      q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
    }
    if (q > 0) entries.push({ tag, q, index });
  });
  // Stable by position for equal weights, as the header lists them.
  entries.sort((a, b) => b.q - a.q || a.index - b.index);
  return entries.map((e) => e.tag);
}
